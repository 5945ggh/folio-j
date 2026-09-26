"""Strict public contracts for durable segment discussion."""

import re
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

ULID_PATTERN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
PermissionMode = Literal["review", "full_access"]
MessageStatus = Literal["complete", "pending", "streaming", "failed", "interrupted"]
JobStatus = Literal["queued", "running", "stopping", "succeeded", "failed", "interrupted"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


def check_ulid(value: str) -> str:
    if not ULID_PATTERN.fullmatch(value):
        raise ValueError("ID须为26位ULID")
    return value


def check_request_id(value: str) -> str:
    return str(UUID(value))


def check_optional_ulid(value: str | None) -> str | None:
    return check_ulid(value) if value is not None else None


class ThreadCreate(Input):
    request_id: str
    model_id: str | None = Field(default_factory=lambda: None)

    _request = field_validator("request_id")(check_request_id)
    _model = field_validator("model_id")(check_optional_ulid)


class ThreadPatch(Input):
    expected_revision: int = Field(ge=1)
    model_id: str | None = Field(default_factory=lambda: None)
    permission_mode: PermissionMode = Field(default_factory=lambda: "review")

    _model = field_validator("model_id")(check_optional_ulid)


class JobCreate(Input):
    request_id: str
    expected_thread_revision: int = Field(ge=1)
    expected_segment_revision: int = Field(ge=1)
    question: str
    additional_instructions: str = ""
    model_id: str | None = Field(default_factory=lambda: None)
    style_id: str | None = Field(default_factory=lambda: None)
    stream: bool = True

    _request = field_validator("request_id")(check_request_id)
    _model = field_validator("model_id")(check_optional_ulid)
    _style = field_validator("style_id")(check_optional_ulid)

    @field_validator("question", "additional_instructions")
    @classmethod
    def normalize_text(cls, value: str, info: ValidationInfo) -> str:
        normalized = unicodedata.normalize("NFC", value)
        if len(normalized) > 10000:
            raise ValueError("文本最多10000码点")
        if info.field_name == "question" and not normalized.strip():
            raise ValueError("问题不能为空白")
        return normalized


class ThreadResponse(BaseModel):
    id: str
    segment_id: str
    display_title: str
    selected_model_id: str | None
    permission_mode: PermissionMode
    revision: int
    active_job_id: str | None
    created_at: datetime
    updated_at: datetime


class ThreadPage(BaseModel):
    items: list[ThreadResponse]
    next_cursor: str | None


class MessageResponse(BaseModel):
    id: str
    thread_id: str
    job_id: str
    ordinal: int
    role: Literal["user", "assistant"]
    status: MessageStatus
    content: str
    created_at: datetime
    updated_at: datetime


class MessagePage(BaseModel):
    items: list[MessageResponse]
    next_cursor: int | None


class ModelSnapshotResponse(BaseModel):
    provider_id: str
    provider_name: str
    provider_revision: int
    provider_model_id: str
    model_id: str
    model_revision: int
    protocol: Literal["chat_completions", "responses"]
    temperature: float | None
    max_output_tokens: int | None
    reasoning_effort: str | None
    stream: bool


class JobResponse(BaseModel):
    id: str
    thread_id: str
    request_id: str
    status: JobStatus
    version: int
    user_message_id: str
    assistant_message: MessageResponse
    run_id: str | None
    model: ModelSnapshotResponse
    permission_mode: PermissionMode
    question: str
    additional_instructions: str
    error_code: str | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    stop_requested_at: datetime | None
