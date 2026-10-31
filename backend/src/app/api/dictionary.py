"""Thin routes for reader-owned local dictionary imports and lookups."""

from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.dictionary_schemas import (
    DictionaryLibrary,
    DictionaryLibraryImport,
    DictionaryLookupRequest,
    DictionaryLookupResponse,
    DictionarySelection,
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


@router.get("/library", response_model=DictionaryLibrary, operation_id="getDictionaryLibrary")
async def get_library(request: Request) -> DictionaryLibrary:
    return await store(request).library()


@router.post(
    "/library/import",
    response_model=DictionaryLibraryImport,
    operation_id="importDictionaryLibrary",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def import_library_dictionary(request: Request) -> DictionaryLibraryImport:
    return await store(request).import_library_stream(request.stream())


@router.put(
    "/library/selection", response_model=DictionaryLibrary, operation_id="selectDictionaryLibrary"
)
async def select_library(body: DictionarySelection, request: Request) -> DictionaryLibrary:
    return await store(request).select(body.dictionary_id)


@router.delete(
    "/library/{dictionary_id}",
    response_model=DictionaryLibrary,
    operation_id="deleteDictionaryLibrary",
)
async def delete_library(
    dictionary_id: str,
    request: Request,
    replacement_dictionary_id: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
) -> DictionaryLibrary:
    return await store(request).delete(dictionary_id, replacement_dictionary_id)
