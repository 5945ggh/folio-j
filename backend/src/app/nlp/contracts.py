"""Text-only inputs and resource-local lexical output, independent of readers."""

from dataclasses import dataclass

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class TextResource:
    resource_id: str
    text: str
    text_sha256: str


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


class DecodedReadings(BaseModel):
    configuration: str
    resources: list[MaterialResourceReadings]
