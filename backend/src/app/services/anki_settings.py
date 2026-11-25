"""Offline Anki settings and address-scoped credentials for live requests."""

from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.anki_settings_models import AnkiConnectionSettings, AnkiExportConfiguration
from app.anki_settings_schemas import (
    DEFAULT_ANKI_URL,
    AnkiConfigurationInput,
    AnkiConfigurationResponse,
    AnkiConnectionInput,
    AnkiConnectionResponse,
    normalize_url,
)
from app.ids import ALPHABET, new_ulid
from app.services.settings import credential_dir, read_credential, save_credential


@dataclass(frozen=True, slots=True)
class AnkiConnectionTarget:
    url: str
    api_key: str | None = field(repr=False)
    revision: int | None


def connection_response(row: AnkiConnectionSettings | None) -> AnkiConnectionResponse:
    if row is None:
        return AnkiConnectionResponse(url=DEFAULT_ANKI_URL, has_api_key=False, revision=0)
    return AnkiConnectionResponse(
        url=row.url, has_api_key=row.credential_ref is not None, revision=row.revision
    )


async def get_connection_settings(session: AsyncSession) -> AnkiConnectionResponse:
    return connection_response(await session.get(AnkiConnectionSettings, 1))


def stored_api_key(database_path: Path, reference: str | None) -> str | None:
    if reference is None:
        return None
    try:
        if len(reference) != 26 or any(char not in ALPHABET for char in reference):
            raise ValueError("Invalid credential reference")
        return read_credential(database_path, reference)
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "无法读取 Anki API 密钥，请在设置中重新填写") from exc


async def resolve_connection_target(
    session: AsyncSession, database_path: Path, data: AnkiConnectionInput | None = None
) -> AnkiConnectionTarget:
    """Load credentials for the saved URL or resolve edits without writing them."""
    row = await session.get(AnkiConnectionSettings, 1)
    current = connection_response(row)
    if data is not None:
        if "api_key" in data.model_fields_set:
            return AnkiConnectionTarget(
                data.url,
                data.api_key.get_secret_value() if data.api_key is not None else None,
                None,
            )
        if data.url != current.url:
            return AnkiConnectionTarget(data.url, None, None)
    try:
        url = normalize_url(current.url)
    except ValueError as exc:
        raise HTTPException(422, "已保存的 AnkiConnect 地址无效，请重新填写") from exc
    return AnkiConnectionTarget(
        url,
        stored_api_key(database_path, row.credential_ref if row is not None else None),
        current.revision,
    )


async def save_connection_settings(
    session: AsyncSession, database_path: Path, data: AnkiConnectionInput
) -> AnkiConnectionResponse:
    async with session.begin():
        # Read the URL and reference in write order. An omitted key only belongs
        # to the endpoint observed in this transaction.
        await session.execute(text("BEGIN IMMEDIATE"))
        row = await session.get(AnkiConnectionSettings, 1)
        current = connection_response(row)
        reference = row.credential_ref if row is not None else None
        new_reference = None
        if data.api_key is not None:
            try:
                new_reference = save_credential(database_path, data.api_key.get_secret_value())
            except OSError as exc:
                raise HTTPException(503, "无法保存 Anki API 密钥") from exc
            reference = new_reference
        elif data.url != current.url or "api_key" in data.model_fields_set:
            reference = None

        if data.url == current.url and reference == (row.credential_ref if row else None):
            return current

        if row is None:
            row = AnkiConnectionSettings(id=1)
            session.add(row)
        row.url = data.url
        row.credential_ref = reference
        row.revision = current.revision + 1
        try:
            await session.flush()
        except BaseException:
            if new_reference is not None:
                with suppress(OSError):
                    (credential_dir(database_path) / new_reference).unlink(missing_ok=True)
            raise
        # Keep immutable references available to readers that loaded the previous
        # setting and through an ambiguous commit result.
        return connection_response(row)


def configuration_response(row: AnkiExportConfiguration) -> AnkiConfigurationResponse:
    return AnkiConfigurationResponse.model_validate({**row.definition, "id": row.id})


async def configuration_row(session: AsyncSession, identity: str) -> AnkiExportConfiguration:
    row = await session.get(AnkiExportConfiguration, identity)
    if row is None:
        raise HTTPException(404, "Anki 导出配置不存在")
    return row


async def list_configurations(session: AsyncSession) -> list[AnkiConfigurationResponse]:
    rows = await session.scalars(
        select(AnkiExportConfiguration).order_by(AnkiExportConfiguration.id)
    )
    return [configuration_response(row) for row in rows]


async def get_configuration(session: AsyncSession, identity: str) -> AnkiConfigurationResponse:
    return configuration_response(await configuration_row(session, identity))


async def create_configuration(
    session: AsyncSession, data: AnkiConfigurationInput
) -> AnkiConfigurationResponse:
    row = AnkiExportConfiguration(id=new_ulid(), definition=data.model_dump(mode="json"))
    response = configuration_response(row)
    session.add(row)
    await session.commit()
    return response


async def update_configuration(
    session: AsyncSession, identity: str, data: AnkiConfigurationInput
) -> AnkiConfigurationResponse:
    async with session.begin():
        await session.execute(text("BEGIN IMMEDIATE"))
        row = await configuration_row(session, identity)
        row.definition = data.model_dump(mode="json")
        return configuration_response(row)


async def delete_configuration(session: AsyncSession, identity: str) -> None:
    async with session.begin():
        await session.execute(text("BEGIN IMMEDIATE"))
        await session.delete(await configuration_row(session, identity))
