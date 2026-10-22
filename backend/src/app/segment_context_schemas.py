"""Independent defaults for editable context prepared from a reading selection."""

from pydantic import BaseModel, ConfigDict, Field

MAX_CONTEXT_BUDGET = 100000


class SegmentContextBudget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = Field(strict=True)
    before_sentences: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)
    after_sentences: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)
    before_characters: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)
    after_characters: int = Field(ge=0, le=MAX_CONTEXT_BUDGET, strict=True)


class SegmentContextSettingsResponse(SegmentContextBudget):
    revision: int = Field(ge=0)


class SegmentContextSettingsUpdate(SegmentContextBudget):
    expected_revision: int = Field(ge=0, strict=True)


DEFAULT_SEGMENT_CONTEXT = SegmentContextSettingsResponse(
    enabled=True,
    before_sentences=3,
    after_sentences=3,
    before_characters=200,
    after_characters=200,
    revision=0,
)
