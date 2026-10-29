"""Independent budgets and source-label preference for reading-selection copies."""

from pydantic import BaseModel, ConfigDict, Field

MAX_CONTEXT_BUDGET = 100000


class ContextCopyBudget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    include_source: bool = Field(strict=True)
    before_sentences: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)
    after_sentences: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)
    before_characters: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)
    after_characters: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)


class ContextCopySettingsResponse(ContextCopyBudget):
    revision: int = Field(ge=0)


class ContextCopySettingsUpdate(ContextCopyBudget):
    expected_revision: int = Field(ge=0, strict=True)


DEFAULT_CONTEXT_COPY = ContextCopySettingsResponse(
    include_source=True,
    before_sentences=3,
    after_sentences=0,
    before_characters=200,
    after_characters=200,
    revision=0,
)
