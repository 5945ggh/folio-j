import base64
import json
from dataclasses import replace
from typing import Literal

import pytest
from pydantic import ValidationError

from app.anki_builtins import get_builtins
from app.anki_export_schemas import (
    MAX_ANKI_MEDIA_BYTES,
    AnkiBuiltinCheckInput,
    AnkiExportAttachment,
    AnkiExportField,
    AnkiExportInput,
)
from app.anki_settings_schemas import AnkiBuiltinNoteTypeRef
from app.services import anki_export
from app.services.anki_connect import (
    AnkiCollection,
    AnkiConnect,
    AnkiConnectError,
    AnkiEntity,
    AnkiNoteCreated,
    AnkiNoteType,
    AnkiTemplate,
)

_ENDPOINT = "http://127.0.0.1:8765"
_PROFILE = "品詞"
_DECK = AnkiEntity(id="14", name="日语::阅读")
_EXTERNAL = AnkiNoteType(
    id="57",
    name="阅读",
    fields=("Front", "Back", "Picture", "Audio", "Video"),
    templates=(),
    css="",
    kind="normal",
)
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+n7FkAAAAASUVORK5CYII="
)
_MP3 = b"\xff\xfb\x90\x00" + b"\0" * 413
_MP4 = b"\x00\x00\x00\x18ftypisom\0\0\0\0isommp42"


class _RecordingAnki(AnkiConnect):
    def __init__(self, note_type: AnkiNoteType | None = _EXTERNAL) -> None:
        self.endpoint = _ENDPOINT
        self.collection = AnkiCollection(protocol="v1", profile=_PROFILE, session="instance")
        self.model = note_type
        self.calls: list[str] = []
        self.validations: list[tuple[bool, dict[str, str]]] = []
        self.note_creations: list[tuple[bool, dict[str, str]]] = []
        self.upload_attempts: list[str] = []
        self.media: dict[str, tuple[str, bytes]] = {}
        self.duplicate = False
        self.rejected_note = False
        self.media_error: Literal["unreachable", "unknown_write"] | None = None
        self.note_result_unknown = False

    async def probe(self) -> AnkiCollection:
        self.calls.append("probe")
        return self.collection

    async def list_decks(self, collection: AnkiCollection) -> tuple[AnkiEntity, ...]:
        assert collection is self.collection
        self.calls.append("list_decks")
        return (_DECK,)

    async def list_note_types(self, collection: AnkiCollection) -> tuple[AnkiEntity, ...]:
        assert collection is self.collection
        self.calls.append("list_note_types")
        return (AnkiEntity(self.model.id, self.model.name),) if self.model is not None else ()

    async def get_note_type(self, collection: AnkiCollection, model: AnkiEntity) -> AnkiNoteType:
        assert collection is self.collection
        self.calls.append("get_note_type")
        assert self.model is not None
        assert model == AnkiEntity(self.model.id, self.model.name)
        return self.model

    async def create_note_type(
        self,
        collection: AnkiCollection,
        *,
        name: str,
        fields: tuple[str, ...],
        templates: tuple[AnkiTemplate, ...],
        css: str,
    ) -> AnkiNoteType:
        assert collection is self.collection
        self.calls.append("create_type")
        assert self.model is None
        self.model = AnkiNoteType(
            id="91", name=name, fields=fields, templates=templates, css=css, kind="normal"
        )
        return self.model

    async def validate_note(
        self,
        collection: AnkiCollection,
        *,
        deck: AnkiEntity,
        note_type: AnkiEntity,
        fields: dict[str, str],
        allow_duplicate: bool = False,
    ) -> None:
        assert collection is self.collection
        assert deck == _DECK
        assert self.model is not None and note_type.id == self.model.id
        self.calls.append("validate")
        self.validations.append((allow_duplicate, fields.copy()))
        if self.duplicate and not allow_duplicate:
            raise AnkiConnectError("duplicate")
        if self.rejected_note:
            raise AnkiConnectError("invalid_note")

    async def create_note(
        self,
        collection: AnkiCollection,
        *,
        deck: AnkiEntity,
        note_type: AnkiEntity,
        fields: dict[str, str],
        allow_duplicate: bool = False,
    ) -> AnkiNoteCreated:
        assert collection is self.collection
        assert deck == _DECK
        assert self.model is not None and note_type.id == self.model.id
        self.calls.append("create_note")
        self.note_creations.append((allow_duplicate, fields.copy()))
        if self.note_result_unknown:
            raise AnkiConnectError("unknown_write")
        return AnkiNoteCreated(note_id="102", card_ids=("103", "104"))

    async def store_media(self, collection: AnkiCollection, *, filename: str, data: bytes) -> str:
        assert collection is self.collection
        self.calls.append("media")
        self.upload_attempts.append(filename)
        extension = filename.rsplit(".", 1)[1]
        if self.media_error is not None and extension in ("mp3", "mp4"):
            raise AnkiConnectError(self.media_error)
        if filename not in self.media:
            self.media[filename] = (f"actual-{len(self.media)}.{extension}", data)
        return self.media[filename][0]


def _text(id: str, target: str | None, value: str | None = "灰汁") -> AnkiExportField:
    return AnkiExportField(id=id, type="text", target_field=target, value=value, required=True)


def _media(
    kind: Literal["audio", "image", "video"], target: str, name: str, data: bytes
) -> AnkiExportField:
    return AnkiExportField(
        id=target.lower(),
        type=kind,
        target_field=target,
        value=AnkiExportAttachment(name=name, data_base64=base64.b64encode(data).decode()),
    )


def _request(*fields: AnkiExportField) -> AnkiExportInput:
    return AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        deck_id=_DECK.id,
        note_type=_EXTERNAL.name,
        note_type_id=_EXTERNAL.id,
        fields=list(fields),
    )


def test_permissions_require_explicit_json_booleans() -> None:
    valid = _request(_text("word", "Front"))
    for flag in ("allow_duplicate", "install_builtin"):
        with pytest.raises(ValidationError):
            AnkiExportInput.model_validate({**valid.model_dump(), flag: "true"})


def test_maximum_attachment_fits_base64_upload_in_v1_request_limit() -> None:
    wire = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": "request",
            "method": "media.store",
            "params": {
                "session": "collection",
                "filename": f"folioj-{'0' * 64}.mp4",
                "source": {"data": ""},
                "collision": "rename",
            },
        }
    )
    base64_length = 4 * ((MAX_ANKI_MEDIA_BYTES + 2) // 3)
    assert len(wire) + base64_length < 16 * 1024 * 1024


@pytest.mark.asyncio
async def test_send_validates_once_and_preserves_plain_text_and_actual_card_ids() -> None:
    gateway = _RecordingAnki()
    request = _request(
        _text("word", "Front"),
        _text("back", "Back", '<script>\r\n[Sound:private.mp3]\r猫 & "犬"'),
        _media("image", "Picture", "図.PNG", _PNG),
        _media("audio", "Audio", "読み.mp3", _MP3),
        _media("video", "Video", "clip.mp4", _MP4),
        AnkiExportField(id="unmapped", type="text", value="Do not send"),
    )
    result = await anki_export.export_note(gateway, request, get_builtins())

    assert result.status == "created"
    assert result.note_id == "102"
    assert result.card_ids == ["103", "104"]
    assert result.uploaded_media == ["actual-0.png", "actual-1.mp3", "actual-2.mp4"]
    assert [data for _, data in gateway.media.values()] == [_PNG, _MP3, _MP4]
    assert gateway.calls[-5:] == ["validate", "media", "media", "media", "create_note"]
    assert gateway.note_creations == [
        (
            False,
            {
                "Front": "灰汁",
                "Back": "&lt;script&gt;<br>&#91;Sound:private.mp3]<br>猫 &amp; &quot;犬&quot;",
                "Picture": '<img src="actual-0.png">',
                "Audio": "[sound:actual-1.mp3]",
                "Video": "[sound:actual-2.mp4]",
            },
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("bad", "field_id"),
    [
        (_text("word", "Back"), "word"),
        (AnkiExportField(id="word", type="audio"), "word"),
        (_text("second", "Front"), "second"),
        (_text("changed", "Removed"), "changed"),
        (_text("unmapped", None), "unmapped"),
        (_text("blank", "Back", " \n"), "blank"),
        (_media("audio", "Audio", "not-audio.mp3", _PNG), "audio"),
        (_media("audio", "Audio", "../relative-path.mp3", _MP3), "audio"),
        (_media("video", "Video", "other.png", _PNG), "video"),
        (
            AnkiExportField(
                id="bad-base64",
                type="audio",
                target_field="Audio",
                value=AnkiExportAttachment(name="corrupted.mp3", data_base64="not-base64!"),
            ),
            "bad-base64",
        ),
    ],
)
async def test_bad_mapping_or_attachment_rejects_before_upload(
    bad: AnkiExportField, field_id: str
) -> None:
    gateway = _RecordingAnki()
    request = _request(_text("word", "Front"), _media("image", "Picture", "pic.png", _PNG), bad)
    result = await anki_export.export_note(gateway, request, get_builtins())
    assert (result.status, result.field_id) == ("invalid", field_id)
    assert "validate" not in gateway.calls
    assert gateway.upload_attempts == gateway.note_creations == []


@pytest.mark.asyncio
async def test_attachment_budget_is_checked_before_any_upload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(anki_export, "MAX_ANKI_EXPORT_MEDIA_BYTES", len(_PNG) + len(_MP3) - 1)
    gateway = _RecordingAnki()
    request = _request(
        _text("word", "Front"),
        _media("image", "Picture", "pic.png", _PNG),
        _media("audio", "Audio", "word.mp3", _MP3),
    )
    result = await anki_export.export_note(gateway, request, get_builtins())
    assert (result.status, result.field_id) == ("invalid", "audio")
    assert gateway.upload_attempts == []


@pytest.mark.asyncio
async def test_unmapped_optional_values_do_not_count_toward_attachment_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(anki_export, "MAX_ANKI_EXPORT_MEDIA_BYTES", len(_PNG))
    gateway = _RecordingAnki()
    unused_media = _media("audio", "Audio", "word.mp3", _MP3).model_copy(
        update={"target_field": None}
    )
    unused_text = AnkiExportField.model_validate(
        {"id": "unmapped", "type": "text", "value": {"unrelated": "content"}}
    )
    request = _request(
        _text("word", "Front"),
        unused_media,
        unused_text,
        _media("image", "Picture", "pic.png", _PNG),
    )
    result = await anki_export.export_note(gateway, request, get_builtins())
    assert result.status == "created"
    assert result.uploaded_media == ["actual-0.png"]
    assert gateway.note_creations[0][1]["Audio"] == ""
    assert unused_text.value is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("guard", "value", "last_call"),
    [
        ("endpoint", "http://127.0.0.1:18765", None),
        ("profile", "other", "probe"),
        ("deck_id", "700", "list_decks"),
        ("note_type_id", "701", "list_note_types"),
    ],
)
async def test_target_scope_and_identity_are_checked_for_each_send(
    guard: str, value: str, last_call: str | None
) -> None:
    gateway = _RecordingAnki()
    request = _request(_text("word", "Front")).model_copy(update={guard: value})
    result = await anki_export.export_note(gateway, request, get_builtins())
    assert result.status == "target_changed"
    assert (gateway.calls[-1] if gateway.calls else None) == last_call


@pytest.mark.asyncio
async def test_duplicate_is_validated_without_media_and_only_explicit_override_reaches_write() -> (
    None
):
    gateway = _RecordingAnki()
    gateway.duplicate = True
    request = _request(_text("word", "Front"), _media("image", "Picture", "pic.png", _PNG))
    result = await anki_export.export_note(gateway, request, get_builtins())
    assert result.status == "duplicate"
    assert gateway.upload_attempts == gateway.note_creations == []

    allowed = await anki_export.export_note(
        gateway, request.model_copy(update={"allow_duplicate": True}), get_builtins()
    )
    assert allowed.status == "created"
    assert [choice for choice, _ in gateway.validations] == [False, True]
    assert [choice for choice, _ in gateway.note_creations] == [True]


@pytest.mark.asyncio
async def test_partial_media_can_be_reused_and_unknown_note_write_is_never_repeated() -> None:
    gateway = _RecordingAnki()
    gateway.media_error = "unreachable"
    request = _request(
        _text("word", "Front"),
        _media("image", "Picture", "pic.png", _PNG),
        _media("audio", "Audio", "word.mp3", _MP3),
    )
    failed = await anki_export.export_note(gateway, request, get_builtins())
    assert (failed.status, failed.stage) == ("failed", "media")
    assert failed.uploaded_media == ["actual-0.png"]
    assert failed.media_may_remain
    assert gateway.note_creations == []

    gateway.media_error = None
    gateway.note_result_unknown = True
    unknown = await anki_export.export_note(gateway, request, get_builtins())
    assert (unknown.status, unknown.stage) == ("unknown", "note")
    assert unknown.media_may_remain
    assert unknown.uploaded_media == ["actual-0.png", "actual-1.mp3"]
    assert gateway.upload_attempts[:2] == gateway.upload_attempts[2:]
    assert len(gateway.media) == 2
    assert len(gateway.note_creations) == 1


@pytest.mark.asyncio
async def test_unconfirmed_first_media_write_warns_even_without_uploaded_name() -> None:
    gateway = _RecordingAnki()
    gateway.media_error = "unknown_write"
    request = _request(_text("word", "Front"), _media("audio", "Audio", "word.mp3", _MP3))
    result = await anki_export.export_note(gateway, request, get_builtins())
    assert (result.status, result.stage) == ("failed", "media")
    assert result.uploaded_media == []
    assert result.media_may_remain
    assert gateway.note_creations == []


@pytest.mark.asyncio
async def test_builtin_install_requires_confirmation_and_keeps_existing_custom_css() -> None:
    gateway = _RecordingAnki(note_type=None)
    builtins = get_builtins()
    builtin = builtins.note_types[0]
    ref = AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version)
    check = AnkiBuiltinCheckInput(endpoint=_ENDPOINT, profile=_PROFILE, builtin_type=ref)
    draft = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=builtin.name,
        builtin_type=ref,
        fields=[_text("word", "Word"), _text("meaning", "Meaning", "浮沫")],
    )
    assert (await anki_export.check_builtin(gateway, check, builtins)).status == "missing"
    assert (
        await anki_export.export_note(gateway, draft, builtins)
    ).status == "installation_required"
    assert "create_type" not in gateway.calls

    confirmed = draft.model_copy(update={"install_builtin": True})
    bad = confirmed.model_copy(update={"fields": [_text("word", "Removed")]})
    assert (await anki_export.export_note(gateway, bad, builtins)).status == "invalid"
    assert "create_type" not in gateway.calls

    gateway.rejected_note = True
    failed = await anki_export.export_note(gateway, confirmed, builtins)
    assert failed.status == "invalid"
    assert failed.type_created
    assert gateway.calls[-2:] == ["create_type", "validate"]
    assert gateway.model is not None
    assert gateway.model.css == builtins.shared_css

    gateway.rejected_note = False
    gateway.model = replace(gateway.model, css=".card { color: red }")
    assert (await anki_export.check_builtin(gateway, check, builtins)).status == "compatible"
    sent = await anki_export.export_note(gateway, draft, builtins)
    assert sent.status == "created" and not sent.type_created
    assert gateway.calls.count("create_type") == 1
    assert gateway.model.css == ".card { color: red }"


@pytest.mark.asyncio
async def test_same_name_without_identity_is_never_replaced() -> None:
    builtins = get_builtins()
    builtin = builtins.note_types[0]
    gateway = _RecordingAnki(replace(_EXTERNAL, name=builtin.name, fields=tuple(builtin.fields)))
    ref = AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version)
    check = AnkiBuiltinCheckInput(endpoint=_ENDPOINT, profile=_PROFILE, builtin_type=ref)
    request = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=builtin.name,
        builtin_type=ref,
        install_builtin=True,
        fields=[_text("word", "Word"), _text("meaning", "Meaning", "浮沫")],
    )
    assert (await anki_export.check_builtin(gateway, check, builtins)).status == "incompatible"
    assert (await anki_export.export_note(gateway, request, builtins)).status == "incompatible_type"
    assert gateway.calls[-1] == "get_note_type"
    assert "create_type" not in gateway.calls


@pytest.mark.asyncio
async def test_superseded_builtin_version_cannot_be_checked_or_installed() -> None:
    builtins = get_builtins()
    builtin = builtins.note_types[0]
    current = builtins.model_copy(
        update={"note_types": [builtin.model_copy(update={"version": builtin.version + 1})]}
    )
    gateway = _RecordingAnki(note_type=None)
    old_ref = AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version)
    check = AnkiBuiltinCheckInput(endpoint=_ENDPOINT, profile=_PROFILE, builtin_type=old_ref)
    request = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=builtin.name,
        builtin_type=old_ref,
        install_builtin=True,
        fields=[_text("word", "Word"), _text("meaning", "Meaning", "浮沫")],
    )
    checked = await anki_export.check_builtin(gateway, check, current)
    sent = await anki_export.export_note(gateway, request, current)
    assert checked.status == sent.status == "target_changed"
    assert sent.stage == "target"
    assert checked.message == sent.message
    assert gateway.calls == []
