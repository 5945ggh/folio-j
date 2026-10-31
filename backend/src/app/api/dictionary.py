"""Thin routes for reader-owned local dictionary imports and lookups."""

from fastapi import APIRouter, Request

from app.dictionary_schemas import (
    DictionaryLookupRequest,
    DictionaryLookupResponse,
    DictionaryStatus,
)
from app.services.dictionary_store import DictionaryStore

router = APIRouter(prefix="/api/dictionary")


def store(request: Request) -> DictionaryStore:
    return request.app.state.dictionary_store


@router.get("", response_model=DictionaryStatus, operation_id="getDictionary")
async def get_dictionary(request: Request) -> DictionaryStatus:
    return await store(request).status()


@router.post(
    "/import",
    response_model=DictionaryStatus,
    operation_id="importDictionary",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def import_dictionary(request: Request) -> DictionaryStatus:
    return await store(request).import_stream(request.stream())


@router.post("/lookup", response_model=DictionaryLookupResponse, operation_id="lookupDictionary")
async def lookup_dictionary(
    body: DictionaryLookupRequest, request: Request
) -> DictionaryLookupResponse:
    from app.services.dictionary_lookup import lookup

    return await lookup(store(request), body)
