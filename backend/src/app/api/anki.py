"""Anki operations for a transient draft. Only settings have local storage."""

from collections.abc import AsyncIterator, Callable, Coroutine
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Message

from app.anki_builtins import AnkiBuiltins, get_builtins
from app.anki_export_schemas import (
    AnkiBuiltinCheckInput,
    AnkiBuiltinCheckResponse,
    AnkiExportInput,
    AnkiExportResponse,
)
from app.anki_settings_schemas import AnkiConnectionInput
from app.services import anki_catalog, anki_export, anki_settings
from app.services.anki_connect import AnkiConnect

# Base64 expands 24 MiB of attachments to 32 MiB; allow space for fields/envelope.
MAX_EXPORT_REQUEST_BYTES = 40 * 1024 * 1024


class _AnkiRoute(APIRoute):
    """Limit bytes before FastAPI buffers JSON, including requests without Content-Length."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handle = super().get_route_handler()

        async def bounded(request: Request) -> Response:
            total = 0

            async def receive() -> Message:
                nonlocal total
                message = await request.receive()
                total += len(message.get("body", b""))
                if total > MAX_EXPORT_REQUEST_BYTES:
                    raise HTTPException(413, "Anki 请求超过 40 MiB 上限")
                return message

            return await handle(Request(request.scope, receive))

        return bounded


router = APIRouter(prefix="/api/anki", tags=["Anki"], route_class=_AnkiRoute)
_read_errors: dict[int | str, dict[str, Any]] = {
    status: {"model": anki_catalog.AnkiReadFailure} for status in (403, 404, 409, 502, 503)
}


async def anki_http_client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as client:
        yield client


AnkiHttp = Annotated[httpx.AsyncClient, Depends(anki_http_client)]


async def _connect(
    request: Request, http: httpx.AsyncClient, edits: AnkiConnectionInput | None = None
) -> AnkiConnect:
    # Close the SQLite read transaction before waiting on the external application.
    async with request.app.state.session_factory() as session:
        db: AsyncSession = session
        target = await anki_settings.resolve_connection_target(
            db, request.app.state.database_path, edits
        )
    return AnkiConnect(target.url, target.api_key, client=http)


async def saved_gateway(request: Request, http: AnkiHttp) -> AnkiConnect:
    return await _connect(request, http)


Gateway = Annotated[AnkiConnect, Depends(saved_gateway)]


@router.get("/builtins", operation_id="getAnkiBuiltins")
def builtins() -> AnkiBuiltins:
    return get_builtins()


@router.post("/probe", operation_id="probeAnkiConnection", responses=_read_errors)
async def probe(
    request: Request, http: AnkiHttp, data: AnkiConnectionInput | None = None
) -> anki_catalog.AnkiCollectionInfo:
    return await anki_catalog.probe(await _connect(request, http, data))


@router.get("/catalog", operation_id="getAnkiCatalog", responses=_read_errors)
async def catalog(gateway: Gateway) -> anki_catalog.AnkiCatalog:
    return await anki_catalog.catalog(gateway)


@router.post("/note-type-fields", operation_id="getAnkiNoteTypeFields", responses=_read_errors)
async def fields(
    data: anki_catalog.AnkiTypeLookup, gateway: Gateway
) -> anki_catalog.AnkiTypeFields:
    return await anki_catalog.note_type_fields(gateway, data)


@router.post("/builtin-check", operation_id="checkAnkiBuiltinNoteType")
async def check_builtin(data: AnkiBuiltinCheckInput, gateway: Gateway) -> AnkiBuiltinCheckResponse:
    return await anki_export.check_builtin(gateway, data, get_builtins())


@router.post("/export", operation_id="exportAnkiNote")
async def export_note(data: AnkiExportInput, gateway: Gateway) -> AnkiExportResponse:
    return await anki_export.export_note(gateway, data, get_builtins())
