import hashlib
import json
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from typing import cast

import httpx
import pytest

from app.services.anki_connect import (
    AnkiCollection,
    AnkiConnect,
    AnkiConnectError,
    AnkiEntity,
    AnkiNoteCreated,
    AnkiTemplate,
)

JsonObject = dict[str, object]
_V1 = AnkiCollection("v1", "Reading", "reading-session")
_LEGACY = AnkiCollection("legacy", "Reading", None)
_DECK = AnkiEntity("1", "Japanese::Reading")
_MODEL = AnkiEntity("20", "Vocabulary")
_FIELDS = {"Front": "灰汁", "Back": "浮沫"}
_TEMPLATE = AnkiTemplate("Recall", "<!-- folio-j.vocabulary-recall@1 -->{{Front}}", "{{Back}}")
_V1_MODEL: JsonObject = {
    "id": _MODEL.id,
    "name": _MODEL.name,
    "kind": "normal",
    "fields": [{"name": field} for field in _FIELDS],
    "templates": [
        {
            "name": _TEMPLATE.name,
            "questionHtml": _TEMPLATE.question_html,
            "answerHtml": _TEMPLATE.answer_html,
        }
    ],
    "css": "",
    "sortField": "Front",
    "latexHeader": "",
    "latexFooter": "",
    "latexSvg": False,
    "modifiedAt": "2026-11-24T00:00:00Z",
}
_LEGACY_MODEL: JsonObject = {
    "id": int(_MODEL.id),
    "name": _MODEL.name,
    "type": 0,
    "flds": [{"name": field, "ord": index} for index, field in enumerate(_FIELDS)],
    "tmpls": [
        {
            "name": _TEMPLATE.name,
            "ord": 0,
            "qfmt": _TEMPLATE.question_html,
            "afmt": _TEMPLATE.answer_html,
        }
    ],
    "css": "",
}


@asynccontextmanager
async def _gateway(
    handler: Callable[[httpx.Request], httpx.Response], *, api_key: str | None = None
) -> AsyncGenerator[AnkiConnect]:
    # Explicit per-request redirect handling also applies to an injected client.
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=True, trust_env=False
    ) as client:
        yield AnkiConnect("http://127.0.0.1:8765", api_key, client=client)


def _body(request: httpx.Request) -> JsonObject:
    return cast(JsonObject, json.loads(request.content))


def _v1_reply(request: JsonObject, result: object) -> httpx.Response:
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": request["id"], "result": result})


def _v1_error(request: JsonObject, code: int, data: JsonObject) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": code, "message": "private upstream note content", "data": data},
        },
    )


def _legacy_result(result: object) -> JsonObject:
    return {"result": result, "error": None}


@pytest.mark.asyncio
async def test_v1_catalog_validation_installation_and_multiple_cards() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _body(request)
        assert request.url.path == "/api/v1"
        assert request.headers["authorization"] == "Bearer isolated-test-key"
        assert body["jsonrpc"] == "2.0"
        assert "key" not in body
        params = cast(JsonObject, body["params"])
        method = body["method"]
        if method == "collection.get":
            assert params == {}
            return _v1_reply(
                body, {"profile": _V1.profile, "session": _V1.session, "scheduler": "fsrs"}
            )
        assert params.pop("session") == _V1.session
        match method:
            case "decks.list":
                return _v1_reply(
                    body,
                    [
                        {"id": "1", "name": _DECK.name, "kind": "normal", "presetId": "1"},
                        {"id": "2", "name": "Filtered", "kind": "filtered", "presetId": None},
                    ],
                )
            case "noteTypes.list":
                return _v1_reply(body, [{"id": _MODEL.id, "name": _MODEL.name}])
            case "noteTypes.get":
                assert params == {"noteType": {"id": _MODEL.id}}
                return _v1_reply(body, _V1_MODEL)
            case "noteTypes.create":
                assert params == {
                    "name": _MODEL.name,
                    "kind": "normal",
                    "fields": _V1_MODEL["fields"],
                    "templates": _V1_MODEL["templates"],
                    "css": "",
                }
                return _v1_reply(body, _V1_MODEL)
            case "notes.validate":
                note = cast(JsonObject, params["note"])
                assert note["deck"] == {"id": _DECK.id}
                assert note["noteType"] == {"id": _MODEL.id}
                assert note["fields"] == _FIELDS
                assert note["duplicates"] == {"allow": False}
                return _v1_reply(
                    body,
                    {
                        "valid": False,
                        "issues": [{"type": "duplicate", "message": "private note content"}],
                        "duplicateNoteIds": ["80"],
                    },
                )
            case "notes.create":
                assert params == {
                    "deck": {"id": _DECK.id},
                    "noteType": {"id": _MODEL.id},
                    "fields": _FIELDS,
                    "duplicates": {"allow": True},
                }
                return _v1_reply(body, {"noteId": "81", "cardIds": ["101", "102"]})
            case _:
                raise AssertionError(method)

    async with _gateway(handler, api_key="isolated-test-key") as gateway:
        collection = await gateway.probe()
        assert collection == _V1
        assert await gateway.list_decks(collection) == (_DECK,)
        assert await gateway.list_note_types(collection) == (_MODEL,)
        model = await gateway.get_note_type(collection, _MODEL)
        assert model.fields == tuple(_FIELDS)
        assert model.templates == (_TEMPLATE,)
        assert (
            await gateway.create_note_type(
                collection, name=_MODEL.name, fields=tuple(_FIELDS), templates=(_TEMPLATE,), css=""
            )
            == model
        )
        with pytest.raises(AnkiConnectError, match="^duplicate$"):
            await gateway.validate_note(collection, deck=_DECK, note_type=_MODEL, fields=_FIELDS)
        assert await gateway.create_note(
            collection, deck=_DECK, note_type=_MODEL, fields=_FIELDS, allow_duplicate=True
        ) == AnkiNoteCreated("81", ("101", "102"))


@pytest.mark.parametrize(
    "legacy_probe_error",
    [
        "unsupported action",
        "'action' is a required property\n\nFailed validating 'required' in schema",
        "valid api key must be provided",
    ],
)
@pytest.mark.asyncio
async def test_legacy_transport_catalog_and_write(legacy_probe_error: str) -> None:
    submitted: list[str] = []

    def legacy(action: JsonObject) -> object:
        assert action["version"] == 6
        assert action["key"] == "isolated-test-key"
        params = cast(JsonObject, action["params"])
        match action["action"]:
            case "version":
                return 6
            case "getActiveProfile":
                return _LEGACY.profile
            case "multi":
                nested = cast(list[JsonObject], params["actions"])
                assert nested[0]["action"] == nested[-1]["action"] == "getActiveProfile"
                return [_legacy_result(legacy(item)) for item in nested]
            case "deckNamesAndIds":
                return {_DECK.name: int(_DECK.id), "Filtered": 2}
            case "getDeckConfig":
                return {"dyn": params["deck"] == "Filtered"}
            case "modelNamesAndIds":
                return {_MODEL.name: int(_MODEL.id)}
            case "findModelsById":
                assert params == {"modelIds": [int(_MODEL.id)]}
                return [_LEGACY_MODEL]
            case "createModel":
                assert params["modelName"] == _MODEL.name
                assert params["inOrderFields"] == list(_FIELDS)
                assert params["cardTemplates"] == [
                    {
                        "Name": _TEMPLATE.name,
                        "Front": _TEMPLATE.question_html,
                        "Back": _TEMPLATE.answer_html,
                    }
                ]
                submitted.append("model")
                return _LEGACY_MODEL
            case "canAddNoteWithErrorDetail" | "addNote":
                note = cast(JsonObject, params["note"])
                assert note["deckName"] == _DECK.name
                assert note["modelName"] == _MODEL.name
                assert note["fields"] == _FIELDS
                if action["action"] == "canAddNoteWithErrorDetail":
                    assert note["options"] == {"allowDuplicate": False}
                    return {
                        "canAdd": False,
                        "error": "cannot create note because it is a duplicate",
                    }
                assert note["options"] == {"allowDuplicate": True}
                submitted.append("note")
                return 81
            case "notesInfo":
                assert params == {"notes": [81]}
                return [{"noteId": 81, "cards": [101, 102]}]
            case "storeMediaFile":
                assert params == {"filename": "clip.mp3", "data": "eHl6", "deleteExisting": False}
                submitted.append("media")
                return "clip-stored.mp3"
            case _:
                raise AssertionError(action["action"])

    def handler(request: httpx.Request) -> httpx.Response:
        body = _body(request)
        if request.url.path == "/api/v1":
            assert body["method"] == "collection.get"
            return httpx.Response(200, json={"result": None, "error": legacy_probe_error})
        assert request.url.path == "/"
        assert "authorization" not in request.headers
        return httpx.Response(200, json=_legacy_result(legacy(body)))

    async with _gateway(handler, api_key="isolated-test-key") as gateway:
        collection = await gateway.probe()
        assert collection == _LEGACY
        assert await gateway.list_decks(collection) == (_DECK,)
        assert await gateway.list_note_types(collection) == (_MODEL,)
        assert (await gateway.get_note_type(collection, _MODEL)).templates == (_TEMPLATE,)
        with pytest.raises(AnkiConnectError, match="^duplicate$"):
            await gateway.validate_note(collection, deck=_DECK, note_type=_MODEL, fields=_FIELDS)
        assert submitted == []
        await gateway.create_note_type(
            collection, name=_MODEL.name, fields=tuple(_FIELDS), templates=(_TEMPLATE,), css=""
        )
        assert await gateway.store_media(collection, filename="clip.mp3", data=b"xyz") == (
            "clip-stored.mp3"
        )
        assert await gateway.create_note(
            collection, deck=_DECK, note_type=_MODEL, fields=_FIELDS, allow_duplicate=True
        ) == AnkiNoteCreated("81", ("101", "102"))
        assert submitted == ["model", "media", "note"]


@pytest.mark.parametrize(
    ("profile", "deck_id", "actual_fields", "code"),
    [
        ("Another profile", 1, ("Front", "Back"), "stale_session"),
        (_LEGACY.profile, 11, ("Front", "Back"), "target_missing"),
        (_LEGACY.profile, 1, ("Front", "Definition"), "target_missing"),
        (_LEGACY.profile, 1, ("Front",), "target_missing"),
        (_LEGACY.profile, 1, ("Front", "Back", "Extra"), "target_missing"),
        (_LEGACY.profile, 1, ("Back", "Front"), "target_missing"),
    ],
)
@pytest.mark.asyncio
async def test_legacy_write_checks_profile_target_and_complete_field_order(
    profile: str, deck_id: int, actual_fields: tuple[str, ...], code: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _body(request)
        assert body["action"] == "multi"
        actions = cast(list[JsonObject], cast(JsonObject, body["params"])["actions"])
        assert [action["action"] for action in actions] == [
            "getActiveProfile",
            "deckNamesAndIds",
            "getDeckConfig",
            "findModelsById",
            "getActiveProfile",
        ]
        assert actions[3]["params"] == {"modelIds": [int(_MODEL.id)]}
        model = {**_LEGACY_MODEL, "flds": [{"name": name} for name in actual_fields]}
        return httpx.Response(
            200,
            json=_legacy_result(
                [
                    _legacy_result(_LEGACY.profile),
                    _legacy_result({_DECK.name: deck_id}),
                    _legacy_result({"dyn": 0}),
                    _legacy_result([model]),
                    _legacy_result(profile),
                ]
            ),
        )

    async with _gateway(handler) as gateway:
        with pytest.raises(AnkiConnectError, match=f"^{code}$"):
            await gateway.create_note(_LEGACY, deck=_DECK, note_type=_MODEL, fields=_FIELDS)


@pytest.mark.parametrize("can_create", [False, True])
@pytest.mark.asyncio
async def test_v1_capability_check_reads_available_text_export_methods(can_create: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _body(request)
        assert request.url.path == "/api/v1"
        assert body["method"] == "api.describe"
        assert body["params"] == {}
        methods = [
            {"name": method, "available": True, "reason": None}
            for method in ("decks.list", "noteTypes.list", "noteTypes.get", "notes.validate")
        ]
        methods.append({"name": "notes.create", "available": can_create, "reason": None})
        return _v1_reply(body, {"apiMajor": 1, "methods": methods})

    async with _gateway(handler) as gateway:
        if can_create:
            await gateway.check_export_capabilities(_V1)
        else:
            with pytest.raises(AnkiConnectError, match="^unsupported$"):
                await gateway.check_export_capabilities(_V1)


@pytest.mark.parametrize("can_validate", [False, True])
@pytest.mark.asyncio
async def test_legacy_capability_check_requires_text_export_actions(can_validate: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = _body(request)
        assert request.url.path == "/"
        assert body["action"] == "apiReflect"
        assert body["version"] == 6
        params = cast(JsonObject, body["params"])
        assert params["scopes"] == ["actions"]
        actions = [
            "getActiveProfile",
            "multi",
            "deckNamesAndIds",
            "getDeckConfig",
            "modelNamesAndIds",
            "findModelsById",
            "canAddNoteWithErrorDetail",
            "addNote",
        ]
        assert params["actions"] == sorted(actions)
        if not can_validate:
            actions.remove("canAddNoteWithErrorDetail")
        return httpx.Response(200, json=_legacy_result({"scopes": ["actions"], "actions": actions}))

    async with _gateway(handler) as gateway:
        if can_validate:
            await gateway.check_export_capabilities(_LEGACY)
        else:
            with pytest.raises(AnkiConnectError, match="^unsupported$"):
                await gateway.check_export_capabilities(_LEGACY)


@pytest.mark.asyncio
async def test_invalid_endpoint_is_unreachable_before_sending() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        gateway = AnkiConnect("http://127.0.0.1:invalid-port", client=client)
        with pytest.raises(AnkiConnectError, match="^unreachable$"):
            await gateway.probe()


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(401), "authentication"),
        (httpx.Response(403), "authentication"),
        (httpx.Response(302, headers={"Location": "http://redirected.invalid"}), "protocol_error"),
        (httpx.Response(200, text="<html>bad service</html>"), "protocol_error"),
        (httpx.Response(200, json={"result": None, "error": "unrelated error"}), "protocol_error"),
        (1004, "no_collection"),
        (-32601, "unsupported"),
    ],
)
@pytest.mark.asyncio
async def test_probe_does_not_retry_when_v1_is_present_or_unrecognized(
    response: httpx.Response | int, code: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1"
        if isinstance(response, int):
            return _v1_error(_body(request), response, {"type": "collectionUnavailable"})
        return response

    async with _gateway(handler) as gateway:
        with pytest.raises(AnkiConnectError, match=f"^{code}$"):
            await gateway.probe()


@pytest.mark.parametrize(
    ("response_kind", "code"),
    [
        ("connect_timeout", "unreachable"),
        ("read_timeout", "unknown_write"),
        ("wrong_response_id", "unknown_write"),
        ("stale_session", "stale_session"),
        ("duplicate", "duplicate"),
    ],
)
@pytest.mark.asyncio
async def test_create_note_reports_write_outcome_without_retry(
    response_kind: str, code: str
) -> None:
    writes = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal writes
        assert request.url.path == "/api/v1"
        body = _body(request)
        assert body["method"] == "notes.create"
        writes += 1
        match response_kind:
            case "connect_timeout":
                raise httpx.ConnectTimeout("private endpoint", request=request)
            case "read_timeout":
                raise httpx.ReadTimeout("private endpoint", request=request)
            case "wrong_response_id":
                return _v1_reply({"id": "wrong"}, {"noteId": "81", "cardIds": ["101"]})
            case "stale_session":
                return _v1_error(body, 1005, {"type": "staleSession"})
            case "duplicate":
                return _v1_error(
                    body,
                    1002,
                    {
                        "type": "validationFailed",
                        "details": {
                            "issues": [{"type": "duplicate", "message": "private content"}]
                        },
                    },
                )
            case _:
                raise AssertionError(response_kind)

    async with _gateway(handler) as gateway:
        with pytest.raises(AnkiConnectError, match=f"^{code}$"):
            await gateway.create_note(_V1, deck=_DECK, note_type=_MODEL, fields=_FIELDS)
    assert writes == 1


@pytest.mark.parametrize("lost_receipt", [False, True])
@pytest.mark.asyncio
async def test_v1_media_polls_completion_without_repeating_write(lost_receipt: bool) -> None:
    calls: list[object] = []
    operation: JsonObject = {"method": "media.store", "session": _V1.session, "operationId": "op"}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1"
        body = _body(request)
        calls.append(body["method"])
        if body["method"] == "media.store":
            assert body["params"] == {
                "filename": "clip.mp3",
                "source": {"data": "eHl6"},
                "collision": "rename",
                "session": _V1.session,
            }
            return _v1_reply(body, operation)
        assert body["method"] == "operations.get"
        assert body["params"] == {"operationId": "op"}
        if len(calls) == 2:
            return _v1_reply(body, {**operation, "state": "running"})
        if lost_receipt:
            return _v1_error(body, 1001, {"type": "notFound"})
        return _v1_reply(
            body,
            {
                **operation,
                "state": "succeeded",
                "result": {
                    "status": "stored",
                    "filename": "clip-renamed.mp3",
                    "sha256": hashlib.sha256(b"xyz").hexdigest(),
                },
            },
        )

    async with _gateway(handler) as gateway:
        if lost_receipt:
            with pytest.raises(AnkiConnectError, match="^unknown_write$"):
                await gateway.store_media(_V1, filename="clip.mp3", data=b"xyz")
        else:
            assert await gateway.store_media(_V1, filename="clip.mp3", data=b"xyz") == (
                "clip-renamed.mp3"
            )
    assert calls == ["media.store", "operations.get", "operations.get"]
