"""Learner settings, provider registry and durable verification lifecycle."""

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import quote

from fastapi import HTTPException
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from openai import APIConnectionError, APIStatusError, APITimeoutError
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.ids import new_ulid
from app.settings_models import Defaults, Profile, Provider, ProviderModel, Run, Style
from app.settings_schemas import (
    DefaultsInput,
    DefaultsResponse,
    ModelInput,
    ModelPatch,
    ModelResponse,
    ProfileInput,
    ProfileResponse,
    ProviderInput,
    ProviderPatch,
    ProviderResponse,
    RunResponse,
    SettingsResponse,
    StyleInput,
    StyleResponse,
    UsageResponse,
    VerificationInput,
    VerificationSummary,
)

if TYPE_CHECKING:
    from fastapi import FastAPI

PROMPTS = Path(__file__).resolve().parents[3] / "prompts"

VERIFICATION_VERSION = "v1"
DEFAULT_STYLE_ID = "00000000000000000000000001"


def now() -> datetime:
    return datetime.now(UTC)


def utc_datetime(value: datetime) -> datetime:
    """SQLite returns naive datetimes even for UTC timestamps stored with timezone=True."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def fail(status: int, detail: str) -> None:
    raise HTTPException(status_code=status, detail=detail)


async def ensure_settings(session: AsyncSession) -> tuple[Profile, list[Style], Defaults]:
    # The first write serializes concurrent first requests; OR IGNORE makes the
    # singleton initialization safe when several browser queries arrive together.
    await session.execute(
        insert(Profile)
        .values(id=1, native_language="中文", explain_language="中文", level_note="")
        .prefix_with("OR IGNORE")
    )
    defaults = await session.get(Defaults, 1)
    if defaults is None:
        body = (
            Environment(loader=FileSystemLoader(PROMPTS), undefined=StrictUndefined)
            .get_template("default_explanation_style_v1.j2")
            .render()
            .strip()
        )
        created = now()
        await session.execute(
            insert(Style)
            .values(
                id=DEFAULT_STYLE_ID,
                name="默认讲解",
                body_md=body,
                created_at=created,
                updated_at=created,
            )
            .prefix_with("OR IGNORE")
        )
        await session.execute(
            insert(Defaults)
            .values(
                id=1,
                analysis_model_id=None,
                chat_model_id=None,
                extraction_model_id=None,
                style_id=DEFAULT_STYLE_ID,
                permission_mode="review",
            )
            .prefix_with("OR IGNORE")
        )
    await session.commit()
    profile = await session.get(Profile, 1)
    defaults = await session.get(Defaults, 1)
    assert profile is not None and defaults is not None
    styles = list((await session.scalars(select(Style).order_by(Style.created_at))).all())
    return profile, styles, defaults


def style_response(style: Style) -> StyleResponse:
    return StyleResponse(
        id=style.id,
        name=style.name,
        body_md=style.body_md,
        created_at=style.created_at,
        updated_at=style.updated_at,
    )


def defaults_response(value: Defaults) -> DefaultsResponse:
    return DefaultsResponse(
        analysis_model_id=value.analysis_model_id,
        chat_model_id=value.chat_model_id,
        extraction_model_id=value.extraction_model_id,
        style_id=value.style_id,
        permission_mode=cast(Any, value.permission_mode),
    )


async def get_settings(session: AsyncSession) -> SettingsResponse:
    profile, styles, defaults = await ensure_settings(session)
    return SettingsResponse(
        profile=ProfileResponse(
            native_language=profile.native_language,
            explain_language=profile.explain_language,
            level_note=profile.level_note,
        ),
        styles=[style_response(x) for x in styles],
        defaults=defaults_response(defaults),
    )


async def put_profile(session: AsyncSession, data: ProfileInput) -> ProfileResponse:
    profile, _, _ = await ensure_settings(session)
    profile.native_language = data.native_language
    profile.explain_language = data.explain_language
    profile.level_note = data.level_note
    await session.commit()
    return ProfileResponse(**data.model_dump())


async def create_style(session: AsyncSession, data: StyleInput) -> StyleResponse:
    await ensure_settings(session)
    row = Style(id=new_ulid(), **data.model_dump(), created_at=now(), updated_at=now())
    session.add(row)
    await session.commit()
    return style_response(row)


async def put_style(session: AsyncSession, style_id: str, data: StyleInput) -> StyleResponse:
    row = await session.get(Style, style_id)
    if row is None:
        fail(404, "讲解预设不存在")
    assert row is not None
    row.name, row.body_md, row.updated_at = data.name, data.body_md, now()
    await session.commit()
    return style_response(row)


async def delete_style(session: AsyncSession, style_id: str) -> None:
    _, _, defaults = await ensure_settings(session)
    row = await session.get(Style, style_id)
    if row is None:
        fail(404, "讲解预设不存在")
    if defaults.style_id == style_id:
        fail(409, "当前默认讲解预设不能删除")
    assert row is not None
    await session.delete(row)
    await session.commit()


async def put_defaults(session: AsyncSession, data: DefaultsInput) -> DefaultsResponse:
    _, _, defaults = await ensure_settings(session)
    if data.style_id is not None and await session.get(Style, data.style_id) is None:
        fail(422, "讲解预设不存在")
    for model_id in (data.analysis_model_id, data.chat_model_id, data.extraction_model_id):
        if model_id is None:
            continue
        model = await session.get(ProviderModel, model_id)
        provider = await session.get(Provider, model.provider_id) if model else None
        if (
            model is None
            or not model.enabled
            or provider is None
            or provider.deleted_at
            or not provider.enabled
        ):
            fail(422, "默认模型不可用")
    for key, value in data.model_dump().items():
        setattr(defaults, key, value)
    await session.commit()
    return defaults_response(defaults)


def credential_dir(database_path: Path) -> Path:
    return database_path.with_name(database_path.name + ".secrets")


def save_credential(database_path: Path, value: str) -> str:
    directory = credential_dir(database_path)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    reference = new_ulid()
    path = directory / reference
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(value.strip())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return reference


def read_credential(database_path: Path, reference: str | None) -> str | None:
    if reference is None:
        return None
    return (credential_dir(database_path) / reference).read_text(encoding="utf-8")


def redact_credential(value: str | None, key: str | None) -> str | None:
    """Remove common literal encodings before any remote text reaches durable storage."""
    if value is None or not key:
        return value
    variants = {
        key,
        json.dumps(key, ensure_ascii=False)[1:-1],
        json.dumps(key, ensure_ascii=True)[1:-1],
        quote(key, safe=""),
    }
    for variant in variants:
        if variant:
            value = value.replace(variant, "[已隐藏凭据]")
    return value


def safe_verification_error(error: Exception) -> str:
    """Preserve a useful error category without persisting SDK exception payloads."""
    if isinstance(error, (TimeoutError, APITimeoutError)):
        return "模型验证超时（60 秒）"
    if isinstance(error, APIConnectionError):
        return "模型服务连接失败"
    if isinstance(error, APIStatusError):
        return f"模型服务返回 HTTP {error.status_code}"
    if isinstance(error, ValueError):
        return "模型未返回完整的可见文本"
    return "模型验证失败，请检查地址、凭据和模型参数"


def verification_summary(run: Run | None) -> VerificationSummary | None:
    if run is None:
        return None
    return VerificationSummary(
        id=run.id,
        status=cast(Any, run.status),
        created_at=utc_datetime(run.created_at),
        finished_at=utc_datetime(run.finished_at) if run.finished_at is not None else None,
        error=run.error,
    )


async def latest_verifications(
    session: AsyncSession, provider: Provider, models: list[ProviderModel]
) -> dict[tuple[str, bool], Run]:
    if not models:
        return {}
    ranked = (
        select(
            Run.id.label("run_id"),
            func.row_number()
            .over(
                partition_by=(Run.provider_model_id, Run.stream),
                order_by=(Run.created_at.desc(), Run.id.desc()),
            )
            .label("position"),
        )
        .join(ProviderModel, ProviderModel.id == Run.provider_model_id)
        .where(
            Run.provider_id == provider.id,
            Run.provider_revision == provider.revision,
            Run.model_revision == ProviderModel.revision,
            ProviderModel.id.in_([model.id for model in models]),
        )
        .subquery()
    )
    rows = (
        await session.scalars(
            select(Run).join(ranked, Run.id == ranked.c.run_id).where(ranked.c.position == 1)
        )
    ).all()
    return {(row.provider_model_id, row.stream): row for row in rows}


def model_response(
    model: ProviderModel, provider: Provider, summaries: dict[tuple[str, bool], Run]
) -> ModelResponse:
    return ModelResponse(
        id=model.id,
        provider_id=model.provider_id,
        model_id=model.model_id,
        protocol_override=cast(Any, model.protocol_override),
        effective_protocol=cast(Any, model.protocol_override or provider.protocol),
        enabled=model.enabled,
        temperature=model.temperature,
        max_output_tokens=model.max_output_tokens,
        reasoning_effort=cast(Any, model.reasoning_effort),
        revision=model.revision,
        text_status=cast(Any, model.text_status),
        stream_status=cast(Any, model.stream_status),
        text_verification=verification_summary(summaries.get((model.id, False))),
        stream_verification=verification_summary(summaries.get((model.id, True))),
    )


async def provider_response(session: AsyncSession, provider: Provider) -> ProviderResponse:
    models = list(
        (
            await session.scalars(
                select(ProviderModel).where(ProviderModel.provider_id == provider.id)
            )
        ).all()
    )
    summaries = await latest_verifications(session, provider, models)
    return ProviderResponse(
        id=provider.id,
        name=provider.name,
        base_url=provider.base_url,
        protocol=cast(Any, provider.protocol),
        enabled=provider.enabled,
        has_api_key=provider.credential_ref is not None,
        models=[model_response(x, provider, summaries) for x in models],
        discovered_models=provider.discovered_models,
        discovery_status=cast(Any, provider.discovery_status),
        discovery_error=provider.discovery_error,
        last_discovered_at=(
            utc_datetime(provider.last_discovered_at)
            if provider.last_discovered_at is not None
            else None
        ),
        revision=provider.revision,
        created_at=utc_datetime(provider.created_at),
        updated_at=utc_datetime(provider.updated_at),
    )


async def get_provider(session: AsyncSession, provider_id: str) -> Provider:
    provider = await session.get(Provider, provider_id)
    if provider is None or provider.deleted_at is not None:
        fail(404, "Provider 不存在")
    assert provider is not None
    return provider


async def list_providers(session: AsyncSession) -> list[ProviderResponse]:
    rows = (
        await session.scalars(
            select(Provider).where(Provider.deleted_at.is_(None)).order_by(Provider.created_at)
        )
    ).all()
    return [await provider_response(session, row) for row in rows]


async def create_provider(
    session: AsyncSession, database_path: Path, data: ProviderInput
) -> ProviderResponse:
    key = data.api_key.strip() if data.api_key else ""
    row = Provider(
        id=new_ulid(),
        name=data.name,
        base_url=data.base_url,
        protocol=data.protocol,
        enabled=data.enabled,
        credential_ref=save_credential(database_path, key) if key else None,
        discovered_models=[],
        discovery_status="never",
        discovery_error=None,
        last_discovered_at=None,
        revision=1,
        created_at=now(),
        updated_at=now(),
        deleted_at=None,
    )
    session.add(row)
    await session.commit()
    if row.enabled:
        return await refresh_models(session, database_path, row.id)
    return await provider_response(session, row)


async def patch_provider(
    session: AsyncSession, database_path: Path, provider_id: str, data: ProviderPatch
) -> ProviderResponse:
    row = await get_provider(session, provider_id)
    changed = data.model_fields_set
    connection_changed = any(
        key in changed and getattr(row, key) != getattr(data, key)
        for key in ("base_url", "protocol")
    )
    for key in ("name", "base_url", "protocol", "enabled"):
        if key in changed:
            setattr(row, key, getattr(data, key))
    if "api_key" in changed:
        if data.api_key.strip():
            row.credential_ref = save_credential(database_path, data.api_key)
            connection_changed = True
        elif row.credential_ref is not None:
            row.credential_ref = None
            connection_changed = True
    if connection_changed:
        row.revision += 1
        for model in (
            await session.scalars(select(ProviderModel).where(ProviderModel.provider_id == row.id))
        ).all():
            model.text_status = model.stream_status = "unknown"
    row.updated_at = now()
    await session.commit()
    return await provider_response(session, row)


async def delete_provider(session: AsyncSession, provider_id: str) -> None:
    row = await get_provider(session, provider_id)
    active = await session.scalar(
        select(Run.id)
        .where(Run.provider_id == row.id, Run.status.in_(["queued", "running"]))
        .limit(1)
    )
    if active:
        fail(409, "存在未完成的模型验证")
    row.deleted_at = now()
    row.enabled = False
    await session.commit()


async def create_model(session: AsyncSession, provider_id: str, data: ModelInput) -> ModelResponse:
    provider = await get_provider(session, provider_id)
    existing = await session.scalar(
        select(ProviderModel).where(
            ProviderModel.provider_id == provider_id, ProviderModel.model_id == data.model_id
        )
    )
    if existing:
        fail(409, "模型 ID 已登记")
    row = ProviderModel(
        id=new_ulid(),
        provider_id=provider_id,
        **data.model_dump(),
        revision=1,
        text_status="unknown",
        stream_status="unknown",
    )
    session.add(row)
    await session.commit()
    return model_response(row, provider, {})


async def patch_model(session: AsyncSession, model_id: str, data: ModelPatch) -> ModelResponse:
    row = await session.get(ProviderModel, model_id)
    if row is None:
        fail(404, "模型不存在")
    assert row is not None
    provider = await get_provider(session, row.provider_id)
    changed = data.model_fields_set
    parameters_changed = any(
        key in changed and getattr(row, key) != getattr(data, key)
        for key in ("protocol_override", "temperature", "max_output_tokens", "reasoning_effort")
    )
    for key in changed:
        setattr(row, key, getattr(data, key))
    if parameters_changed:
        row.revision += 1
        row.text_status = row.stream_status = "unknown"
    await session.commit()
    summaries = await latest_verifications(session, provider, [row])
    return model_response(row, provider, summaries)


async def refresh_models(
    session: AsyncSession, database_path: Path, provider_id: str
) -> ProviderResponse:
    from app.llm import adapters

    row = await get_provider(session, provider_id)
    try:
        names = await adapters.discover_models(
            row.base_url, read_credential(database_path, row.credential_ref)
        )
        row.discovered_models = names
        row.discovery_status = "succeeded"
        row.discovery_error = None
    except Exception:
        row.discovery_status = "failed"
        row.discovery_error = "模型列表获取失败，请检查地址、网络或凭据"
    row.last_discovered_at = now()
    await session.commit()
    return await provider_response(session, row)


def run_response(row: Run) -> RunResponse:
    return RunResponse(
        id=row.id,
        provider_id=row.provider_id,
        provider_name=row.provider_name,
        model_id=row.model_id,
        protocol=cast(Any, row.protocol),
        stream=row.stream,
        status=cast(Any, row.status),
        output_text=row.output_text,
        error=row.error,
        usage=UsageResponse.model_validate(row.usage) if row.usage is not None else None,
        prompt_version=row.prompt_version,
        created_at=utc_datetime(row.created_at),
        started_at=utc_datetime(row.started_at) if row.started_at is not None else None,
        finished_at=utc_datetime(row.finished_at) if row.finished_at is not None else None,
    )


async def list_runs(
    session: AsyncSession, *, limit: int = 50, offset: int = 0
) -> list[RunResponse]:
    rows = (
        await session.scalars(
            select(Run).order_by(Run.created_at.desc(), Run.id.desc()).offset(offset).limit(limit)
        )
    ).all()
    return [run_response(x) for x in rows]


async def get_run(session: AsyncSession, run_id: str) -> RunResponse:
    row = await session.get(Run, run_id)
    if row is None:
        fail(404, "Run 不存在")
    assert row is not None
    return run_response(row)


async def accept_verification(
    session: AsyncSession, model_id: str, data: VerificationInput
) -> RunResponse:
    model = await session.get(ProviderModel, model_id)
    if model is None:
        fail(404, "模型不存在")
    assert model is not None
    provider = await get_provider(session, model.provider_id)
    if not model.enabled or not provider.enabled:
        fail(409, "模型或 Provider 已停用")
    prompt = (
        Environment(loader=FileSystemLoader(PROMPTS), undefined=StrictUndefined)
        .get_template("model_verification_v1.j2")
        .render()
        .strip()
    )
    row = Run(
        id=new_ulid(),
        provider_id=provider.id,
        provider_name=provider.name,
        provider_revision=provider.revision,
        provider_model_id=model.id,
        model_revision=model.revision,
        model_id=model.model_id,
        protocol=model.protocol_override or provider.protocol,
        stream=data.stream,
        status="queued",
        output_text="",
        error=None,
        usage=None,
        prompt_version=VERIFICATION_VERSION,
        prompt_text=prompt,
        base_url=provider.base_url,
        credential_ref=provider.credential_ref,
        temperature=model.temperature,
        max_output_tokens=model.max_output_tokens,
        reasoning_effort=model.reasoning_effort,
        raw_response=None,
        created_at=now(),
        started_at=None,
        finished_at=None,
    )
    session.add(row)
    await session.commit()
    return run_response(row)


async def interrupt_unfinished(session: AsyncSession) -> None:
    await session.execute(
        update(Run)
        .where(Run.status.in_(["queued", "running"]))
        .values(status="interrupted", error="应用重启，验证已中断", finished_at=now())
    )
    await session.commit()


async def is_latest_verification(session: AsyncSession, row: Run) -> bool:
    latest_id = await session.scalar(
        select(Run.id)
        .where(
            Run.provider_id == row.provider_id,
            Run.provider_revision == row.provider_revision,
            Run.provider_model_id == row.provider_model_id,
            Run.model_revision == row.model_revision,
            Run.stream == row.stream,
        )
        .order_by(Run.created_at.desc(), Run.id.desc())
        .limit(1)
    )
    return latest_id == row.id


async def execute_verification(application: "FastAPI", run_id: str) -> None:
    from app.llm import adapters

    async with application.state.verification_semaphore:
        factory = application.state.session_factory
        async with factory() as session:
            row = await session.get(Run, run_id)
            if row is None or row.status != "queued":
                return
            row.status = "running"
            row.started_at = now()
            await session.commit()
            snapshot = adapters.CallSnapshot(
                base_url=row.base_url,
                model_id=row.model_id,
                protocol=row.protocol,
                stream=row.stream,
                prompt=row.prompt_text,
                temperature=row.temperature,
                max_output_tokens=row.max_output_tokens,
                reasoning_effort=row.reasoning_effort,
            )
            reference = row.credential_ref

        key: str | None = None
        raw_response: str | None = None
        usage: dict[str, int | None] | None = None

        async def progress(text: str) -> None:
            async with factory() as progress_session:
                current = await progress_session.get(Run, run_id)
                if current is not None and current.status == "running":
                    current.output_text = redact_credential(text, key) or ""
                    await progress_session.commit()

        try:
            key = read_credential(application.state.database_path, reference)
            result = await asyncio.wait_for(
                adapters.generate_text(snapshot, key, progress), timeout=60
            )
            raw_response = redact_credential(result.raw_response, key)
            usage = result.usage
            safe_text = redact_credential(result.text, key) or ""
            if not safe_text.strip() or not result.completed:
                raise ValueError("模型未返回完整的可见文本")
            async with factory() as session:
                row = await session.get(Run, run_id)
                if row is None or row.status != "running":
                    return
                row.status, row.output_text, row.usage, row.raw_response = (
                    "succeeded",
                    safe_text,
                    usage,
                    raw_response,
                )
                row.finished_at = now()
                model = await session.get(ProviderModel, row.provider_model_id)
                provider = await session.get(Provider, row.provider_id)
                if (
                    model is not None
                    and provider is not None
                    and provider.revision == row.provider_revision
                    and model.revision == row.model_revision
                    and await is_latest_verification(session, row)
                ):
                    if row.stream:
                        model.stream_status = "succeeded"
                    else:
                        model.text_status = "succeeded"
                await session.commit()
        except Exception as error:
            async with factory() as session:
                row = await session.get(Run, run_id)
                if row is None or row.status != "running":
                    return
                row.status, row.error, row.finished_at = (
                    "failed",
                    safe_verification_error(error),
                    now(),
                )
                row.raw_response = raw_response
                row.usage = usage
                model = await session.get(ProviderModel, row.provider_model_id)
                provider = await session.get(Provider, row.provider_id)
                if (
                    model is not None
                    and provider is not None
                    and provider.revision == row.provider_revision
                    and model.revision == row.model_revision
                    and await is_latest_verification(session, row)
                ):
                    if row.stream:
                        model.stream_status = "failed"
                    else:
                        model.text_status = "failed"
                await session.commit()
