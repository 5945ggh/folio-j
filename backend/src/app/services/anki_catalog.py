"""Read the active Anki collection and mapping targets without changing it."""

from typing import Literal

from pydantic import BaseModel, Field

from app.anki_settings_schemas import AnkiEntityId, AnkiName, AnkiSettingsInput, AnkiUrl
from app.services.anki_connect import AnkiConnect, AnkiConnectError, AnkiErrorCode


class AnkiCollectionInfo(BaseModel):
    endpoint: str
    protocol: Literal["v1", "legacy"]
    profile: str


class AnkiReadFailure(BaseModel):
    code: AnkiErrorCode | None = None
    detail: str


class AnkiCatalogItem(BaseModel):
    id: str
    name: str


class AnkiCatalog(AnkiCollectionInfo):
    decks: list[AnkiCatalogItem]
    note_types: list[AnkiCatalogItem]


class AnkiTypeLookup(AnkiSettingsInput):
    endpoint: AnkiUrl
    profile: AnkiName
    note_type_id: AnkiEntityId


class AnkiTypeFields(AnkiCatalogItem):
    fields: list[str]
    card_templates: list[str] = Field(description="Anki 卡片模板名，依笔记类型中的顺序。")


async def probe(gateway: AnkiConnect) -> AnkiCollectionInfo:
    active = await gateway.probe()
    await gateway.check_export_capabilities(active)
    return AnkiCollectionInfo(
        endpoint=gateway.endpoint, protocol=active.protocol, profile=active.profile
    )


async def catalog(gateway: AnkiConnect) -> AnkiCatalog:
    active = await gateway.probe()
    decks = await gateway.list_decks(active)
    types = await gateway.list_note_types(active)
    return AnkiCatalog(
        endpoint=gateway.endpoint,
        protocol=active.protocol,
        profile=active.profile,
        decks=[AnkiCatalogItem(id=d.id, name=d.name) for d in decks],
        note_types=[AnkiCatalogItem(id=t.id, name=t.name) for t in types],
    )


async def note_type_fields(gateway: AnkiConnect, data: AnkiTypeLookup) -> AnkiTypeFields:
    if data.endpoint != gateway.endpoint:
        raise AnkiConnectError("stale_session")
    active = await gateway.probe()
    if data.profile != active.profile:
        raise AnkiConnectError("stale_session")
    models = await gateway.list_note_types(active)
    model = next((m for m in models if m.id == data.note_type_id), None)
    if model is None:
        raise AnkiConnectError("target_missing")
    details = await gateway.get_note_type(active, model)
    return AnkiTypeFields(
        id=details.id,
        name=details.name,
        fields=list(details.fields),
        card_templates=[t.name for t in details.templates],
    )
