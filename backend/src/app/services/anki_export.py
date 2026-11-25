"""Validate and send one transient draft to the active Anki collection."""

import base64
import binascii
import hashlib
import html
import re
from dataclasses import dataclass
from typing import Literal

from app.anki_builtins import AnkiBuiltins, BuiltinNoteType
from app.anki_export_schemas import (
    MAX_ANKI_EXPORT_MEDIA_BYTES,
    MAX_ANKI_MEDIA_BYTES,
    AnkiBuiltinCheckInput,
    AnkiBuiltinCheckResponse,
    AnkiExportAttachment,
    AnkiExportField,
    AnkiExportInput,
    AnkiExportResponse,
    AnkiExportStage,
    AnkiExportStatus,
    AnkiSentenceFocus,
    AnkiSentenceRuby,
)
from app.anki_settings_schemas import AnkiBuiltinNoteTypeRef
from app.services.anki_connect import (
    AnkiCollection,
    AnkiConnect,
    AnkiConnectError,
    AnkiEntity,
    AnkiNoteType,
    AnkiTemplate,
    connection_error_message,
)

_MediaKind = Literal["audio", "image", "video"]
_MEDIA_TYPES: dict[str, _MediaKind] = {
    "mp3": "audio",
    "png": "image",
    "jpg": "image",
    "jpeg": "image",
    "mp4": "video",
}
_SAFE_MEDIA_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}")
_TEXT_MEDIA_MARKER = re.compile(r"\[(?=sound:)", flags=re.IGNORECASE)
# Earlier installed templates can lack the question class. On those templates, only
# the front contains just the sentence, or the headword followed by the sentence.
_LEGACY_QUESTION_RUBY_CSS = (
    ".fj>.fj-jp:only-child rt,.fj>.fj-word:first-child+.fj-jp:last-child rt{display:none}"
)
_FIRST_FIELD_RUBY_CSS = "rt.fj-sentence-ruby::before{content:attr(data-reading)}"
_SENTENCE_FOCUS_TYPES = {("folio-j.vocabulary-recall", 2), ("folio-j.sentence-reading", 1)}


class _ExportError(Exception):
    def __init__(self, status: AnkiExportStatus, message: str, field_id: str | None = None) -> None:
        super().__init__(message)
        self.status: AnkiExportStatus = status
        self.message = message
        self.field_id = field_id


@dataclass(frozen=True)
class _Media:
    kind: _MediaKind
    filename: str
    data: bytes

    def reference(self, filename: str) -> str:
        if self.kind == "image":
            return f'<img src="{filename}">'
        return f"[sound:{filename}]"


async def _checked_collection(gateway: AnkiConnect, endpoint: str, profile: str) -> AnkiCollection:
    if endpoint != gateway.endpoint:
        raise _ExportError("target_changed", "Anki 连接地址已变更，请重新核对目标。")
    collection = await gateway.probe()
    if profile != collection.profile:
        raise _ExportError("target_changed", "Anki 活动配置已变更，请重新核对目标。")
    return collection


def _find_entity(
    entries: tuple[AnkiEntity, ...], name: str, entity_id: str | None
) -> AnkiEntity | None:
    entity = next((entry for entry in entries if entry.name == name), None)
    if entity_id is not None and (entity is None or entity.id != entity_id):
        raise _ExportError("target_changed", "Anki 目标已变更，请重新选择。")
    return entity


def _find_builtin(builtins: AnkiBuiltins, ref: AnkiBuiltinNoteTypeRef) -> BuiltinNoteType:
    for builtin in builtins.note_types:
        if builtin.id == ref.id and builtin.version == ref.version:
            return builtin
    if any(builtin.id == ref.id for builtin in builtins.note_types):
        raise _ExportError("target_changed", "此内置笔记类型版本不可用，请重新选择。")
    raise _ExportError("invalid", "未找到该内置笔记类型。")


def _builtin_compatible(actual: AnkiNoteType, builtin: BuiltinNoteType) -> bool:
    if actual.kind != "normal" or not set(builtin.fields).issubset(actual.fields):
        return False
    identity = re.escape(f"{builtin.id}@{builtin.version}")
    marker = re.compile(rf"<!--\s*{identity}\s*-->")
    return all(
        any(
            template.name == shipped.name
            and marker.search(template.question_html) is not None
            and marker.search(template.answer_html) is not None
            for template in actual.templates
        )
        for shipped in builtin.card_templates
    )


def _incompatible() -> _ExportError:
    return _ExportError("incompatible_type", "同名笔记类型与内置模板不兼容。")


async def check_builtin(
    gateway: AnkiConnect, request: AnkiBuiltinCheckInput, builtins: AnkiBuiltins
) -> AnkiBuiltinCheckResponse:
    try:
        builtin = _find_builtin(builtins, request.builtin_type)
        collection = await _checked_collection(gateway, request.endpoint, request.profile)
        model = _find_entity(
            await gateway.list_note_types(collection), request.note_type or builtin.name, None
        )
        if model is None:
            return AnkiBuiltinCheckResponse(status="missing")
        if _builtin_compatible(await gateway.get_note_type(collection, model), builtin):
            return AnkiBuiltinCheckResponse(status="compatible")
        return AnkiBuiltinCheckResponse(status="incompatible", message=_incompatible().message)
    except _ExportError as error:
        return AnkiBuiltinCheckResponse(
            status="target_changed" if error.status == "target_changed" else "failed",
            message=error.message,
        )
    except AnkiConnectError as error:
        return AnkiBuiltinCheckResponse(
            status="target_changed" if error.code == "stale_session" else "failed",
            message=connection_error_message(error),
        )


def _is_mp3(data: bytes) -> bool:
    start = 0
    if data.startswith(b"ID3"):
        if len(data) < 10 or data[3] not in (2, 3, 4) or any(b & 0x80 for b in data[6:10]):
            return False
        for part in data[6:10]:
            start = (start << 7) | part
        start += 10
        if data[3] == 4 and data[5] & 0x10:  # ID3v2.4 footer
            start += 10
    if len(data) < start + 4:
        return False
    sync, version_layer, bitrate_sampling, _ = data[start : start + 4]
    return (
        sync == 0xFF
        and version_layer & 0xE6 == 0xE2  # Sync word and layer III.
        and version_layer & 0x18 != 0x08
        and bitrate_sampling & 0xF0 != 0xF0
        and bitrate_sampling & 0x0C != 0x0C
    )


def _is_mp4(data: bytes) -> bool:
    if len(data) < 16 or data[4:8] != b"ftyp":
        return False
    box_end = int.from_bytes(data[:4], "big")
    if box_end < 16 or box_end > len(data) or box_end % 4:
        return False
    brands = {b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"dash"}
    return data[8:12] in brands or any(
        data[offset : offset + 4] in brands for offset in range(16, box_end, 4)
    )


def _matches_format(extension: str, data: bytes) -> bool:
    if extension == "mp3":
        return _is_mp3(data)
    if extension == "mp4":
        return _is_mp4(data)
    if extension == "png":
        return (
            len(data) >= 45
            and data.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")
            and data.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82")
        )
    return len(data) >= 8 and data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9")


def _attachment(
    field: AnkiExportField, value: AnkiExportAttachment, remaining_bytes: int
) -> _Media:
    name = value.name
    stem, _, suffix = name.rpartition(".")
    extension = suffix.lower()
    kind = _MEDIA_TYPES.get(extension)
    if not stem or kind is None or kind != field.type or re.search(r"[/\\\x00-\x1f\x7f]", name):
        raise _ExportError("invalid", "请选择与字段匹配的 MP3、PNG、JPEG 或 MP4 文件。", field.id)

    encoded = value.data_base64
    # Check the request budget before allocating a second copy of the file.
    size = len(encoded) // 4 * 3
    size -= 2 if encoded.endswith("==") else int(encoded.endswith("="))
    if size > remaining_bytes or size > MAX_ANKI_MEDIA_BYTES:
        raise _ExportError("invalid", "单个附件限 11 MiB，每次发送的附件合计限 24 MiB。", field.id)
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise _ExportError("invalid", "附件数据无法读取。", field.id) from error
    if not _matches_format(extension, data):
        raise _ExportError("invalid", "文件内容与所选媒体格式不符。", field.id)

    # A retry with the same bytes asks Anki for the same name using its keep/rename behavior.
    digest = hashlib.sha256(data).hexdigest()
    canonical_extension = "jpg" if extension == "jpeg" else extension
    return _Media(kind, f"folioj-{digest}.{canonical_extension}", data)


def _plain_text(value: str) -> str:
    # Anki recognizes sound markers independently of HTML markup.
    escaped = html.escape(value)
    return (
        _TEXT_MEDIA_MARKER.sub("&#91;", escaped)
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "<br>")
    )


def _sentence_html(
    value: str,
    annotations: list[AnkiSentenceRuby],
    focus: AnkiSentenceFocus | None,
    field_id: str,
    *,
    first_field: bool,
) -> str:
    if focus is not None and (
        not focus.start < focus.end <= len(value)
        or not focus.text.strip()
        or value[focus.start : focus.end] != focus.text
    ):
        raise _ExportError("invalid", "原句强调与正文范围不匹配。", field_id)

    def escape_part(text: str) -> str:
        # A marker can straddle two slices, so escape brackets in each part.
        return _plain_text(text).replace("[", "&#91;")

    def escape_range(start: int, end: int) -> str:
        part = value[start:end]
        if value[end : end + 1] == "\n":
            part = part.removesuffix("\r")  # A sliced CRLF still renders as one line break.
        return escape_part(part)

    def mark_focus(content: str) -> str:
        return f'<span class="sentence-focus">{content}</span>'

    def render_base(start: int, end: int) -> str:
        if focus is None or start == end or end <= focus.start or focus.end <= start:
            return escape_range(start, end)
        marked_start = max(start, focus.start)
        marked_end = min(end, focus.end)
        return (
            escape_range(start, marked_start)
            + mark_focus(escape_range(marked_start, marked_end))
            + escape_range(marked_end, end)
        )

    # Anki strips CSS and HTML tags for duplicate detection but keeps <rt> text.
    # Store the reading in an attribute when the annotated sentence is the duplicate key.
    parts: list[str] = []
    if annotations:
        css = _LEGACY_QUESTION_RUBY_CSS + (_FIRST_FIELD_RUBY_CSS if first_field else "")
        parts.append(f"<style>{css}</style>")
    consumed = 0
    for annotation in annotations:
        start, end, reading = annotation.start, annotation.end, annotation.reading
        base = value[start:end]
        if (
            not consumed <= start < end <= len(value)
            or not base.strip()
            or not reading.strip()
            or "\r" in base + reading
            or "\n" in base + reading
        ):
            raise _ExportError("invalid", "例句注音与正文范围不匹配。", field_id)
        parts.append(render_base(consumed, start))
        escaped_reading = escape_part(reading)
        rt = (
            f'<rt class="fj-sentence-ruby" data-reading="{escaped_reading}"></rt>'
            if first_field
            else f"<rt>{escaped_reading}</rt>"
        )
        if focus is not None and focus.start <= start and end <= focus.end:
            parts.append(mark_focus(f"<ruby>{escape_range(start, end)}{rt}</ruby>"))
        else:
            parts.append(f"<ruby>{render_base(start, end)}{rt}</ruby>")
        consumed = end
    parts.append(render_base(consumed, len(value)))
    return "".join(parts)


def _prepare_fields(
    entries: list[AnkiExportField], model_fields: tuple[str, ...], builtin: BuiltinNoteType | None
) -> tuple[dict[str, str], dict[str, _Media]]:
    if not model_fields:
        raise _ExportError("invalid", "Anki 笔记类型没有可填写的字段。")
    ids: set[str] = set()
    targets: dict[str, str] = {}
    fields = dict.fromkeys(model_fields, "")
    media: dict[str, _Media] = {}
    remaining_bytes = MAX_ANKI_EXPORT_MEDIA_BYTES
    supports_focus = builtin is not None and (builtin.id, builtin.version) in _SENTENCE_FOCUS_TYPES

    for entry in entries:
        if entry.id in ids:
            raise _ExportError("invalid", "草稿中存在重复的应用字段。", entry.id)
        ids.add(entry.id)
        target = entry.target_field
        if target is None:
            if entry.required:
                raise _ExportError("invalid", "必填字段须映射到 Anki 字段。", entry.id)
            continue
        if target not in fields:
            raise _ExportError("invalid", "映射的 Anki 字段已不存在。", entry.id)
        if target in targets:
            raise _ExportError("invalid", "一个 Anki 字段只能接收一个应用字段。", entry.id)
        targets[target] = entry.id

        value = entry.value
        annotate_sentence = builtin is not None and target == "Sentence"
        focus = entry.sentence_focus if supports_focus and annotate_sentence else None
        if focus is not None and (entry.type != "text" or not isinstance(value, str)):
            raise _ExportError("invalid", "原句强调与正文范围不匹配。", entry.id)
        text_value = ""
        if value is not None:
            if entry.type == "text" and isinstance(value, str):
                has_ruby = annotate_sentence and bool(entry.sentence_ruby)
                if focus is not None or (has_ruby and value.strip()):
                    text_value = _sentence_html(
                        value,
                        entry.sentence_ruby,
                        focus,
                        entry.id,
                        first_field=target == model_fields[0],
                    )
                elif value.strip():
                    text_value = _plain_text(value)
            elif entry.type != "text" and isinstance(value, AnkiExportAttachment):
                attachment = _attachment(entry, value, remaining_bytes)
                remaining_bytes -= len(attachment.data)
                media[target] = attachment
                text_value = attachment.reference(attachment.filename)
            else:
                raise _ExportError("invalid", "字段值与类型不匹配。", entry.id)
        if entry.required and not text_value:
            raise _ExportError("invalid", "请填写必填字段。", entry.id)
        fields[target] = text_value

    first_field = model_fields[0]
    if not fields[first_field]:
        raise _ExportError("invalid", "Anki 要求填写笔记类型的首字段。", targets.get(first_field))
    return fields, media


def _gateway_failure(
    error: AnkiConnectError, stage: AnkiExportStage
) -> tuple[AnkiExportStatus, str]:
    message = connection_error_message(error)
    if error.code in ("stale_session", "target_missing"):
        return "target_changed", message
    if error.code == "duplicate":
        return "duplicate", message
    if error.code == "invalid_note":
        return "invalid", message
    if error.code == "unknown_write":
        if stage == "note":
            return "unknown", "发送结果未确认，请先在 Anki 中查看。"
        if stage == "install_type":
            return "failed", "笔记类型安装结果未确认，请重新检查 Anki。"
        if stage == "media":
            return "failed", "附件上传结果未确认，可以在当前草稿中重试。"
    return "failed", message


async def export_note(
    gateway: AnkiConnect, request: AnkiExportInput, builtins: AnkiBuiltins
) -> AnkiExportResponse:
    stage: AnkiExportStage = "target"
    uploaded: dict[str, str] = {}
    type_created = False
    media_may_remain = False
    field_id = None
    try:
        builtin = (
            _find_builtin(builtins, request.builtin_type)
            if request.builtin_type is not None
            else None
        )
        collection = await _checked_collection(gateway, request.endpoint, request.profile)
        deck = _find_entity(await gateway.list_decks(collection), request.deck, request.deck_id)
        if deck is None:
            raise _ExportError("target_changed", "目标卡组不可用，请重新选择普通卡组。")
        model = _find_entity(
            await gateway.list_note_types(collection), request.note_type, request.note_type_id
        )
        actual = await gateway.get_note_type(collection, model) if model is not None else None
        if actual is not None:
            if actual.name != request.note_type:
                raise _ExportError("target_changed", "目标笔记类型已改名，请重新选择。")
            if builtin is not None and not _builtin_compatible(actual, builtin):
                raise _incompatible()
            model_fields = actual.fields
        elif builtin is not None:
            model_fields = tuple(builtin.fields)
        else:
            raise _ExportError("target_changed", "目标笔记类型不可用，请重新选择。")

        stage = "validation"
        fields, media = _prepare_fields(request.fields, model_fields, builtin)
        if model is None and builtin is not None:
            if not request.install_builtin:
                raise _ExportError("installation_required", "发送前需确认创建内置笔记类型。")
            stage = "install_type"
            actual = await gateway.create_note_type(
                collection,
                name=request.note_type,
                fields=tuple(builtin.fields),
                templates=tuple(
                    AnkiTemplate(item.name, item.front, item.back)
                    for item in builtin.card_templates
                ),
                css=builtins.shared_css,
            )
            type_created = True
            if actual.name != request.note_type or not _builtin_compatible(actual, builtin):
                raise _incompatible()
            model = AnkiEntity(actual.id, actual.name)
        assert model is not None  # The target was resolved above or explicitly installed.

        stage = "validation"
        await gateway.validate_note(
            collection,
            deck=deck,
            note_type=model,
            fields=fields,
            allow_duplicate=request.allow_duplicate,
        )

        stage = "media"
        for target, attachment in media.items():
            filename = uploaded.get(attachment.filename)
            if filename is None:
                filename = await gateway.store_media(
                    collection, filename=attachment.filename, data=attachment.data
                )
                media_may_remain = True
                if _SAFE_MEDIA_NAME.fullmatch(filename) is None or not filename.endswith(
                    f".{attachment.filename.rpartition('.')[2]}"
                ):
                    raise _ExportError("failed", "Anki 返回了不可用的附件文件名。")
                uploaded[attachment.filename] = filename
            fields[target] = attachment.reference(filename)

        stage = "note"
        created = await gateway.create_note(
            collection,
            deck=deck,
            note_type=model,
            fields=fields,
            allow_duplicate=request.allow_duplicate,
        )
        return AnkiExportResponse(
            status="created",
            note_id=created.note_id,
            card_ids=list(created.card_ids) if created.card_ids is not None else None,
            uploaded_media=list(dict.fromkeys(uploaded.values())),
            type_created=type_created,
        )
    except _ExportError as error:
        status, message, field_id = error.status, error.message, error.field_id
    except AnkiConnectError as error:
        status, message = _gateway_failure(error, stage)
        if stage == "media" and error.code == "unknown_write":
            media_may_remain = True
    return AnkiExportResponse(
        status=status,
        message=message,
        field_id=field_id,
        stage=stage,
        uploaded_media=list(dict.fromkeys(uploaded.values())),
        media_may_remain=media_may_remain,
        type_created=type_created,
    )
