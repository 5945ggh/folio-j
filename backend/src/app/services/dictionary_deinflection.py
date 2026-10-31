"""Single-step lexical restorations; callers validate dictionary rules and source spans."""

from collections.abc import Sequence

_GODAN_POTENTIAL_ENDINGS = {
    "え": "う",
    "け": "く",
    "げ": "ぐ",
    "せ": "す",
    "て": "つ",
    "ね": "ぬ",
    "べ": "ぶ",
    "め": "む",
    "れ": "る",
}


def godan_potential_base(lemma: str, pos: Sequence[str]) -> str | None:
    """Propose a v5 base without claiming that an ambiguous ichidan lemma is potential."""
    if (
        len(pos) != 6
        or pos[0] != "動詞"
        or "下一段" not in pos[4]
        or len(lemma) < 2
        or not lemma.endswith("る")
    ):
        return None
    ending = _GODAN_POTENTIAL_ENDINGS.get(lemma[-2])
    return lemma[:-2] + ending if ending is not None else None
