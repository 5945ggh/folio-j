"""The AnkiConnect operations used by reader export."""

from __future__ import annotations

import asyncio
import base64
import hashlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, TypeVar, cast
from uuid import uuid4

import httpx

AnkiProtocol = Literal["v1", "legacy"]
AnkiErrorCode = Literal[
    "unreachable",
    "authentication",
    "no_collection",
    "unsupported",
    "stale_session",
    "duplicate",
    "invalid_note",
    "target_missing",
    "conflict",
    "unknown_write",
    "protocol_error",
]
_JsonObject = dict[str, object]
_T = TypeVar("_T")
_TIMEOUT = httpx.Timeout(10.0, connect=2.0, pool=2.0)
_MEDIA_POLL_SECONDS = 0.15
_MEDIA_COMPLETION_SECONDS = 20.0
_V1_EXPORT_METHODS = {
    "decks.list",
    "noteTypes.list",
    "noteTypes.get",
    "notes.validate",
    "notes.create",
}
_LEGACY_EXPORT_ACTIONS = {
    "getActiveProfile",
    "multi",
    "deckNamesAndIds",
    "getDeckConfig",
    "modelNamesAndIds",
    "findModelsById",
    "canAddNoteWithErrorDetail",
    "addNote",
}


class AnkiConnectError(Exception):
    def __init__(self, code: AnkiErrorCode) -> None:
        # Never forward upstream errors, which may contain fields or other request data.
        self.code = code
        super().__init__(code)


def connection_error_message(error: AnkiConnectError) -> str:
    return {
        "unreachable": "无法连接 Anki，请检查 Anki 与 AnkiConnect 是否正在运行。",
        "authentication": "AnkiConnect 未接受当前凭据，请检查连接设置。",
        "no_collection": "Anki 当前没有打开的集合。",
        "unsupported": "当前 AnkiConnect 不支持此操作。",
        "stale_session": "Anki 活动集合已变更，请重新核对目标。",
        "duplicate": "Anki 判定当前笔记为重复。",
        "invalid_note": "Anki 未接受当前字段，请检查必填项和卡片模板。",
        "target_missing": "Anki 目标已失效，请重新选择。",
        "conflict": "Anki 当前状态与请求冲突，请重新检查后再操作。",
        "unknown_write": "Anki 回执未确认。",
        "protocol_error": "AnkiConnect 返回了无法解析的结果。",
    }.get(error.code, "Anki 操作失败。")


class _V1Unavailable(Exception):
    pass


@dataclass(frozen=True)
class AnkiCollection:
    protocol: AnkiProtocol
    profile: str
    session: str | None


@dataclass(frozen=True)
class AnkiEntity:
    id: str
    name: str


@dataclass(frozen=True)
class AnkiTemplate:
    name: str
    question_html: str
    answer_html: str


@dataclass(frozen=True)
class AnkiNoteType(AnkiEntity):
    fields: tuple[str, ...]
    templates: tuple[AnkiTemplate, ...]
    css: str
    kind: Literal["normal", "cloze"]


@dataclass(frozen=True)
class AnkiNoteCreated:
    note_id: str
    card_ids: tuple[str, ...] | None


def _object(value: object) -> _JsonObject:
    if not isinstance(value, dict):
        raise AnkiConnectError("protocol_error")
    return cast(_JsonObject, value)


def _array(value: object) -> list[object]:
    if not isinstance(value, list):
        raise AnkiConnectError("protocol_error")
    return cast(list[object], value)


def _string(value: object, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value):
        raise AnkiConnectError("protocol_error")
    return value


def _id(value: object, *, legacy: bool = False) -> str:
    if legacy and type(value) is int:
        value = str(value)
    value = _string(value)
    if (
        not 1 <= len(value) <= 19
        or value.startswith("0")
        or not value.isascii()
        or not value.isdecimal()
        or int(value) > 2**63 - 1
    ):
        raise AnkiConnectError("protocol_error")
    return value


def _receipt(parse: Callable[[object], _T], value: object) -> _T:
    try:
        return parse(value)
    except AnkiConnectError:
        raise AnkiConnectError("unknown_write") from None


def _issue_code(issues: object) -> AnkiErrorCode:
    if isinstance(issues, list) and issues:
        entries = cast(list[object], issues)
        if all(
            isinstance(issue, dict) and cast(_JsonObject, issue).get("type") == "duplicate"
            for issue in entries
        ):
            return "duplicate"
    return "invalid_note"


def _v1_error(value: object, *, write: bool) -> AnkiConnectError:
    error = _object(value)
    code = error.get("code")
    if type(code) is not int or not isinstance(error.get("message"), str):
        raise AnkiConnectError("protocol_error")
    if code == 1002:
        data = _object(error.get("data"))
        details = data.get("details")
        issues = cast(_JsonObject, details).get("issues") if isinstance(details, dict) else None
        return AnkiConnectError(_issue_code(issues))
    codes: dict[int, AnkiErrorCode] = {
        -32601: "unsupported",
        -32602: "invalid_note",
        1001: "target_missing",
        1003: "conflict",
        1004: "no_collection",
        1005: "stale_session",
        1006: "unsupported",
        1007: "conflict",
        1008: "conflict",
        1009: "conflict",
        1010: "conflict",
        1011: "authentication",
        1016: "unsupported",
    }
    return AnkiConnectError(codes.get(code, "unknown_write" if write else "protocol_error"))


_LEGACY_AUTH = "valid api key must be provided"
_LEGACY_PROBE_ERRORS = {_LEGACY_AUTH, "unsupported action", "'action' is a required property"}


def _legacy_error(message: str, *, write: bool, validation: bool = False) -> AnkiConnectError:
    reason = message.strip().lower()
    codes: dict[str, AnkiErrorCode] = {
        _LEGACY_AUTH: "authentication",
        "unsupported action": "unsupported",
        "version not supported": "unsupported",
        "api version not supported": "unsupported",
        "collection is not available": "no_collection",
        "collection is not available.": "no_collection",
        "collection is not open": "no_collection",
        "no collection is open": "no_collection",
        "no collection is open.": "no_collection",
        "collection changed": "stale_session",
        "cannot create note because it is a duplicate": "duplicate",
        "cannot create note because it is empty": "invalid_note",
        "cannot create note for unknown reason": "invalid_note",
        "model name already exists": "conflict",
        "model name already exists.": "conflict",
    }
    if reason.startswith(("deck was not found:", "model was not found:")):
        return AnkiConnectError("target_missing")
    default = "invalid_note" if validation else ("unknown_write" if write else "protocol_error")
    return AnkiConnectError(codes.get(reason, default))


def _legacy_result(value: object, *, write: bool = False) -> object:
    envelope = _object(value)
    if set(envelope) != {"result", "error"}:
        raise AnkiConnectError("protocol_error")
    error = envelope["error"]
    if error is not None:
        if envelope["result"] is not None:
            raise AnkiConnectError("protocol_error")
        raise _legacy_error(_string(error), write=write)
    return envelope["result"]


def _note_type(value: object, *, legacy: bool = False) -> AnkiNoteType:
    model = _object(value)
    if legacy:
        kind = model.get("type")
        if type(kind) is not int or kind not in (0, 1):
            raise AnkiConnectError("protocol_error")
        model_kind = "cloze" if kind == 1 else "normal"
        fields_key, templates_key, front_key, back_key = "flds", "tmpls", "qfmt", "afmt"
    else:
        kind = model.get("kind")
        if kind not in ("normal", "cloze"):
            raise AnkiConnectError("protocol_error")
        model_kind = "cloze" if kind == "cloze" else "normal"
        fields_key, templates_key, front_key, back_key = (
            "fields",
            "templates",
            "questionHtml",
            "answerHtml",
        )
    fields = tuple(_string(_object(field).get("name")) for field in _array(model.get(fields_key)))
    templates = tuple(
        AnkiTemplate(
            _string(template.get("name")),
            _string(template.get(front_key), empty=True),
            _string(template.get(back_key), empty=True),
        )
        for template in map(_object, _array(model.get(templates_key)))
    )
    if not fields or not templates:
        raise AnkiConnectError("protocol_error")
    return AnkiNoteType(
        _id(model.get("id"), legacy=legacy),
        _string(model.get("name")),
        fields,
        templates,
        _string(model.get("css"), empty=True),
        model_kind,
    )


def _legacy_note_type(value: object) -> AnkiNoteType:
    models = _array(value)
    if not models:
        raise AnkiConnectError("target_missing")
    if len(models) != 1:
        raise AnkiConnectError("protocol_error")
    return _note_type(models[0], legacy=True)


def _media_filename(value: object) -> str:
    name = _string(value)
    if name in (".", "..") or any(char in name for char in "/\\\0\r\n"):
        raise AnkiConnectError("protocol_error")
    return name


class AnkiConnect:
    def __init__(
        self,
        endpoint: str,
        api_key: str | None = None,
        *,
        client: httpx.AsyncClient,
    ) -> None:
        self.endpoint = endpoint
        self._base_url = endpoint.rstrip("/")
        self._api_key = api_key or None
        self._client = client

    async def probe(self) -> AnkiCollection:
        try:
            value = _object(await self._v1("collection.get", {}, probe=True))
        except _V1Unavailable:
            return await self._probe_legacy()
        return AnkiCollection("v1", _string(value.get("profile")), _string(value.get("session")))

    async def _probe_legacy(self) -> AnkiCollection:
        version = await self._legacy("version", {})
        if type(version) is not int or version < 6:
            raise AnkiConnectError("unsupported")
        collection = AnkiCollection("legacy", await self._legacy_profile(), None)
        # Older add-ons can report a selected profile while its collection is closed.
        (decks,) = await self._legacy_read(collection, ("deckNamesAndIds", {}))
        _object(decks)
        return collection

    async def check_export_capabilities(self, collection: AnkiCollection) -> None:
        if collection.protocol == "v1":
            report = _object(await self._v1("api.describe", {}))
            if type(report.get("apiMajor")) is not int or report["apiMajor"] != 1:
                raise AnkiConnectError("unsupported")
            available: set[str] = set()
            for entry in map(_object, _array(report.get("methods"))):
                if type(entry.get("available")) is not bool:
                    raise AnkiConnectError("protocol_error")
                if entry["available"]:
                    available.add(_string(entry.get("name")))
            if not _V1_EXPORT_METHODS <= available:
                raise AnkiConnectError("unsupported")
            return

        report = _object(
            await self._legacy(
                "apiReflect", {"scopes": ["actions"], "actions": sorted(_LEGACY_EXPORT_ACTIONS)}
            )
        )
        if "actions" not in _array(report.get("scopes")):
            raise AnkiConnectError("unsupported")
        available = {_string(action) for action in _array(report.get("actions"))}
        if not _LEGACY_EXPORT_ACTIONS <= available:
            raise AnkiConnectError("unsupported")

    async def list_decks(self, collection: AnkiCollection) -> tuple[AnkiEntity, ...]:
        if collection.protocol == "v1":
            values = _array(await self._collection_v1("decks.list", collection, {}))
            decks: list[AnkiEntity] = []
            for deck in map(_object, values):
                kind = deck.get("kind")
                if kind == "normal":
                    decks.append(AnkiEntity(_id(deck.get("id")), _string(deck.get("name"))))
                elif kind != "filtered":
                    raise AnkiConnectError("protocol_error")
            return tuple(decks)

        (catalog_result,) = await self._legacy_read(collection, ("deckNamesAndIds", {}))
        catalog = _object(catalog_result)
        # getDeckConfig is a read; use only deck names returned by the add-on.
        configs = await self._legacy_read(
            collection, *(("getDeckConfig", {"deck": name}) for name in catalog)
        )
        return tuple(
            AnkiEntity(_id(id_value, legacy=True), _string(name))
            for (name, id_value), config in zip(catalog.items(), configs, strict=True)
            if self._legacy_normal_deck(config)
        )

    async def list_note_types(self, collection: AnkiCollection) -> tuple[AnkiEntity, ...]:
        if collection.protocol == "v1":
            values = _array(await self._collection_v1("noteTypes.list", collection, {}))
            return tuple(
                AnkiEntity(_id(model.get("id")), _string(model.get("name")))
                for model in map(_object, values)
            )
        (result,) = await self._legacy_read(collection, ("modelNamesAndIds", {}))
        models = _object(result)
        return tuple(
            AnkiEntity(_id(value, legacy=True), _string(name)) for name, value in models.items()
        )

    async def get_note_type(self, collection: AnkiCollection, model: AnkiEntity) -> AnkiNoteType:
        if collection.protocol == "v1":
            value = await self._collection_v1(
                "noteTypes.get", collection, {"noteType": {"id": model.id}}
            )
            note_type = _note_type(value)
        else:
            (result,) = await self._legacy_read(
                collection, ("findModelsById", {"modelIds": [int(_id(model.id))]})
            )
            note_type = _legacy_note_type(result)
        if note_type.id != model.id:
            raise AnkiConnectError("target_missing")
        return note_type

    async def create_note_type(
        self,
        collection: AnkiCollection,
        *,
        name: str,
        fields: tuple[str, ...],
        templates: tuple[AnkiTemplate, ...],
        css: str,
    ) -> AnkiNoteType:
        if collection.protocol == "v1":
            value = await self._collection_v1(
                "noteTypes.create",
                collection,
                {
                    "name": name,
                    "kind": "normal",
                    "fields": [{"name": field} for field in fields],
                    "templates": [
                        {
                            "name": template.name,
                            "questionHtml": template.question_html,
                            "answerHtml": template.answer_html,
                        }
                        for template in templates
                    ],
                    "css": css,
                },
                write=True,
            )
            return _receipt(_note_type, value)
        await self._check_legacy_profile(collection)
        value = await self._legacy(
            "createModel",
            {
                "modelName": name,
                "inOrderFields": fields,
                "cardTemplates": [
                    {
                        "Name": template.name,
                        "Front": template.question_html,
                        "Back": template.answer_html,
                    }
                    for template in templates
                ],
                "css": css,
                "isCloze": False,
            },
            write=True,
        )
        return _receipt(lambda result: _note_type(result, legacy=True), value)

    async def validate_note(
        self,
        collection: AnkiCollection,
        *,
        deck: AnkiEntity,
        note_type: AnkiEntity,
        fields: dict[str, str],
        allow_duplicate: bool = False,
    ) -> None:
        note = self._note(collection.protocol, deck, note_type, fields, allow_duplicate)
        if collection.protocol == "v1":
            result = _object(
                await self._collection_v1("notes.validate", collection, {"note": note})
            )
            valid = result.get("valid")
            if type(valid) is not bool:
                raise AnkiConnectError("protocol_error")
            if not valid:
                raise AnkiConnectError(_issue_code(_array(result.get("issues"))))
            return

        (validation,) = await self._legacy_read(
            collection, ("canAddNoteWithErrorDetail", {"note": note})
        )
        result = _object(validation)
        valid = result.get("canAdd")
        if type(valid) is not bool:
            raise AnkiConnectError("protocol_error")
        if not valid:
            raise _legacy_error(_string(result.get("error")), write=False, validation=True)

    async def create_note(
        self,
        collection: AnkiCollection,
        *,
        deck: AnkiEntity,
        note_type: AnkiEntity,
        fields: dict[str, str],
        allow_duplicate: bool = False,
    ) -> AnkiNoteCreated:
        note = self._note(collection.protocol, deck, note_type, fields, allow_duplicate)
        if collection.protocol == "v1":
            result = await self._collection_v1("notes.create", collection, note, write=True)
            return _receipt(self._v1_note_created, result)

        decks, config, models = await self._legacy_read(
            collection,
            ("deckNamesAndIds", {}),
            ("getDeckConfig", {"deck": deck.name}),
            ("findModelsById", {"modelIds": [int(_id(note_type.id))]}),
        )
        actual = _legacy_note_type(models)
        # Legacy addNote resolves names and silently drops unknown fields. The export's
        # field order also captures the first field used by Anki's duplicate check.
        if (
            not self._legacy_has_entity(decks, deck)
            or not self._legacy_normal_deck(config)
            or actual.id != note_type.id
            or actual.name != note_type.name
            or actual.fields != tuple(fields)
        ):
            raise AnkiConnectError("target_missing")
        result = await self._legacy("addNote", {"note": note}, write=True)
        note_id = _receipt(lambda value: _id(value, legacy=True), result)
        try:
            (info,) = await self._legacy_read(collection, ("notesInfo", {"notes": [int(note_id)]}))
            records = _array(info)
            record = _object(records[0]) if len(records) == 1 else {}
            if (
                _id(record.get("noteId"), legacy=True) == note_id
                and record.get("profile", collection.profile) == collection.profile
            ):
                card_ids = tuple(_id(card, legacy=True) for card in _array(record.get("cards")))
                return AnkiNoteCreated(note_id, card_ids)
        except AnkiConnectError:
            # addNote already confirmed creation. This read only enriches the receipt.
            pass
        return AnkiNoteCreated(note_id, None)

    async def store_media(self, collection: AnkiCollection, *, filename: str, data: bytes) -> str:
        filename = _media_filename(filename)
        encoded = base64.b64encode(data).decode("ascii")
        if collection.protocol == "legacy":
            await self._check_legacy_profile(collection)
            stored = await self._legacy(
                "storeMediaFile",
                {"filename": filename, "data": encoded, "deleteExisting": False},
                write=True,
            )
            return _receipt(_media_filename, stored)

        handle = await self._collection_v1(
            "media.store",
            collection,
            {"filename": filename, "source": {"data": encoded}, "collision": "rename"},
            write=True,
        )
        # A handle means Anki accepted the write. Polling can observe it but cannot repeat it.
        try:
            operation_id = self._media_operation_id(handle, collection)
            async with asyncio.timeout(_MEDIA_COMPLETION_SECONDS):
                while True:
                    result = await self._v1("operations.get", {"operationId": operation_id})
                    if self._media_operation_id(result, collection) != operation_id:
                        raise AnkiConnectError("protocol_error")
                    operation = _object(result)
                    state = operation.get("state")
                    if state == "succeeded":
                        media = _object(operation.get("result"))
                        if media.get("status") != "stored":
                            raise AnkiConnectError("protocol_error")
                        if media.get("sha256") != hashlib.sha256(data).hexdigest():
                            raise AnkiConnectError("protocol_error")
                        return _media_filename(media.get("filename"))
                    if state in ("failed", "cancelled"):
                        error = _v1_error(operation.get("error"), write=True)
                        break
                    if state not in ("queued", "running", "waitingForUser"):
                        raise AnkiConnectError("protocol_error")
                    await asyncio.sleep(_MEDIA_POLL_SECONDS)
        except (AnkiConnectError, TimeoutError):
            raise AnkiConnectError("unknown_write") from None
        raise error

    @staticmethod
    def _media_operation_id(value: object, collection: AnkiCollection) -> str:
        operation = _object(value)
        if (
            operation.get("method") != "media.store"
            or operation.get("session") != collection.session
        ):
            raise AnkiConnectError("protocol_error")
        return _string(operation.get("operationId"))

    @staticmethod
    def _note(
        protocol: AnkiProtocol,
        deck: AnkiEntity,
        note_type: AnkiEntity,
        fields: dict[str, str],
        allow_duplicate: bool,
    ) -> _JsonObject:
        if protocol == "v1":
            return {
                "deck": {"id": deck.id},
                "noteType": {"id": note_type.id},
                "fields": fields,
                "duplicates": {"allow": allow_duplicate},
            }
        return {
            "deckName": deck.name,
            "modelName": note_type.name,
            "fields": fields,
            "options": {"allowDuplicate": allow_duplicate},
        }

    @staticmethod
    def _v1_note_created(value: object) -> AnkiNoteCreated:
        result = _object(value)
        return AnkiNoteCreated(
            _id(result.get("noteId")),
            tuple(_id(card) for card in _array(result.get("cardIds"))),
        )

    async def _legacy_profile(self) -> str:
        value = await self._legacy("getActiveProfile", {})
        if value is None:
            raise AnkiConnectError("no_collection")
        return _string(value)

    async def _check_legacy_profile(self, collection: AnkiCollection) -> None:
        # Legacy v6 has no session token to pass with the actual write.
        if await self._legacy_profile() != collection.profile:
            raise AnkiConnectError("stale_session")

    @staticmethod
    def _legacy_has_entity(catalog: object, entity: AnkiEntity) -> bool:
        value = _object(catalog).get(entity.name)
        return value is not None and _id(value, legacy=True) == entity.id

    @staticmethod
    def _legacy_normal_deck(value: object) -> bool:
        if value is False:
            return False
        config = _object(value)
        if "dyn" not in config:
            # The rewritten add-on returns the preset directly for normal decks.
            _id(config.get("id"), legacy=True)
            return True
        dynamic = config["dyn"]
        if not isinstance(dynamic, (bool, int)) or dynamic not in (0, 1):
            raise AnkiConnectError("protocol_error")
        return dynamic == 0

    async def _legacy_read(
        self, collection: AnkiCollection, *actions: tuple[str, Mapping[str, object]]
    ) -> tuple[object, ...]:
        profile = self._legacy_payload("getActiveProfile", {})
        requests = [profile, *(self._legacy_payload(*action) for action in actions), profile]
        replies = _array(await self._legacy("multi", {"actions": requests}))
        if len(replies) != len(requests):
            raise AnkiConnectError("protocol_error")
        if any(_legacy_result(reply) != collection.profile for reply in (replies[0], replies[-1])):
            raise AnkiConnectError("stale_session")
        return tuple(_legacy_result(reply) for reply in replies[1:-1])

    async def _collection_v1(
        self, method: str, collection: AnkiCollection, params: _JsonObject, *, write: bool = False
    ) -> object:
        return await self._v1(
            method, {**params, "session": _string(collection.session)}, write=write
        )

    async def _v1(
        self, method: str, params: _JsonObject, *, write: bool = False, probe: bool = False
    ) -> object:
        request_id = uuid4().hex
        headers: list[tuple[bytes, bytes]] | None = None
        if self._api_key is not None:
            if self._api_key != self._api_key.strip() or any(
                ord(char) < 0x20 or ord(char) == 0x7F for char in self._api_key
            ):
                raise AnkiConnectError("authentication")
            try:
                headers = [(b"Authorization", f"Bearer {self._api_key}".encode())]
            except UnicodeError:
                raise AnkiConnectError("authentication") from None
        value = await self._post(
            "/api/v1",
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            headers=headers,
            write=write,
            probe=probe,
        )
        try:
            envelope = _object(value)
            if probe and set(envelope) == {"result", "error"} and envelope["result"] is None:
                legacy_error = envelope["error"]
                if isinstance(legacy_error, str):
                    first_line = legacy_error.partition("\n")[0].strip().lower()
                    if first_line in _LEGACY_PROBE_ERRORS:
                        raise _V1Unavailable
            if (
                envelope.get("jsonrpc") != "2.0"
                or envelope.get("id") != request_id
                or ("result" in envelope) == ("error" in envelope)
            ):
                raise AnkiConnectError("protocol_error")
            if "error" not in envelope:
                return envelope["result"]
            error = _v1_error(envelope["error"], write=write)
        except AnkiConnectError:
            raise AnkiConnectError("unknown_write" if write else "protocol_error") from None
        raise error

    def _legacy_payload(self, action: str, params: Mapping[str, object]) -> _JsonObject:
        body: _JsonObject = {"action": action, "version": 6, "params": dict(params)}
        if self._api_key is not None:
            body["key"] = self._api_key
        return body

    async def _legacy(self, action: str, params: _JsonObject, *, write: bool = False) -> object:
        value = await self._post("/", self._legacy_payload(action, params), write=write)
        try:
            return _legacy_result(value, write=write)
        except AnkiConnectError as error:
            if write and error.code == "protocol_error":
                raise AnkiConnectError("unknown_write") from None
            raise

    async def _post(
        self,
        path: str,
        payload: _JsonObject,
        *,
        headers: list[tuple[bytes, bytes]] | None = None,
        write: bool = False,
        probe: bool = False,
    ) -> object:
        url = self._base_url + path
        try:
            response = await self._client.post(
                url,
                json=payload,
                headers=headers,
                timeout=_TIMEOUT,
                follow_redirects=False,
                auth=httpx.Auth(),
            )
        except (
            httpx.ConnectError,
            httpx.ConnectTimeout,
            httpx.InvalidURL,
            httpx.PoolTimeout,
            httpx.UnsupportedProtocol,
        ):
            raise AnkiConnectError("unreachable") from None
        except httpx.RequestError:
            raise AnkiConnectError("unknown_write" if write else "unreachable") from None
        if probe and response.status_code == 404:
            raise _V1Unavailable
        if response.status_code in (401, 403):
            raise AnkiConnectError("authentication")
        if response.status_code == 413:
            raise AnkiConnectError("invalid_note")
        if response.status_code != 200:
            raise AnkiConnectError("unknown_write" if write else "protocol_error")
        try:
            return response.json()
        except ValueError:
            raise AnkiConnectError("unknown_write" if write else "protocol_error") from None
