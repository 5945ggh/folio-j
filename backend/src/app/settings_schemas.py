"""Strict public contracts for learner settings and model access."""

from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

Protocol = Literal["chat_completions", "responses"]
Capability = Literal["unknown", "succeeded", "failed"]
Reasoning = Literal["none", "low", "medium", "high"]
RunStatus = Literal["queued", "running", "succeeded", "failed", "interrupted"]

# Storage guard only; the selected provider defines the model's real output limit.
MAX_OUTPUT_TOKENS = 2_147_483_647


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProfileInput(Input):
    native_language: str = Field(max_length=100)
    explain_language: str = Field(max_length=100)
    level_note: str = Field(max_length=10000)


class ProfileResponse(ProfileInput):
    pass


class StyleInput(Input):
    name: str = Field(min_length=1, max_length=100)
    body_md: str = Field(min_length=1, max_length=20000)

    @field_validator("name", "body_md")
    @classmethod
    def nonblank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("不能为空白")
        return cleaned


class StyleResponse(StyleInput):
    id: str
    created_at: datetime
    updated_at: datetime


class DefaultsInput(Input):
    analysis_model_id: str | None
    chat_model_id: str | None
    extraction_model_id: str | None
    style_id: str | None
    permission_mode: Literal["review", "full_access"]


class DefaultsResponse(DefaultsInput):
    pass


class DefaultsPatch(Input):
    analysis_model_id: str | None = None
    chat_model_id: str | None = None
    extraction_model_id: str | None = None
    style_id: str | None = None
    permission_mode: Literal["review", "full_access"] = Field(default_factory=lambda: "review")


class SettingsPatch(Input):
    # Factories make groups optional without accepting explicit null. Only fields
    # recorded in model_fields_set participate in a patch.
    profile: ProfileInput = Field(
        default_factory=lambda: ProfileInput(native_language="", explain_language="", level_note="")
    )
    defaults: DefaultsPatch = Field(default_factory=DefaultsPatch)


class SettingsResponse(BaseModel):
    profile: ProfileResponse
    styles: list[StyleResponse]
    defaults: DefaultsResponse


class ProviderInput(Input):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(max_length=2048)
    protocol: Protocol
    api_key: str | None = Field(default=None, max_length=20000, exclude=True)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def name_nonblank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("名称不能为空白")
        return value

    @field_validator("api_key")
    @classmethod
    def safe_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if "\r" in value or "\n" in value:
            raise ValueError("密钥不能包含换行")
        return value

    @field_validator("base_url")
    @classmethod
    def check_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if (
            parts.scheme not in ("http", "https")
            or not parts.netloc
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
            or "?" in value
            or "#" in value
        ):
            raise ValueError("地址须为无用户信息、查询及片段的 http/https URL")
        return value.rstrip("/")


class ProviderPatch(Input):
    name: str = Field(default_factory=str, min_length=1, max_length=100)
    base_url: str = Field(default_factory=str, max_length=2048)
    protocol: Protocol = Field(default_factory=lambda: "chat_completions")
    api_key: str = Field(default_factory=str, max_length=20000, exclude=True)
    enabled: bool = Field(default_factory=lambda: True)

    @field_validator("name")
    @classmethod
    def name_nonblank(cls, value: str) -> str:
        return ProviderInput.name_nonblank(value)

    @field_validator("api_key")
    @classmethod
    def safe_key(cls, value: str) -> str:
        return ProviderInput.safe_key(value) or ""

    @field_validator("base_url")
    @classmethod
    def check_url(cls, value: str) -> str:
        return ProviderInput.check_url(value)


class ModelInput(Input):
    model_id: str = Field(min_length=1, max_length=200)
    protocol_override: Protocol | None = None
    enabled: bool = True
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_output_tokens: int | None = Field(default=None, ge=1, le=MAX_OUTPUT_TOKENS)
    reasoning_effort: Reasoning | None = None

    @field_validator("model_id")
    @classmethod
    def model_nonblank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("模型 ID 不能为空白")
        return value


class ModelPatch(Input):
    protocol_override: Protocol | None = None
    enabled: bool = True
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_output_tokens: int | None = Field(default=None, ge=1, le=MAX_OUTPUT_TOKENS)
    reasoning_effort: Reasoning | None = None


class VerificationSummary(BaseModel):
    id: str
    status: RunStatus
    created_at: datetime
    finished_at: datetime | None
    error: str | None


class ModelResponse(ModelInput):
    id: str
    provider_id: str
    effective_protocol: Protocol
    revision: int
    text_status: Capability
    stream_status: Capability
    text_verification: VerificationSummary | None
    stream_verification: VerificationSummary | None


class ProviderResponse(BaseModel):
    id: str
    name: str
    base_url: str
    protocol: Protocol
    enabled: bool
    has_api_key: bool
    models: list[ModelResponse]
    discovered_models: list[str]
    discovery_status: Literal["never", "succeeded", "failed"]
    discovery_error: str | None
    last_discovered_at: datetime | None
    revision: int
    created_at: datetime
    updated_at: datetime


class VerificationInput(Input):
    stream: bool


class UsageResponse(BaseModel):
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    cached_tokens: int | None = None
    cache_hit_tokens: int | None = None
    cache_miss_tokens: int | None = None


class RunResponse(BaseModel):
    id: str
    purpose: Literal["verification", "chat", "analysis"] = "verification"
    job_id: str | None = None
    provider_id: str
    provider_name: str
    model_id: str
    protocol: Protocol
    stream: bool
    status: RunStatus
    output_text: str
    error: str | None
    usage: UsageResponse | None
    prompt_version: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
