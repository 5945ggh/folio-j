"""Strict public contracts for durable segment discussion."""

import re
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.analysis_schemas import SectionOperation

ULID_PATTERN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
# Preserve the capacity of two legacy 10000-character fields plus their separator.
MAX_QUESTION_CHARS = 20002
PermissionMode = Literal["review", "full_access"]
MessageStatus = Literal["complete", "pending", "streaming", "failed", "interrupted"]
JobStatus = Literal[
    "queued", "running", "waiting_review", "stopping", "succeeded", "failed", "interrupted"
]


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
    question: str = Field(json_schema_extra={"maxLength": MAX_QUESTION_CHARS})
    model_id: str | None = Field(default_factory=lambda: None)
    style_id: str | None = Field(default_factory=lambda: None)
    stream: bool = True

    _request = field_validator("request_id")(check_request_id)
    _model = field_validator("model_id")(check_optional_ulid)
    _style = field_validator("style_id")(check_optional_ulid)

    @field_validator("question")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value)
        if len(normalized) > MAX_QUESTION_CHARS:
            raise ValueError(f"问题正文最多{MAX_QUESTION_CHARS}码点")
        if not normalized.strip():
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


class ArtifactResponse(BaseModel):
    analysis_id: str
    revision_id: str


class RetryInput(BaseModel):
    question: str


class ExplanationPromptResponse(BaseModel):
    question: str


class MessageJobSummary(BaseModel):
    artifacts: list[ArtifactResponse] = Field(default_factory=lambda: list[ArtifactResponse]())
    error: str | None = None
    retry: RetryInput | None = None


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
    job_summary: MessageJobSummary | None = None


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


class RunSummary(BaseModel):
    id: str
    status: str
    purpose: str


class ReviewProposal(BaseModel):
    tool_call_id: str
    source_run_id: str
    tool_name: Literal[
        "update_analysis_section",
        "insert_analysis_sections",
        "delete_analysis_section",
        "update_analysis_preamble",
    ]
    analysis_id: str
    base_revision_id: str
    title: str
    before: str
    after: str
    operation: SectionOperation


class JobResponse(BaseModel):
    id: str
    thread_id: str
    request_id: str
    status: JobStatus
    version: int
    user_message_id: str
    assistant_message: MessageResponse
    run_id: str | None
    kind: Literal["chat", "generate_analysis"] = "chat"
    artifacts: list[ArtifactResponse] = Field(default_factory=lambda: list[ArtifactResponse]())
    active_step: str | None = None
    review_proposal: ReviewProposal | None = None
    runs: list[RunSummary] = Field(default_factory=lambda: list[RunSummary]())
    model: ModelSnapshotResponse
    permission_mode: PermissionMode
    question: str
    error_code: str | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    stop_requested_at: datetime | None


class JobDecision(Input):
    expected_version: int = Field(ge=1)
    decision: Literal["approve", "reject"]
    additional_instructions: str = ""

    @field_validator("additional_instructions")
    @classmethod
    def normalize_instructions(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value)
        if len(normalized) > 10000:
            raise ValueError("补充要求最多10000码点")
        return normalized
