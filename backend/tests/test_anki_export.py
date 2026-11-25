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
    AnkiSentenceFocus,
    AnkiSentenceRuby,
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
    def __init__(
        self,
        note_type: AnkiNoteType | None = _EXTERNAL,
        *,
        other_models: tuple[AnkiNoteType, ...] = (),
    ) -> None:
        self.endpoint = _ENDPOINT
        self.collection = AnkiCollection(protocol="v1", profile=_PROFILE, session="instance")
        self.model = note_type
        self.other_models = other_models
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

    def _models(self) -> tuple[AnkiNoteType, ...]:
        return self.other_models if self.model is None else (self.model, *self.other_models)

    async def list_note_types(self, collection: AnkiCollection) -> tuple[AnkiEntity, ...]:
        assert collection is self.collection
        self.calls.append("list_note_types")
        return tuple(AnkiEntity(model.id, model.name) for model in self._models())

    async def get_note_type(self, collection: AnkiCollection, model: AnkiEntity) -> AnkiNoteType:
        assert collection is self.collection
        self.calls.append("get_note_type")
        return next(
            item for item in self._models() if (item.id, item.name) == (model.id, model.name)
        )

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
        assert any(
            (note_type.id, note_type.name) == (model.id, model.name) for model in self._models()
        )
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
        assert any(
            (note_type.id, note_type.name) == (model.id, model.name) for model in self._models()
        )
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


@pytest.mark.parametrize("builtin_index", [0, 1, 2])
@pytest.mark.asyncio
async def test_builtin_exports_ruby_on_the_existing_sentence_field(builtin_index: int) -> None:
    builtins = get_builtins()
    builtin = builtins.note_types[builtin_index]
    gateway = _RecordingAnki(
        replace(
            _EXTERNAL,
            name=builtin.name,
            fields=tuple(builtin.fields),
            templates=tuple(
                AnkiTemplate(template.name, template.front, template.back)
                for template in builtin.card_templates
            ),
        )
    )
    sentence = "𠮷野 & <tag>\r\n[Sound:private.mp3]"
    request = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=builtin.name,
        builtin_type=AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version),
        fields=[
            AnkiExportField(
                id="sentence",
                type="text",
                target_field="Sentence",
                value=sentence,
                sentence_ruby=[AnkiSentenceRuby(start=0, end=2, reading='よしの"<>')],
            ),
            *([_text("word", "Word")] if "Word" in builtin.fields else []),
        ],
    )
    sent = await anki_export.export_note(gateway, request, builtins)

    assert sent.status == "created"
    assert "create_type" not in gateway.calls
    rendered = gateway.note_creations[0][1]["Sentence"]
    assert rendered.endswith(" &amp; &lt;tag&gt;<br>&#91;Sound:private.mp3]")
    assert len(gateway.validations) == 1
    assert gateway.validations[0][1]["Sentence"] == rendered
    style, markup = rendered.split("</style>", 1)
    assert ".fj>.fj-jp:only-child rt" in style
    assert ".fj>.fj-word:first-child+.fj-jp:last-child rt{display:none}" in style
    if builtin.fields[0] == "Sentence":
        assert "content:attr(data-reading)" in style
        assert markup.startswith(
            '<ruby>𠮷野<rt class="fj-sentence-ruby" '
            'data-reading="よしの&quot;&lt;&gt;"></rt></ruby>'
        )
        gateway.duplicate = True
        duplicate = await anki_export.export_note(gateway, request, builtins)
        assert duplicate.status == "duplicate"
        assert len(gateway.note_creations) == 1
    else:
        assert markup.startswith("<ruby>𠮷野<rt>よしの&quot;&lt;&gt;</rt></ruby>")


@pytest.mark.parametrize(
    "ruby",
    [
        [AnkiSentenceRuby(start=0, end=4, reading="よしの")],
        [
            AnkiSentenceRuby(start=0, end=2, reading="よしの"),
            AnkiSentenceRuby(start=1, end=3, reading="の"),
        ],
        [AnkiSentenceRuby(start=0, end=2, reading="\n")],
    ],
)
@pytest.mark.asyncio
async def test_invalid_ruby_fails_before_installing_or_creating_a_note(
    ruby: list[AnkiSentenceRuby],
) -> None:
    builtins = get_builtins()
    builtin = builtins.note_types[1]
    gateway = _RecordingAnki(note_type=None)
    request = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=builtin.name,
        builtin_type=AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version),
        install_builtin=True,
        fields=[
            AnkiExportField(
                id="sentence",
                type="text",
                target_field="Sentence",
                value="吉野。",
                sentence_ruby=ruby,
            )
        ],
    )
    result = await anki_export.export_note(gateway, request, builtins)

    assert (result.status, result.stage, result.field_id) == ("invalid", "validation", "sentence")
    assert gateway.model is None
    assert not gateway.note_creations


@pytest.mark.asyncio
async def test_sentence_metadata_has_no_effect_on_external_note_types() -> None:
    gateway = _RecordingAnki(replace(_EXTERNAL, fields=("Sentence",)))
    request = _request(
        AnkiExportField(
            id="sentence",
            type="text",
            target_field="Sentence",
            value="吉野。",
            sentence_focus=AnkiSentenceFocus(start=0, end=1, text="野"),
            sentence_ruby=[AnkiSentenceRuby(start=0, end=2, reading="よしの")],
        )
    )

    assert (await anki_export.export_note(gateway, request, get_builtins())).status == "created"
    assert gateway.note_creations[0][1] == {"Sentence": "吉野。"}


@pytest.mark.parametrize("builtin_index", [1, 2])
@pytest.mark.asyncio
async def test_focus_preserves_ruby_boundaries_and_the_duplicate_key(builtin_index: int) -> None:
    builtins = get_builtins()
    builtin = builtins.note_types[builtin_index]
    gateway = _RecordingAnki(note_type=None)
    request = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=builtin.name,
        builtin_type=AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version),
        install_builtin=True,
        fields=[
            AnkiExportField(
                id="sentence",
                type="text",
                target_field="Sentence",
                value="𠮷野と猫&< [Sound:clip.mp3]",
                sentence_focus=AnkiSentenceFocus(start=1, end=6, text="野と猫&<"),
                sentence_ruby=[
                    AnkiSentenceRuby(start=0, end=2, reading="よしの"),
                    AnkiSentenceRuby(start=3, end=4, reading="ねこ"),
                ],
            ),
            *([_text("word", "Word")] if "Word" in builtin.fields else []),
        ],
    )
    assert (await anki_export.export_note(gateway, request, builtins)).status == "created"
    rendered = gateway.note_creations[0][1]["Sentence"]
    style, markup = rendered.split("</style>", 1)
    assert "sentence-focus" not in style
    if builtin.fields[0] == "Sentence":
        yoshino = '<rt class="fj-sentence-ruby" data-reading="よしの"></rt>'
        neko = '<rt class="fj-sentence-ruby" data-reading="ねこ"></rt>'
        gateway.duplicate = True
        assert (await anki_export.export_note(gateway, request, builtins)).status == "duplicate"
        assert len(gateway.note_creations) == 1
    else:
        yoshino, neko = "<rt>よしの</rt>", "<rt>ねこ</rt>"
    assert markup == (
        f'<ruby>𠮷<span class="sentence-focus">野</span>{yoshino}</ruby>'
        '<span class="sentence-focus">と</span>'
        f'<span class="sentence-focus"><ruby>猫{neko}</ruby></span>'
        '<span class="sentence-focus">&amp;&lt;</span> &#91;Sound:clip.mp3]'
    )
    assert gateway.validations[0][1]["Sentence"] == rendered


@pytest.mark.parametrize(
    ("start", "end", "text", "created"),
    [
        (0, 4, "𠮷[So", True),
        (2, 18, "Sound:clip.mp3]\r", True),
        (2, 21, "Sound:clip.mp3]\r\n次", False),
        (1, 3, "So", False),
        (2, 2, "S", False),
        (17, 19, "\r\n", False),
    ],
)
@pytest.mark.asyncio
async def test_focus_validates_against_exact_sentence_text(
    start: int, end: int, text: str, created: bool
) -> None:
    builtins = get_builtins()
    builtin = builtins.note_types[1]
    gateway = _RecordingAnki(note_type=None)
    sentence = "𠮷[Sound:clip.mp3]\r\n次"
    result = await anki_export.export_note(
        gateway,
        AnkiExportInput(
            endpoint=_ENDPOINT,
            profile=_PROFILE,
            deck=_DECK.name,
            note_type=builtin.name,
            builtin_type=AnkiBuiltinNoteTypeRef(id=builtin.id, version=builtin.version),
            install_builtin=True,
            fields=[
                AnkiExportField(
                    id="sentence",
                    type="text",
                    target_field="Sentence",
                    value=sentence,
                    sentence_focus=AnkiSentenceFocus(start=start, end=end, text=text),
                )
            ],
        ),
        builtins,
    )
    if created:
        assert result.status == "created"
        rendered = gateway.note_creations[0][1]["Sentence"]
        assert "<style>" not in rendered
        assert "[Sound:" not in rendered
        assert rendered.count("<br>") == 1
    else:
        assert (result.status, result.stage, result.field_id) == (
            "invalid",
            "validation",
            "sentence",
        )
        assert gateway.model is None
        assert not gateway.note_creations


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
async def test_vocabulary_preset_installs_v2_alongside_existing_v1() -> None:
    builtins = get_builtins()
    preset = next(item for item in builtins.export_presets if item.id == "export.vocabulary")
    ref = preset.note_type_ref
    current = next(item for item in builtins.note_types if (item.id, item.version) == (ref.id, 2))
    legacy = next(item for item in builtins.note_types if (item.id, item.version) == (ref.id, 1))
    edited_legacy = AnkiNoteType(
        id="70",
        name=legacy.name,
        fields=tuple(legacy.fields),
        templates=tuple(
            AnkiTemplate(item.name, item.front, item.back + "<!-- My template edit -->")
            for item in legacy.card_templates
        ),
        css=".card { color: red }",
        kind="normal",
    )
    gateway = _RecordingAnki(note_type=None, other_models=(edited_legacy,))
    check = AnkiBuiltinCheckInput(endpoint=_ENDPOINT, profile=_PROFILE, builtin_type=ref)
    assert (await anki_export.check_builtin(gateway, check, builtins)).status == "missing"

    word, reading, part_of_speech, meaning, sentence, sentence_meaning = preset.fields[:6]
    assert (reading.target_field, reading.presentation) == ("Reading", "common")
    assert (
        part_of_speech.label,
        part_of_speech.target_field,
        part_of_speech.required,
        part_of_speech.presentation,
    ) == ("词性", "PartOfSpeech", False, "common")
    assert (meaning.label, meaning.target_field, meaning.required) == ("词汇释义", "Meaning", True)
    assert (sentence_meaning.label, sentence_meaning.target_field, sentence_meaning.required) == (
        "例句释义",
        "SentenceMeaning",
        False,
    )
    draft = AnkiExportInput(
        endpoint=_ENDPOINT,
        profile=_PROFILE,
        deck=_DECK.name,
        note_type=current.name,
        builtin_type=ref,
        fields=[
            AnkiExportField(
                id=definition.id,
                type=definition.type,
                target_field=definition.target_field,
                required=definition.required,
                value=value,
            )
            for definition, value in zip(
                (word, meaning, sentence, sentence_meaning),
                ("取る", "撇去", "灰汁を取る", None),
                strict=True,
            )
        ],
    )
    assert (
        await anki_export.export_note(gateway, draft, builtins)
    ).status == "installation_required"
    invalid = draft.model_copy(
        update={"fields": [draft.fields[0], draft.fields[1].model_copy(update={"value": " "})]}
    )
    rejection = await anki_export.export_note(gateway, invalid, builtins)
    assert (rejection.status, rejection.field_id) == ("invalid", meaning.id)
    assert "create_type" not in gateway.calls

    confirmed = draft.model_copy(update={"install_builtin": True})
    sent = await anki_export.export_note(gateway, confirmed, builtins)
    assert sent.status == "created" and sent.type_created
    assert gateway.note_creations[-1][1]["SentenceMeaning"] == ""
    assert gateway.note_creations[-1][1]["PartOfSpeech"] == ""
    assert (await anki_export.check_builtin(gateway, check, builtins)).status == "compatible"

    short_explanation = draft.fields[3].model_copy(update={"value": "撇去浮沫 <后> 再盛汤"})
    filled = draft.model_copy(
        update={
            "fields": [
                *draft.fields[:3],
                short_explanation,
                AnkiExportField(
                    id=part_of_speech.id,
                    type=part_of_speech.type,
                    target_field=part_of_speech.target_field,
                    value="动词 & <五段>",
                ),
            ]
        }
    )
    assert (await anki_export.export_note(gateway, filled, builtins)).status == "created"
    assert gateway.note_creations[-1][1]["SentenceMeaning"] == "撇去浮沫 &lt;后&gt; 再盛汤"
    assert gateway.note_creations[-1][1]["PartOfSpeech"] == "动词 &amp; &lt;五段&gt;"

    old_ref = AnkiBuiltinNoteTypeRef(id=legacy.id, version=legacy.version)
    old_check = check.model_copy(update={"builtin_type": old_ref})
    assert (await anki_export.check_builtin(gateway, old_check, builtins)).status == "compatible"
    old_draft = draft.model_copy(
        update={
            "builtin_type": old_ref,
            "note_type": edited_legacy.name,
            "fields": [
                *draft.fields[:2],
                draft.fields[2].model_copy(
                    update={"sentence_focus": AnkiSentenceFocus(start=3, end=5, text="取る")}
                ),
            ],
        }
    )
    assert (await anki_export.export_note(gateway, old_draft, builtins)).status == "created"
    assert "SentenceMeaning" not in gateway.note_creations[-1][1]
    assert "PartOfSpeech" not in gateway.note_creations[-1][1]
    assert gateway.note_creations[-1][1]["Sentence"] == "灰汁を取る"
    assert (
        await gateway.get_note_type(gateway.collection, AnkiEntity("70", legacy.name))
        is edited_legacy
    )
    assert gateway.calls.count("create_type") == 1


@pytest.mark.asyncio
async def test_unbundled_builtin_version_cannot_be_checked_or_installed() -> None:
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
