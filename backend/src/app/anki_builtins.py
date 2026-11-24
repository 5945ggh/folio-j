"""Bundled Anki note types and independent, offline export presets."""

from functools import lru_cache
from importlib.resources import files

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.anki_settings_schemas import AnkiExportPreset


class BuiltinCardTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    front: str
    back: str


class BuiltinNoteType(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    version: int
    name: str
    fields: list[str]
    card_templates: list[BuiltinCardTemplate] = Field(
        validation_alias=AliasChoices("card_templates", "cardTemplates")
    )


class AnkiBuiltins(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shared_css: str = Field(validation_alias=AliasChoices("shared_css", "sharedCss"))
    note_types: list[BuiltinNoteType] = Field(
        validation_alias=AliasChoices("note_types", "noteTypes")
    )
    export_presets: list[AnkiExportPreset] = Field(
        validation_alias=AliasChoices("export_presets", "exportPresets")
    )


@lru_cache(maxsize=1)
def get_builtins() -> AnkiBuiltins:
    asset = files("app").joinpath("anki_builtin_types.json")
    return AnkiBuiltins.model_validate_json(asset.read_bytes())
