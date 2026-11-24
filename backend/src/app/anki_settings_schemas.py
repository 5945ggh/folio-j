"""Definitions shared by the offline editor and the Anki export workflow."""

import re
from typing import Annotated, Literal, Self

import httpx
from pydantic import (
    AfterValidator,
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
    model_validator,
)

DEFAULT_ANKI_URL = "http://127.0.0.1:8765"
MAX_ANKI_URL_LENGTH = 2048


def normalize_url(value: str) -> str:
    value = value.strip()
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Anki 服务地址不能包含空白或控制字符")
    authority = value.partition("://")[2].partition("/")[0]
    if (
        any(char in value for char in "?#\\")
        or "@" in authority
        or "%" in authority
        or not re.fullmatch(r"(?:\[[^\[\]]+\]|[^:\[\]]+)(?::[0-9]+)?", authority)
    ):
        raise ValueError("Anki 服务地址须为无用户信息、查询和片段的 HTTP 或 HTTPS URL")
    try:
        url = httpx.URL(value)
        # Request construction also decodes existing punycode to build the Host header.
        host = url.host
    except (httpx.InvalidURL, UnicodeError) as exc:
        raise ValueError("Anki 服务地址无效") from exc
    if (
        url.scheme not in ("http", "https")
        or not host
        or not re.fullmatch(rb"[a-zA-Z0-9_.-]+|[a-fA-F0-9:.]+", url.raw_host)
        or (url.port is not None and not 1 <= url.port <= 65535)
    ):
        raise ValueError("Anki 服务地址的主机名或端口无效")
    normalized = str(url).rstrip("/")
    if len(normalized) > MAX_ANKI_URL_LENGTH:
        raise ValueError("Anki 服务地址过长")
    return normalized


def printable(value: str) -> str:
    if not value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("名称须包含可见字符且不能包含控制字符")
    return value


AnkiUrl = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_ANKI_URL_LENGTH),
    AfterValidator(normalize_url),
]
Label = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
    AfterValidator(printable),
]
AnkiName = Annotated[
    str, StringConstraints(min_length=1, max_length=512), AfterValidator(printable)
]
StableId = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")]
AnkiEntityId = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]{0,19}$")]


class AnkiSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class AnkiConnectionInput(AnkiSettingsInput):
    url: AnkiUrl
    api_key: SecretStr | None = Field(default=None, exclude=True, max_length=8192)

    @field_validator("api_key")
    @classmethod
    def normalize_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        key = value.get_secret_value().strip()
        if any(ord(char) < 32 or ord(char) == 127 for char in key):
            raise ValueError("API 密钥不能包含控制字符")
        return SecretStr(key) if key else None


class AnkiConnectionResponse(BaseModel):
    url: str
    has_api_key: bool
    revision: int


class AnkiTargetScope(AnkiSettingsInput):
    url: AnkiUrl
    profile: AnkiName


class AnkiDeckTarget(AnkiSettingsInput):
    name: AnkiName
    scope: AnkiTargetScope
    id: AnkiEntityId | None = None


class AnkiBuiltinNoteTypeRef(AnkiSettingsInput):
    id: StableId
    version: int = Field(ge=1)


class AnkiBuiltinNoteTypeTarget(AnkiBuiltinNoteTypeRef):
    kind: Literal["builtin"]
    name: AnkiName | None = None
    scope: AnkiTargetScope | None = None

    @model_validator(mode="after")
    def installed_name_is_scoped(self) -> Self:
        if (self.name is None) != (self.scope is None):
            raise ValueError("已安装内置类型的名称与目标范围须同时设置")
        return self


class AnkiExternalNoteTypeTarget(AnkiSettingsInput):
    kind: Literal["external"]
    name: AnkiName
    scope: AnkiTargetScope
    id: AnkiEntityId | None = None


AnkiNoteTypeTarget = Annotated[
    AnkiBuiltinNoteTypeTarget | AnkiExternalNoteTypeTarget, Field(discriminator="kind")
]


class AnkiFieldDefinition(AnkiSettingsInput):
    id: StableId
    label: Label
    type: Literal["text", "audio", "image", "video"]
    source: Literal["manual", "selection", "sentence", "sourceMetadata"] = "manual"
    target_field: AnkiName | None = Field(
        default=None, validation_alias=AliasChoices("target_field", "targetField")
    )
    required: bool = False
    presentation: Literal["common", "summary", "more"] = "common"
    multiline: bool = False

    @model_validator(mode="after")
    def valid_field(self) -> Self:
        if self.type != "text" and (self.source != "manual" or self.multiline):
            raise ValueError("媒体字段须手动选择文件")
        if self.required and self.target_field is None:
            raise ValueError("必填字段须映射至 Anki 字段")
        return self


class AnkiFieldLayout(AnkiSettingsInput):
    name: Label
    deck: AnkiDeckTarget | None = None
    fields: list[AnkiFieldDefinition] = Field(max_length=64)

    @field_validator("fields")
    @classmethod
    def unique_fields(cls, fields: list[AnkiFieldDefinition]) -> list[AnkiFieldDefinition]:
        ids = {field.id for field in fields}
        labels = {field.label.casefold() for field in fields}
        targets = [field.target_field for field in fields if field.target_field is not None]
        if len(ids) != len(fields) or len(labels) != len(fields):
            raise ValueError("应用字段 ID 和名称须各自唯一")
        if len(set(targets)) != len(targets):
            raise ValueError("Anki 字段只能接收一行映射")
        return fields


class AnkiConfigurationInput(AnkiFieldLayout):
    note_type: AnkiNoteTypeTarget | None = None


class AnkiConfigurationResponse(AnkiConfigurationInput):
    id: str


class AnkiExportPreset(AnkiFieldLayout):
    id: StableId
    note_type_ref: AnkiBuiltinNoteTypeRef = Field(
        validation_alias=AliasChoices("note_type_ref", "noteTypeRef")
    )
