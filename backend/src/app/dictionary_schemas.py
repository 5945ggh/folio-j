"""Safe local dictionary trees and resource-local lookup coordinates."""

from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

from app.schemas import StrictInput


class DictionaryNodeStyle(BaseModel):
    """Only sanitized presentation properties; no selectors, resources or positioning."""

    fontSize: str | None = Field(default=None, exclude_if=lambda value: value is None)
    fontWeight: (
        Literal["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"]
        | None
    ) = Field(default=None, exclude_if=lambda value: value is None)
    color: str | None = Field(default=None, exclude_if=lambda value: value is None)
    backgroundColor: str | None = Field(default=None, exclude_if=lambda value: value is None)
    marginTop: str | None = Field(default=None, exclude_if=lambda value: value is None)
    marginBottom: str | None = Field(default=None, exclude_if=lambda value: value is None)
    marginLeft: str | None = Field(default=None, exclude_if=lambda value: value is None)
    marginRight: str | None = Field(default=None, exclude_if=lambda value: value is None)
    paddingTop: str | None = Field(default=None, exclude_if=lambda value: value is None)
    paddingBottom: str | None = Field(default=None, exclude_if=lambda value: value is None)
    paddingLeft: str | None = Field(default=None, exclude_if=lambda value: value is None)
    paddingRight: str | None = Field(default=None, exclude_if=lambda value: value is None)
    borderWidth: str | None = Field(default=None, exclude_if=lambda value: value is None)
    borderRadius: str | None = Field(default=None, exclude_if=lambda value: value is None)
    borderStyle: Literal["none", "solid", "dotted", "dashed", "double"] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    borderColor: str | None = Field(default=None, exclude_if=lambda value: value is None)
    verticalAlign: (
        Literal["baseline", "sub", "super", "text-top", "text-bottom", "middle", "top", "bottom"]
        | None
    ) = Field(default=None, exclude_if=lambda value: value is None)
    textAlign: Literal["left", "right", "center", "start", "end", "justify"] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )


class DictionaryNode(BaseModel):
    tag: Literal["div", "p", "span", "ul", "ol", "li", "br", "ruby", "rt"] = "span"
    lang: Literal["ja", "zh"] | None = None
    text: str | None = None
    content: list["DictionaryNode"] = Field(default_factory=lambda: list[DictionaryNode]())
    role: Literal["head", "def1", "def2", "dfcn", "exam", "exjp", "excn"] | None = None
    style: DictionaryNodeStyle | None = Field(default=None, exclude_if=lambda value: value is None)


class DictionaryStatus(BaseModel):
    title: str | None = None
    dictionary_id: str | None = None
    revision: str | None = None
    entry_count: int = 0
    ready: bool = False


class DictionaryLibraryItem(BaseModel):
    dictionary_id: str
    title: str
    revision: str
    entry_count: int


class DictionaryLibrary(BaseModel):
    dictionaries: list[DictionaryLibraryItem]
    active_dictionary_id: str | None


class DictionaryLibraryImport(BaseModel):
    library: DictionaryLibrary
    dictionary_id: str
    already_installed: bool


class DictionarySelection(StrictInput):
    dictionary_id: str = Field(min_length=1, max_length=64)


class DictionaryTokenHint(StrictInput):
    """Aligned source boundaries with independently optional lexical evidence."""

    start: int = Field(ge=0)
    end: int = Field(ge=0)
    surface: str = Field(max_length=8192)
    reading: str = Field(default_factory=str, max_length=8192)
    dictionary_form: str = Field(default_factory=str, max_length=8192)
    normalized_form: str = Field(default_factory=str, max_length=8192)
    pos: list[str] = Field(default_factory=lambda: list[str](), max_length=6)
    is_oov: bool = Field(default_factory=bool)


class DictionaryLookupRequest(StrictInput):
    expected_dictionary_id: str | None = Field(default=None, min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=8192)
    position: int | None = Field(default=None, ge=0)
    selection_start: int | None = Field(default=None, ge=0)
    selection_end: int | None = Field(default=None, ge=0)
    tokens: list[DictionaryTokenHint] = Field(
        default_factory=lambda: list[DictionaryTokenHint](), max_length=4096
    )

    @model_validator(mode="after")
    def valid_coordinates(self) -> Self:
        if self.selection_start is not None or self.selection_end is not None:
            if (
                self.position is not None
                or self.selection_start is None
                or self.selection_end is None
                or not 0 <= self.selection_start < self.selection_end <= len(self.text)
            ):
                raise ValueError("选区范围无效")
        elif self.position is None:
            self.selection_start = 0
            self.selection_end = len(self.text)
        elif self.position >= len(self.text):
            raise ValueError("点击位置无效")
        return self


class DictionaryMatch(BaseModel):
    id: str
    dictionary_id: str
    term: str
    reading: str
    start: int
    end: int
    surface: str
    definitions: list[DictionaryNode]


class DictionaryLookupResponse(BaseModel):
    matches: list[DictionaryMatch]
