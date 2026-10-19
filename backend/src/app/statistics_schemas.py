"""Read-only material statistics, bound to exact immutable input identities."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.nlp.statistics import LexicalStatistics, TextStatistics


class MaterialStatisticsResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    material_id: str
    version_id: str
    generation_id: str | None
    scope: Literal["unique_resources"] = "unique_resources"
    text: TextStatistics
    lexical: LexicalStatistics | None
    analysis_configuration: str | None
