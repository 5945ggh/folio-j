"""Request and receipt for a single, non-persistent Anki export."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator

from app.anki_settings_schemas import (
    AnkiBuiltinNoteTypeRef,
    AnkiEntityId,
    AnkiName,
    AnkiSettingsInput,
    AnkiUrl,
    StableId,
)

# A single base64 upload plus its RPC envelope must fit AnkiConnect v1's 16 MiB request.
MAX_ANKI_MEDIA_BYTES = 11 * 1024 * 1024
MAX_ANKI_EXPORT_MEDIA_BYTES = 24 * 1024 * 1024
_MAX_BASE64_LENGTH = 4 * ((MAX_ANKI_MEDIA_BYTES + 2) // 3)

AnkiExportStatus = Literal[
    "created",
    "invalid",
    "duplicate",
    "installation_required",
    "incompatible_type",
    "unknown",
    "failed",
    "target_changed",
]
AnkiExportStage = Literal["target", "validation", "install_type", "media", "note"]
AnkiBuiltinStatus = Literal["missing", "compatible", "incompatible", "target_changed", "failed"]
_MAX_FIELD_TEXT_LENGTH = 32_768
_FieldText = Annotated[str, Field(max_length=_MAX_FIELD_TEXT_LENGTH)]


class AnkiExportAttachment(AnkiSettingsInput):
    name: str = Field(min_length=1, max_length=255)
    data_base64: str = Field(min_length=1, max_length=_MAX_BASE64_LENGTH, repr=False)


class AnkiSentenceRuby(AnkiSettingsInput):
    """One annotation indexed by Unicode code points in the original field value."""

    start: int = Field(ge=0, lt=_MAX_FIELD_TEXT_LENGTH)
    end: int = Field(gt=0, le=_MAX_FIELD_TEXT_LENGTH)
    reading: str = Field(min_length=1, max_length=_MAX_FIELD_TEXT_LENGTH)


class AnkiSentenceFocus(AnkiSettingsInput):
    """One half-open Unicode code-point range in the original field value."""

    start: int = Field(ge=0, lt=_MAX_FIELD_TEXT_LENGTH)
    end: int = Field(gt=0, le=_MAX_FIELD_TEXT_LENGTH)
    text: str = Field(min_length=1, max_length=_MAX_FIELD_TEXT_LENGTH, repr=False)


class AnkiExportField(AnkiSettingsInput):
    id: StableId
    type: Literal["text", "audio", "image", "video"]
    target_field: AnkiName | None = None
    required: bool = False
    value: _FieldText | AnkiExportAttachment | None = Field(default=None, repr=False)
    sentence_ruby: list[AnkiSentenceRuby] = Field(
        default_factory=lambda: list[AnkiSentenceRuby](),
        max_length=_MAX_FIELD_TEXT_LENGTH,
        repr=False,
    )
    sentence_focus: AnkiSentenceFocus | None = Field(default=None, repr=False)

    @field_validator("value", mode="before")
    @classmethod
    def discard_unmapped_value(cls, value: object, info: ValidationInfo) -> object:
        if info.data.get("target_field") is None and info.data.get("required") is False:
            return None
        return value


class _ExpectedAnkiCollection(AnkiSettingsInput):
    endpoint: AnkiUrl
    profile: AnkiName


class AnkiExportInput(_ExpectedAnkiCollection):
    deck: AnkiName
    deck_id: AnkiEntityId | None = None
    note_type: AnkiName
    note_type_id: AnkiEntityId | None = None
    builtin_type: AnkiBuiltinNoteTypeRef | None = None
    fields: list[AnkiExportField] = Field(min_length=1, max_length=64, repr=False)
    allow_duplicate: bool = False
    install_builtin: bool = False


class AnkiExportResponse(BaseModel):
    status: AnkiExportStatus
    message: str | None = None
    field_id: str | None = None
    stage: AnkiExportStage | None = None
    note_id: str | None = None
    card_ids: list[str] | None = None
    uploaded_media: list[str] = Field(default_factory=list)
    media_may_remain: bool = False
    type_created: bool = False


class AnkiBuiltinCheckInput(_ExpectedAnkiCollection):
    builtin_type: AnkiBuiltinNoteTypeRef
    note_type: AnkiName | None = None


class AnkiBuiltinCheckResponse(BaseModel):
    status: AnkiBuiltinStatus
    message: str | None = None
