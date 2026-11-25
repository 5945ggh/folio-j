"""Persistent translation lifecycle with transactional authorization and adoption."""

import asyncio
import json
from functools import partial
from typing import Any, cast

from fastapi import FastAPI, HTTPException
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.config import load_settings
from app.ids import new_ulid
from app.jobs.supervision import worker
from app.llm.adapters import CallSnapshot, generate_text
from app.llm.errors import describe_call_failure
from app.material_models import Material
from app.models import Segment
from app.resources import PROMPTS
from app.services.material_provenance import (
    identity_sha256,
    prepare_reference,
    recheck_reference,
)
from app.services.settings import read_credential, redact_credential
from app.services.sources import (
    begin_write,
    require_segment,
    require_source,
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
    TranslationCreate,
    TranslationDeleteImpact,
    TranslationHistoryResponse,
    TranslationRemovalResponse,
    TranslationResultResponse,
    TranslationSettingsResponse,
    TranslationSettingsUpdate,
    TranslationTaskResponse,
)

ACTIVE = ("queued", "running", "stopping")
PROMPT_VERSION = "translation-v3"
PROMPT_PATH = PROMPTS / "translation/system_v3.txt"
MAX_MATERIAL_TITLE_CHARACTERS = 300


def render_messages(
    *, text: str, before: str, after: str, language: str, source_title: str, material_title: str
) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": PROMPT_PATH.read_text(encoding="utf-8")},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "target_language": language,
                    "source_context": {
                        "source_title": source_title,
                        "material_title": material_title[:MAX_MATERIAL_TITLE_CHARACTERS],
                    },
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
        raise conflict("翻译设置已更新，请刷新后重试")
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
        raise conflict("翻译模型不可用，请在翻译设置中重新选择")
    return model, provider


async def visible_task(session: AsyncSession, task: TranslationTask) -> Material:
    await require_source(session, task.source_id)
    material = await session.scalar(
        select(Material)
        .options(defer(Material.compiled_bundle))
        .where(Material.id == task.material_id)
    )
    if material is None:
        raise HTTPException(404, "书籍不存在")
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


async def adopted_segments(
    session: AsyncSession, result_ids: list[str], source_id: str
) -> dict[str, list[str]]:
    rows = await session.execute(
        select(TranslationAdoption.result_id, Segment.id)
        .join(Segment, Segment.id == TranslationAdoption.segment_id)
        .where(
            TranslationAdoption.result_id.in_(result_ids),
            Segment.source_id == source_id,
            Segment.deleted_at.is_(None),
        )
        .distinct()
        .order_by(Segment.created_at, Segment.id)
    )
    adopted: dict[str, list[str]] = {}
    for result_id, segment_id in rows:
        adopted.setdefault(result_id, []).append(segment_id)
    return adopted


def result_response(
    result: TranslationResult,
    task: TranslationTask,
    material: Material,
    adopted_segment_ids: list[str],
) -> TranslationResultResponse:
    payload = json.loads(task.payload)
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
    task = await session.get(TranslationTask, result.task_id)
    assert task is not None
    material = await visible_task(session, task)
    adopted = await adopted_segments(session, [result_id], task.source_id)
    return result_response(result, task, material, adopted.get(result_id, []))


async def history(
    session: AsyncSession, material_id: str, offset: int, limit: int, identity: str | None
) -> TranslationHistoryResponse:
    material = await session.scalar(
        select(Material).options(defer(Material.compiled_bundle)).where(Material.id == material_id)
    )
    if material is None or material.deleted_at is not None:
        raise HTTPException(404, "书籍不存在")
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
    page = rows[:limit]
    result_ids = [task.result_id for task in page if task.result_id is not None]
    results: list[TranslationResultResponse] = []
    if result_ids:
        by_id = {
            row.id: row
            for row in await session.scalars(
                select(TranslationResult).where(TranslationResult.id.in_(result_ids))
            )
        }
        adopted = await adopted_segments(session, result_ids, material.source_id)
        for task in page:
            if task.result_id is None:
                continue
            result = by_id.get(task.result_id)
            if result is None or result.task_id != task.id or task.source_id != material.source_id:
                raise HTTPException(404, "译文不存在")
            results.append(result_response(result, task, material, adopted.get(result.id, [])))
    return TranslationHistoryResponse(
        results=results,
        tasks=[task_response(row) for row in page],
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
            raise HTTPException(404, "阅读器中的翻译记录已删除")
        await visible_task(session, old)
        if old.request_payload != serialized:
            raise conflict("翻译内容与上次提交不一致，请刷新后重试")
        return task_response(old)
    if (
        material_id != data.material_provenance.material_id
        or len(data.context_before) + len(data.context_after) > limits.max_context_characters
        or len(data.text) > limits.max_target_characters
    ):
        raise HTTPException(422, "书籍出处或前后文范围无效，请检查选区和前后文")
    await session.rollback()
    prepared = await prepare_reference(session, data.source_id, data.material_provenance)
    if data.text != prepared.text:
        raise HTTPException(422, "原文与书籍出处不符，请重新选择")
    await begin_write(session)
    old = await session.scalar(
        select(TranslationTask).where(TranslationTask.request_id == str(data.request_id))
    )
    if old:
        if old.reader_deleted_at is not None:
            raise HTTPException(404, "阅读器中的翻译记录已删除")
        if old.request_payload != serialized:
            raise conflict("翻译内容与上次提交不一致，请刷新后重试")
        await visible_task(session, old)
        await session.commit()
        return task_response(old)
    material = await recheck_reference(session, prepared)
    source = await require_source(session, prepared.source_id)
    count = await session.scalar(
        select(func.count()).select_from(TranslationTask).where(TranslationTask.status.in_(ACTIVE))
    )
    if (count or 0) >= limits.max_pending:
        raise HTTPException(429, "待处理的翻译任务已满，请稍后重试")
    settings = await get_settings(session)
    if settings.model_id is None:
        raise conflict("请先在翻译设置中选择模型")
    model, provider = await model_for(session, settings.model_id)
    messages = render_messages(
        language=settings.target_language,
        before=data.context_before,
        after=data.context_after,
        text=prepared.text,
        source_title=source.title,
        material_title=material.title,
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


async def remove_reader_history(
    session: AsyncSession, material_id: str, identity: str
) -> TranslationRemovalResponse:
    """Remove an exact reader target while preserving adopted snapshots and receipts."""
    await begin_write(session)
    material = await session.scalar(
        select(Material).options(defer(Material.compiled_bundle)).where(Material.id == material_id)
    )
    if material is None or material.deleted_at is not None:
        raise HTTPException(404, "书籍不存在")
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
            task.status, task.token, task.error = "cancelled", None, "阅读器中的翻译记录已删除"
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
        task.status, task.token, task.error = (
            "interrupted",
            None,
            "应用已重启，翻译已中断，请按需重试",
        )
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
                error = "模型未返回完整译文，请重试"
        except asyncio.CancelledError:
            interrupted = True
            error = "应用已停止，翻译已中断，请按需重试"
        except Exception as exc:
            error = describe_call_failure(exc, "翻译", payload["timeout_seconds"]).message
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
                error = "来源或书籍已删除"
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
        task.status, task.token, task.error = "failed", None, "翻译失败，请重试"
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
            raise conflict("还有翻译任务正在进行，完成或停止后才能删除模型服务或模型")


async def revoke_tasks(
    session: AsyncSession, *, source_id: str | None = None, material_id: str | None = None
) -> None:
    query = select(TranslationTask).where(TranslationTask.status.in_(ACTIVE))
    if source_id is not None:
        query = query.where(TranslationTask.source_id == source_id)
    if material_id is not None:
        query = query.where(TranslationTask.material_id == material_id)
    for task in (await session.scalars(query)).all():
        task.status, task.token, task.error = "cancelled", None, "来源或书籍已删除"
        if task.run_id:
            run = await session.get(Run, task.run_id)
            if run:
                run.status, run.finished_at = "cancelled", utc_now()


async def delete_impact(
    session: AsyncSession, material_id: str, *, excluded_segment_ids: list[str] | None = None
) -> TranslationDeleteImpact:
    material = await session.scalar(
        select(Material).options(defer(Material.compiled_bundle)).where(Material.id == material_id)
    )
    if material is None:
        raise HTTPException(404, "书籍不存在")
    await require_source(session, material.source_id)
    linked = func.count(Segment.id)
    surviving = (
        linked.filter(Segment.id.not_in(excluded_segment_ids)) if excluded_segment_ids else linked
    )
    rows = await session.execute(
        select(
            TranslationTask.status,
            TranslationTask.result_id,
            TranslationTask.reader_deleted_at,
            linked,
            surviving,
        )
        .outerjoin(TranslationAdoption, TranslationAdoption.result_id == TranslationTask.result_id)
        .outerjoin(
            Segment,
            and_(
                Segment.id == TranslationAdoption.segment_id,
                Segment.deleted_at.is_(None),
                Segment.source_id == TranslationTask.source_id,
            ),
        )
        .where(TranslationTask.material_id == material_id)
        .group_by(TranslationTask.id)
    )
    active = 0
    retained = 0
    hidden = 0
    for status, result_id, reader_deleted_at, linked_count, surviving_count in rows:
        active += int(status in ACTIVE)
        if result_id is None or (reader_deleted_at is not None and not linked_count):
            continue
        if surviving_count:
            retained += 1
        else:
            hidden += 1
    return TranslationDeleteImpact(
        material_id=material_id,
        hidden_result_count=hidden,
        retained_result_count=retained,
        active_task_count=active,
    )


async def cancel_revoked(application: FastAPI) -> None:
    tasks = worker(application, "translation").tasks
    async with application.state.session_factory() as session:
        for task_id in list(tasks):
            row = await session.get(TranslationTask, task_id)
            if row is None or row.status not in ACTIVE:
                cancel(application, task_id)
