"""Persistent translation lifecycle with transactional authorization and adoption."""

import asyncio
import json
import unicodedata
from functools import partial
from typing import Any, cast

from fastapi import FastAPI, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.config import REPO_ROOT, load_settings
from app.ids import new_ulid
from app.jobs.supervision import worker
from app.llm.adapters import CallSnapshot, generate_text
from app.llm.errors import describe_call_failure
from app.material_models import Material
from app.models import Segment, SegmentMaterialProvenance
from app.provenance_schemas import ASSEMBLY_RULE, MaterialProvenance
from app.services.material_provenance import (
    identity_payload,
    identity_sha256,
    prepare_reference,
    recheck_reference,
)
from app.services.settings import read_credential, redact_credential
from app.services.sources import (
    begin_write,
    lock_segment_text,
    require_segment,
    require_source,
    segment_response,
    segment_text_sha256,
    utc_now,
)
from app.settings_models import Provider, ProviderModel, Run
from app.translation_models import (
    TranslationAdoption,
    TranslationResult,
    TranslationSettings,
    TranslationTask,
)
from app.translation_schemas import (
    TranslationAdopt,
    TranslationAdoptionResponse,
    TranslationCreate,
    TranslationDeleteImpact,
    TranslationHistoryResponse,
    TranslationRemovalResponse,
    TranslationResultRemovalResponse,
    TranslationResultResponse,
    TranslationSettingsResponse,
    TranslationSettingsUpdate,
    TranslationTaskResponse,
)

ACTIVE = ("queued", "running", "stopping")
PROMPT_VERSION = "translation-v2"
PROMPT_PATH = REPO_ROOT / "backend/prompts/translation/system_v2.txt"


def render_messages(*, text: str, before: str, after: str, language: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": PROMPT_PATH.read_text(encoding="utf-8")},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "target_language": language,
                    "reference_context": {"before": before, "after": after},
                    "target": text,
                },
                ensure_ascii=False,
                indent=2,
            ),
        },
    ]


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def conflict(message: str) -> HTTPException:
    return HTTPException(409, message)


async def get_settings(session: AsyncSession) -> TranslationSettingsResponse:
    row = await session.scalar(select(TranslationSettings))
    defaults = TranslationSettingsUpdate(expected_revision=0).model_dump(
        exclude={"expected_revision"}
    )
    return TranslationSettingsResponse(
        id=row.id if row else "default-translation",
        revision=row.revision if row else 0,
        max_target_characters=load_settings().translation.max_target_characters,
        max_context_characters=load_settings().translation.max_context_characters,
        **(json.loads(row.payload) if row else defaults),
    )


async def put_settings(
    session: AsyncSession, data: TranslationSettingsUpdate
) -> TranslationSettingsResponse:
    await begin_write(session)
    current = await get_settings(session)
    if current.revision != data.expected_revision:
        raise conflict("翻译设置已改变，请刷新后重试")
    if data.model_id is not None:
        await model_for(session, data.model_id)
    row = await session.get(TranslationSettings, current.id)
    if row is None:
        row = TranslationSettings(id=current.id, revision=0, payload="")
        session.add(row)
    row.revision += 1
    row.payload = encode(data.model_dump(exclude={"expected_revision"}))
    await session.commit()
    return await get_settings(session)


async def model_for(session: AsyncSession, model_id: str) -> tuple[ProviderModel, Provider]:
    model = await session.get(ProviderModel, model_id)
    provider = await session.get(Provider, model.provider_id) if model else None
    if (
        model is None
        or not model.enabled
        or provider is None
        or not provider.enabled
        or provider.deleted_at is not None
    ):
        raise conflict("翻译模型不可用，请修复翻译设置")
    return model, provider


async def visible_task(session: AsyncSession, task: TranslationTask) -> Material:
    await require_source(session, task.source_id)
    material = await session.scalar(
        select(Material)
        .options(defer(Material.compiled_bundle))
        .where(Material.id == task.material_id)
    )
    if material is None:
        raise HTTPException(404, "材料不存在")
    if material.deleted_at is not None or task.reader_deleted_at is not None:
        linked = await session.scalar(
            select(TranslationAdoption.id)
            .join(Segment, Segment.id == TranslationAdoption.segment_id)
            .where(
                TranslationAdoption.result_id == task.result_id,
                Segment.deleted_at.is_(None),
                Segment.source_id == task.source_id,
            )
            .limit(1)
        )
        if linked is None:
            raise HTTPException(404, "翻译不存在")
    return material


def task_response(task: TranslationTask) -> TranslationTaskResponse:
    return TranslationTaskResponse(
        id=task.id,
        source_id=task.source_id,
        material_id=task.material_id,
        status=cast(Any, task.status),
        result_id=task.result_id,
        run_id=task.run_id,
        error=task.error,
        text=json.loads(task.payload)["text"],
        material_provenance=json.loads(task.payload)["material_provenance"],
        context_before=json.loads(task.payload)["context_before"],
        context_after=json.loads(task.payload)["context_after"],
        created_at=task.created_at,
    )


async def get_task(session: AsyncSession, task_id: str) -> TranslationTaskResponse:
    task = await session.get(TranslationTask, task_id)
    if task is None:
        raise HTTPException(404, "翻译任务不存在")
    await visible_task(session, task)
    return task_response(task)


async def result_response(
    session: AsyncSession, result: TranslationResult
) -> TranslationResultResponse:
    task = await session.get(TranslationTask, result.task_id)
    assert task is not None
    material = await visible_task(session, task)
    payload = json.loads(task.payload)
    adopted_segment_ids = list(
        (
            await session.scalars(
                select(Segment.id)
                .join(TranslationAdoption, TranslationAdoption.segment_id == Segment.id)
                .where(
                    TranslationAdoption.result_id == result.id,
                    Segment.source_id == task.source_id,
                    Segment.deleted_at.is_(None),
                )
                .distinct()
                .order_by(Segment.created_at, Segment.id)
            )
        ).all()
    )
    return TranslationResultResponse(
        id=result.id,
        task_id=task.id,
        adopted_segment_ids=adopted_segment_ids,
        source_id=task.source_id,
        material_id=task.material_id,
        material_deleted=material.deleted_at is not None,
        reader_deleted=task.reader_deleted_at is not None,
        material_provenance=payload["material_provenance"],
        identity_sha256=task.identity_sha256,
        chapter_id=payload["chapter_id"],
        parts=payload["parts"],
        text=payload["text"],
        translation=result.translation,
        context_before=payload["context_before"],
        context_after=payload["context_after"],
        target_language=payload["target_language"],
        scheme_name=payload["scheme_name"],
        scheme_id=payload["scheme_id"],
        scheme_revision=payload["scheme_revision"],
        prompt_version=payload.get("prompt_version", "translation-v1"),
        provider_name=payload["snapshot"]["provider_name"],
        protocol=payload["snapshot"]["protocol"],
        temperature=payload["snapshot"]["temperature"],
        max_output_tokens=payload["snapshot"]["max_output_tokens"],
        reasoning_effort=payload["snapshot"]["reasoning_effort"],
        model_id=payload["snapshot"]["model_id"],
        run_id=task.run_id or "",
        created_at=result.created_at,
    )


async def get_result(session: AsyncSession, result_id: str) -> TranslationResultResponse:
    result = await session.get(TranslationResult, result_id)
    if result is None:
        raise HTTPException(404, "译文不存在")
    return await result_response(session, result)


async def history(
    session: AsyncSession, material_id: str, offset: int, limit: int, identity: str | None
) -> TranslationHistoryResponse:
    material = await session.scalar(
        select(Material).options(defer(Material.compiled_bundle)).where(Material.id == material_id)
    )
    if material is None or material.deleted_at is not None:
        raise HTTPException(404, "材料不存在")
    await require_source(session, material.source_id)
    query = select(TranslationTask).where(
        TranslationTask.material_id == material_id, TranslationTask.reader_deleted_at.is_(None)
    )
    if identity is not None:
        query = query.where(TranslationTask.identity_sha256 == identity)
    rows = list(
        (
            await session.scalars(
                query.order_by(TranslationTask.created_at.desc(), TranslationTask.id.desc())
                .offset(offset)
                .limit(limit + 1)
            )
        ).all()
    )
    results: list[TranslationResultResponse] = []
    for task in rows[:limit]:
        if task.result_id:
            results.append(await get_result(session, task.result_id))
    return TranslationHistoryResponse(
        results=results,
        tasks=[task_response(row) for row in rows[:limit]],
        next_offset=offset + limit if len(rows) > limit else None,
    )


async def accept(
    session: AsyncSession, material_id: str, data: TranslationCreate
) -> TranslationTaskResponse:
    limits = load_settings().translation
    serialized = encode(dict(path_material_id=material_id, **data.model_dump(mode="json")))
    old = await session.scalar(
        select(TranslationTask).where(TranslationTask.request_id == str(data.request_id))
    )
    if old:
        if old.reader_deleted_at is not None:
            raise HTTPException(404, "翻译记录已从阅读器移除")
        await visible_task(session, old)
        if old.request_payload != serialized:
            raise conflict("相同请求身份不能提交不同内容")
        return task_response(old)
    if (
        material_id != data.material_provenance.material_id
        or len(data.context_before) + len(data.context_after) > limits.max_context_characters
        or len(data.text) > limits.max_target_characters
    ):
        raise HTTPException(422, "材料身份或语境预算无效")
    await session.rollback()
    prepared = await prepare_reference(session, data.source_id, data.material_provenance)
    if data.text != prepared.text:
        raise HTTPException(422, "目标原文与出处不一致")
    await begin_write(session)
    old = await session.scalar(
        select(TranslationTask).where(TranslationTask.request_id == str(data.request_id))
    )
    if old:
        if old.reader_deleted_at is not None:
            raise HTTPException(404, "翻译记录已从阅读器移除")
        if old.request_payload != serialized:
            raise conflict("相同请求身份不能提交不同内容")
        await visible_task(session, old)
        await session.commit()
        return task_response(old)
    await recheck_reference(session, prepared)
    count = await session.scalar(
        select(func.count()).select_from(TranslationTask).where(TranslationTask.status.in_(ACTIVE))
    )
    if (count or 0) >= limits.max_pending:
        raise HTTPException(429, "翻译队列已满")
    settings = await get_settings(session)
    if settings.model_id is None:
        raise conflict("请先选择翻译方案的模型")
    model, provider = await model_for(session, settings.model_id)
    messages = render_messages(
        language=settings.target_language,
        before=data.context_before,
        after=data.context_after,
        text=prepared.text,
    )
    snapshot = dict(
        provider_id=provider.id,
        provider_name=provider.name,
        provider_revision=provider.revision,
        provider_model_id=model.id,
        model_revision=model.revision,
        model_id=model.model_id,
        protocol=model.protocol_override or provider.protocol,
        base_url=provider.base_url,
        credential_ref=provider.credential_ref,
        temperature=model.temperature,
        max_output_tokens=model.max_output_tokens or limits.default_max_output_tokens,
        reasoning_effort=model.reasoning_effort,
    )
    payload = data.model_dump(mode="json") | dict(
        material_provenance=prepared.reference.model_dump(mode="json"),
        chapter_id=prepared.chapter_id,
        parts=[part.model_dump(mode="json") for part in prepared.parts],
        target_language=settings.target_language,
        scheme_name=settings.name,
        scheme_id=settings.id,
        scheme_revision=settings.revision,
        prompt_version=PROMPT_VERSION,
        timeout_seconds=limits.timeout_seconds,
        snapshot=snapshot,
        prompt="\n\n".join(message["content"] for message in messages),
        messages=messages,
    )
    task = TranslationTask(
        id=new_ulid(),
        request_id=str(data.request_id),
        request_payload=serialized,
        source_id=data.source_id,
        material_id=material_id,
        identity_sha256=identity_sha256(prepared.reference),
        payload=encode(payload),
        status="queued",
        created_at=utc_now(),
    )
    session.add(task)
    await session.commit()
    return task_response(task)


async def stop(session: AsyncSession, task_id: str) -> TranslationTaskResponse:
    await begin_write(session)
    task = await session.get(TranslationTask, task_id)
    if task is None:
        raise HTTPException(404, "翻译任务不存在")
    await visible_task(session, task)
    if task.status in ACTIVE:
        task.status, task.token = "cancelled", None
        if task.run_id:
            run = await session.get(Run, task.run_id)
            if run:
                run.status, run.finished_at = "cancelled", utc_now()
    await session.commit()
    return task_response(task)


async def remove_reader_result(
    session: AsyncSession, result_id: str
) -> TranslationResultRemovalResponse:
    """Hide one successful version without changing other tasks or adopted snapshots."""
    await begin_write(session)
    result = await session.get(TranslationResult, result_id)
    if result is None:
        raise HTTPException(404, "译文不存在")
    task = await session.get(TranslationTask, result.task_id)
    assert task is not None
    material = await session.scalar(
        select(Material)
        .options(defer(Material.compiled_bundle))
        .where(Material.id == task.material_id)
    )
    if material is None or material.deleted_at is not None:
        raise HTTPException(404, "材料不存在")
    await require_source(session, task.source_id)
    if task.reader_deleted_at is None:
        task.reader_deleted_at = utc_now()
    await session.flush()
    remaining = (
        select(TranslationResult)
        .join(TranslationTask, TranslationTask.id == TranslationResult.task_id)
        .where(
            TranslationTask.material_id == task.material_id,
            TranslationTask.identity_sha256 == task.identity_sha256,
            TranslationTask.reader_deleted_at.is_(None),
            TranslationTask.status == "succeeded",
            TranslationTask.result_id == TranslationResult.id,
        )
    )
    count = await session.scalar(select(func.count()).select_from(remaining.subquery()))
    latest = await session.scalar(
        remaining.order_by(TranslationResult.created_at.desc(), TranslationResult.id.desc()).limit(
            1
        )
    )
    response = TranslationResultRemovalResponse(
        identity_sha256=task.identity_sha256,
        task_ids=[task.id],
        result_ids=[result.id],
        cancelled_task_ids=[],
        remaining_result=await result_response(session, latest) if latest is not None else None,
        remaining_result_count=count or 0,
    )
    await session.commit()
    return response


async def remove_reader_history(
    session: AsyncSession, material_id: str, identity: str
) -> TranslationRemovalResponse:
    """Remove an exact reader target while preserving adopted snapshots and receipts."""
    await begin_write(session)
    material = await session.scalar(
        select(Material).options(defer(Material.compiled_bundle)).where(Material.id == material_id)
    )
    if material is None or material.deleted_at is not None:
        raise HTTPException(404, "材料不存在")
    await require_source(session, material.source_id)
    tasks = list(
        (
            await session.scalars(
                select(TranslationTask)
                .where(
                    TranslationTask.material_id == material_id,
                    TranslationTask.identity_sha256 == identity,
                )
                .order_by(TranslationTask.created_at, TranslationTask.id)
            )
        ).all()
    )
    removed_at = utc_now()
    for task in tasks:
        if task.reader_deleted_at is None:
            task.reader_deleted_at = removed_at
        if task.status in ACTIVE:
            task.status, task.token, task.error = "cancelled", None, "翻译记录已从阅读器移除"
            if task.run_id:
                run = await session.get(Run, task.run_id)
                if run is not None:
                    run.status, run.finished_at = "cancelled", removed_at
    response = TranslationRemovalResponse(
        identity_sha256=identity,
        task_ids=[task.id for task in tasks],
        result_ids=[task.result_id for task in tasks if task.result_id is not None],
        cancelled_task_ids=[task.id for task in tasks if task.status == "cancelled"],
    )
    await session.commit()
    return response


async def adopt(
    session: AsyncSession, result_id: str, data: TranslationAdopt
) -> TranslationAdoptionResponse:
    request_payload = encode(
        dict(result_id=result_id, **data.model_dump(mode="json", exclude_unset=True))
    )
    # Replay is resolved before validating mutable material assets or revision.
    old = await session.scalar(
        select(TranslationAdoption).where(TranslationAdoption.request_id == str(data.request_id))
    )
    if old:
        await get_result(session, old.result_id)
        segment = await require_segment(session, old.segment_id)
        if old.request_payload != request_payload:
            raise conflict("相同采用请求不能提交不同内容")
        return TranslationAdoptionResponse(
            id=old.id, result_id=old.result_id, segment=segment_response(segment)
        )
    result = await get_result(session, result_id)
    if result.reader_deleted:
        raise HTTPException(404, "翻译记录已从阅读器移除，不能建立新采用关系")
    await session.rollback()
    prepared = await prepare_reference(session, result.source_id, result.material_provenance)
    await begin_write(session)
    old = await session.scalar(
        select(TranslationAdoption).where(TranslationAdoption.request_id == str(data.request_id))
    )
    if old:
        await session.rollback()
        return await adopt(session, result_id, data)
    await recheck_reference(session, prepared)
    result = await get_result(session, result_id)
    if prepared.text != result.text:
        raise conflict("译文目标与材料不一致")
    if result.material_deleted or result.reader_deleted:
        raise HTTPException(404, "材料或翻译记录已删除，不能建立新采用关系")
    fields = {
        key: unicodedata.normalize("NFC", value)
        for key, value in data.model_dump(
            include={"translation", "context_before", "context_after"}, exclude_unset=True
        ).items()
    }
    if data.segment_id:
        segment = await require_segment(session, data.segment_id)
        origin = segment.material_provenance
        if (
            segment.source_id != result.source_id
            or segment.text != result.text
            or origin is None
            or identity_payload(MaterialProvenance.model_validate_json(origin.payload))
            != identity_payload(result.material_provenance)
        ):
            raise conflict("片段与译文出处不一致")
        if fields:
            if (
                data.expected_revision != segment.revision
                or data.text_sha256 != segment_text_sha256(segment.text)
            ):
                raise conflict("片段已改变，请核对当前内容")
            if any(getattr(segment, key) != value for key, value in fields.items()):
                for key, value in fields.items():
                    setattr(segment, key, value)
                segment.revision += 1
                segment.updated_at = utc_now()
    else:
        now = utc_now()
        segment = Segment(
            id=new_ulid(),
            source_id=result.source_id,
            text=result.text,
            translation=fields.get("translation", result.translation),
            context_before=fields.get("context_before", result.context_before),
            context_after=fields.get("context_after", result.context_after),
            note=data.note,
            transcription="",
            source_ref="",
            revision=1,
            created_at=now,
            updated_at=now,
        )
        lock_segment_text(segment, now)
        segment.material_provenance = SegmentMaterialProvenance(
            source_id=result.source_id,
            material_id=result.material_id,
            version_id=result.material_provenance.version_id,
            payload=result.material_provenance.model_dump_json(),
            identity_sha256=result.identity_sha256,
            request_id=str(data.request_id),
            request_payload=request_payload,
            assembly_rule=ASSEMBLY_RULE,
            created_at=now,
        )
        session.add(segment)
    receipt = TranslationAdoption(
        id=new_ulid(),
        request_id=str(data.request_id),
        request_payload=request_payload,
        result_id=result_id,
        segment_id=segment.id,
        created_at=utc_now(),
        adopted_payload=encode(
            dict(
                action="create" if data.segment_id is None else "update" if fields else "link",
                fields=fields
                if data.segment_id
                else dict(
                    translation=segment.translation,
                    context_before=segment.context_before,
                    context_after=segment.context_after,
                ),
                text_sha256=segment_text_sha256(segment.text),
            )
        ),
    )
    session.add(receipt)
    await session.flush()
    response = TranslationAdoptionResponse(
        id=receipt.id, result_id=result_id, segment=segment_response(segment)
    )
    await session.commit()
    return response


async def segment_results(
    session: AsyncSession, segment_id: str
) -> list[TranslationResultResponse]:
    await require_segment(session, segment_id)
    ids = (
        await session.scalars(
            select(TranslationAdoption.result_id)
            .where(TranslationAdoption.segment_id == segment_id)
            .distinct()
        )
    ).all()
    return [await get_result(session, result_id) for result_id in ids]


async def recover(session: AsyncSession) -> None:
    rows = (
        await session.scalars(select(TranslationTask).where(TranslationTask.status.in_(ACTIVE)))
    ).all()
    for task in rows:
        task.status, task.token, task.error = "interrupted", None, "进程重启，未自动重新调用"
        if task.run_id:
            run = await session.get(Run, task.run_id)
            if run:
                run.status, run.finished_at = "interrupted", utc_now()
    await session.commit()


def wake(application: FastAPI) -> None:
    worker(application, "translation").wake()


def cancel(application: FastAPI, task_id: str) -> None:
    worker(application, "translation").cancel(task_id)


async def execute(application: FastAPI, task_id: str) -> None:
    async with application.state.translation_semaphore:
        await _execute(application, task_id)


async def _execute(application: FastAPI, task_id: str) -> None:
    async with application.state.verification_semaphore:
        async with application.state.session_factory() as session:
            await begin_write(session)
            task = await session.get(TranslationTask, task_id)
            if task is None or task.status != "queued":
                return
            try:
                await visible_task(session, task)
            except HTTPException:
                task.status = "cancelled"
                await session.commit()
                return
            payload = json.loads(task.payload)
            token = new_ulid()
            task.status, task.token = "running", token
            run = Run(
                id=new_ulid(),
                purpose="translation",
                job_id=None,
                stream=False,
                status="running",
                output_text="",
                prompt_version=payload.get("prompt_version", "translation-v1"),
                prompt_text=payload["prompt"],
                messages=payload.get("messages"),
                created_at=utc_now(),
                started_at=utc_now(),
                **payload["snapshot"],
            )
            session.add(run)
            task.run_id = run.id
            await session.commit()
            run_id = run.id
            snapshot = CallSnapshot(
                base_url=run.base_url,
                model_id=run.model_id,
                protocol=cast(Any, run.protocol),
                stream=False,
                prompt=run.prompt_text,
                messages=run.messages,
                temperature=run.temperature,
                max_output_tokens=run.max_output_tokens,
                reasoning_effort=cast(Any, run.reasoning_effort),
                timeout_seconds=payload["timeout_seconds"],
            )
            credential_ref = run.credential_ref

        async def progress(_text: str) -> None:
            return None

        output = None
        key: str | None = None
        error = None
        interrupted = False
        try:
            async with application.state.session_factory() as session:
                current = await session.get(TranslationTask, task_id)
                if current is None or current.token != token or current.status != "running":
                    return
                await visible_task(session, current)
            key = read_credential(application.state.database_path, credential_ref)
            async with asyncio.timeout(payload["timeout_seconds"]):
                output = await generate_text(snapshot, key, progress)
            if not output.completed or not output.text.strip():
                error = "模型返回不完整或空译文"
        except asyncio.CancelledError:
            interrupted = True
            error = "进程停止，未自动重新调用"
        except Exception as exc:
            error = describe_call_failure(exc, "阅读翻译", payload["timeout_seconds"]).message
        async with application.state.session_factory() as session:
            await begin_write(session)
            task = await session.get(TranslationTask, task_id)
            run = await session.get(Run, run_id)
            assert task is not None and run is not None
            if task.token != token or task.status != "running":
                return
            try:
                await visible_task(session, task)
                if output is not None:
                    run.output_text = redact_credential(output.text, key) or ""
                    run.usage = output.usage
                    run.raw_response = redact_credential(output.raw_response, key)
            except HTTPException:
                error = "来源或材料已删除"
            run.finished_at = utc_now()
            task.token = None
            if error:
                terminal = "interrupted" if interrupted else "failed"
                task.status, task.error, run.status, run.error = terminal, error, terminal, error
            else:
                assert output is not None
                result = TranslationResult(
                    id=new_ulid(),
                    task_id=task.id,
                    translation=run.output_text,
                    created_at=utc_now(),
                )
                session.add(result)
                task.result_id, task.status = result.id, "succeeded"
                run.status = "succeeded"
            await session.commit()


async def fail_task(application: FastAPI, task_id: str) -> None:
    async with application.state.session_factory() as session:
        await begin_write(session)
        task = await session.get(TranslationTask, task_id)
        if task is None or task.status not in ACTIVE:
            return
        task.status, task.token, task.error = "failed", None, "后台翻译异常，未自动重新调用"
        if task.run_id:
            run = await session.get(Run, task.run_id)
            if run is not None and run.status in ("queued", "running"):
                run.status, run.error, run.finished_at = "failed", task.error, utc_now()
        await session.commit()


async def _scan(application: FastAPI) -> None:
    async with application.state.session_factory() as session:
        row = await session.scalar(
            select(TranslationTask.id)
            .where(TranslationTask.status == "queued")
            .order_by(TranslationTask.created_at)
            .limit(1)
        )
    if row:
        task = worker(application, "translation").submit(
            row,
            partial(execute, application, row),
            partial(fail_task, application, row),
        )
        # User cancellation ends this task, not the translation supervisor.
        await asyncio.gather(task, return_exceptions=True)
        # Drain an existing queue immediately; the interval is for idle polling.
        worker(application, "translation").wake()


def start_worker(application: FastAPI) -> asyncio.Task[None]:
    return worker(application, "translation").start(partial(_scan, application), interval=1)


async def assert_no_active(
    session: AsyncSession, *, provider_id: str | None = None, model_id: str | None = None
) -> None:
    rows = (
        await session.scalars(select(TranslationTask).where(TranslationTask.status.in_(ACTIVE)))
    ).all()
    for task in rows:
        snapshot = json.loads(task.payload)["snapshot"]
        if (provider_id is not None and snapshot["provider_id"] == provider_id) or (
            model_id is not None and snapshot["provider_model_id"] == model_id
        ):
            raise conflict("仍有活动翻译任务，不能删除接入或模型")


async def revoke_tasks(
    session: AsyncSession, *, source_id: str | None = None, material_id: str | None = None
) -> None:
    query = select(TranslationTask).where(TranslationTask.status.in_(ACTIVE))
    if source_id is not None:
        query = query.where(TranslationTask.source_id == source_id)
    if material_id is not None:
        query = query.where(TranslationTask.material_id == material_id)
    for task in (await session.scalars(query)).all():
        task.status, task.token, task.error = "cancelled", None, "来源或材料已删除"
        if task.run_id:
            run = await session.get(Run, task.run_id)
            if run:
                run.status, run.finished_at = "cancelled", utc_now()


async def delete_impact(session: AsyncSession, material_id: str) -> TranslationDeleteImpact:
    material = await session.scalar(
        select(Material).options(defer(Material.compiled_bundle)).where(Material.id == material_id)
    )
    if material is None or material.deleted_at is not None:
        raise HTTPException(404, "材料不存在")
    await require_source(session, material.source_id)
    rows = (
        await session.scalars(
            select(TranslationTask).where(TranslationTask.material_id == material_id)
        )
    ).all()
    retained = 0
    total = 0
    for task in rows:
        if task.result_id is None:
            continue
        linked = await session.scalar(
            select(TranslationAdoption.id)
            .join(Segment, Segment.id == TranslationAdoption.segment_id)
            .where(
                TranslationAdoption.result_id == task.result_id,
                Segment.deleted_at.is_(None),
                Segment.source_id == task.source_id,
            )
            .limit(1)
        )
        if linked is None and task.reader_deleted_at is not None:
            continue
        total += 1
        retained += int(linked is not None)
    return TranslationDeleteImpact(
        material_id=material_id,
        hidden_result_count=total - retained,
        retained_result_count=retained,
        active_task_count=sum(row.status in ACTIVE for row in rows),
    )


async def cancel_revoked(application: FastAPI) -> None:
    tasks = worker(application, "translation").tasks
    async with application.state.session_factory() as session:
        for task_id in list(tasks):
            row = await session.get(TranslationTask, task_id)
            if row is None or row.status not in ACTIVE:
                cancel(application, task_id)
