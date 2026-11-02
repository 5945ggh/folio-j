"""Describe observed source components without assigning auxiliary meanings."""

from collections.abc import Sequence
from typing import cast

from app.dictionary_schemas import (
    DictionaryInflectionForm,
    DictionaryInflectionPart,
    DictionarySoundChange,
)
from app.nlp.contracts import MaterialReadingToken

_FORMS: dict[str, DictionaryInflectionForm] = {
    "未然形": "irrealis",
    "連用形": "continuative",
    "終止形": "terminal",
    "連体形": "attributive",
    "仮定形": "conditional",
    "命令形": "imperative",
}


def inflection_parts(
    text: str,
    prefix: str,
    tokens: Sequence[MaterialReadingToken],
    following: MaterialReadingToken | None,
) -> tuple[DictionaryInflectionPart, ...]:
    """Keep actual spellings; a clipped right edge cannot prove terminal vs attributive."""
    first = tokens[0]
    if len(tokens) == 1 and first.surface == first.dictionary_form:
        return ()
    parts: list[DictionaryInflectionPart] = []
    for index, token in enumerate(tokens):
        conjugation = token.pos[5] if len(token.pos) == 6 else ""
        base, _, detail = conjugation.partition("-")
        form = _FORMS.get(base)
        next_token = tokens[index + 1] if index + 1 < len(tokens) else following
        if (
            form in {"irrealis", "continuative"}
            and token.pos[0] in {"動詞", "助動詞"}
            and next_token is not None
            and next_token.start == token.end
            and next_token.pos[0] == "助動詞"
            and (
                next_token.dictionary_form
                in {"せる", "させる", "れる", "られる", "ない", "ぬ", "ず"}
                or (
                    next_token.dictionary_form == "まい"
                    and (
                        "一段" in token.pos[4]
                        or token.dictionary_form in {"れる", "られる", "せる", "させる"}
                    )
                )
            )
        ):
            # Sudachi calls some identical ichidan stems continuative even before
            # させる; school grammar names them by the actually observed connection.
            form = "irrealis"
        if detail == "融合":
            form = None
        if form in {"terminal", "attributive"} and token.end == len(text):
            form = None
        sound = (
            cast(DictionarySoundChange, detail)
            if detail in {"イ音便", "撥音便", "促音便", "ウ音便"}
            else None
        )
        parts.append(
            DictionaryInflectionPart(
                surface=(prefix if index == 0 else "") + token.surface,
                dictionary_form=(prefix if index == 0 else "") + token.dictionary_form,
                form=form,
                sound_change=sound,
            )
        )
    # Unmapped analyzer categories (e.g. 意志推量形) do not become one of the six forms.
    return tuple(parts) if any(part.form is not None for part in parts) else ()
