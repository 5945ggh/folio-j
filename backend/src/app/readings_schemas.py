"""Resource-local, immutable tokenizer output and reading API contracts."""

from pydantic import BaseModel, Field

from app.schemas import StrictInput


class MaterialReadingsPrepare(StrictInput):
    version_id: str
    force: bool = False


class MaterialReadingToken(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    surface: str
    reading: str
    dictionary_form: str
    normalized_form: str
    pos: list[str]
    is_oov: bool


class MaterialResourceReadings(BaseModel):
    resource_id: str
    text_sha256: str
    tokens: list[MaterialReadingToken]


class MaterialReadingsSummary(BaseModel):
    material_id: str
    version_id: str
    generation_id: str
    token_count: int


class MaterialReadingsResponse(BaseModel):
    material_id: str
    version_id: str
    generation_id: str
    resources: list[MaterialResourceReadings]
