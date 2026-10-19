"""Resource-local, immutable tokenizer output and reading API contracts."""

from pydantic import BaseModel

from app.nlp.contracts import MaterialReadingToken as MaterialReadingToken
from app.nlp.contracts import MaterialResourceReadings as MaterialResourceReadings
from app.schemas import StrictInput


class MaterialReadingsPrepare(StrictInput):
    version_id: str
    force: bool = False


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
