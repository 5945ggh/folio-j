"""Compile a bounded subset of package CSS against structured dictionary nodes."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast

from tinycss2 import parse_blocks_contents, parse_stylesheet, serialize
from tinycss2.ast import (
    Declaration,
    DimensionToken,
    FunctionBlock,
    HashToken,
    IdentToken,
    LiteralToken,
    Node,
    NumberToken,
    PercentageToken,
    QualifiedRule,
    SquareBracketsBlock,
    StringToken,
    WhitespaceToken,
)

from app.dictionary_schemas import DictionaryNodeStyle
from app.services.dictionary_styles import is_supported_style_value

MAX_STYLESHEET_BYTES = 128 * 1024
_MAX_SELECTORS = 256
_MAX_SELECTOR_TOKENS = 64
_MAX_COMPOUNDS = 8
_MAX_ATTRIBUTE_LENGTH = 1024
_CSS_PROPERTIES = {
    "".join(f"-{character.lower()}" if character.isupper() else character for character in key): key
    for key in DictionaryNodeStyle.model_fields
}
_STYLE_ROOT_CLASS = "structured-content"


@dataclass(frozen=True)
class StyleNode:
    tag: str
    data: Mapping[str, object]
    language: str | None
    structured_root: bool = False


STRUCTURED_ROOT = StyleNode("span", {}, None, structured_root=True)


@dataclass(frozen=True)
class _Attribute:
    name: str
    op: str = ""
    value: str = ""

    def matches(self, node: StyleNode) -> bool:
        if self.name == "lang":
            actual = node.language
        else:
            # Yomitan maps data.fooBar to the DOM attribute data-sc-foo-bar.
            actual = node.data.get(self.name.removeprefix("data:"))
        if not isinstance(actual, str) or len(actual) > _MAX_ATTRIBUTE_LENGTH:
            return False
        if self.op == "":
            return True
        if self.op == "=":
            return actual == self.value
        if self.op == "~=":
            return self.value in actual.split()
        if self.op == "|=":
            return actual == self.value or actual.startswith(self.value + "-")
        if self.op == "^=":
            return actual.startswith(self.value)
        if self.op == "$=":
            return actual.endswith(self.value)
        return self.value in actual


@dataclass(frozen=True)
class _Compound:
    tag: str | None
    attributes: tuple[_Attribute, ...]
    structured_root: bool = False

    def matches(self, node: StyleNode) -> bool:
        return (
            (self.tag is None or self.tag == node.tag)
            and (not self.structured_root or node.structured_root)
            and all(attribute.matches(node) for attribute in self.attributes)
        )


_Declaration = tuple[str, str, bool]


@dataclass(frozen=True)
class _Rule:
    compounds: tuple[_Compound, ...]
    combinators: tuple[str, ...]
    specificity: tuple[int, int]
    declarations: tuple[_Declaration, ...]

    def matches(self, path: tuple[StyleNode, ...]) -> bool:
        if not self.compounds[-1].matches(path[-1]):
            return False
        indices = (len(path) - 1,)
        for compound, combinator in zip(
            reversed(self.compounds[:-1]), reversed(self.combinators), strict=True
        ):
            candidates = (
                (index - 1 for index in indices if index)
                if combinator == ">"
                else range(indices[-1])
            )
            indices = tuple(index for index in candidates if compound.matches(path[index]))
            if not indices:
                return False
        return True


def _is_literal(token: Node, value: str) -> bool:
    return isinstance(token, LiteralToken) and token.value == value


def _parse_attribute(block: SquareBracketsBlock) -> _Attribute | None:
    tokens = [token for token in block.content if not isinstance(token, WhitespaceToken)]
    if not tokens or not isinstance(tokens[0], IdentToken):
        return None
    name = tokens[0].lower_value
    if name.startswith("data-sc-") and len("data-sc-") < len(name) <= _MAX_ATTRIBUTE_LENGTH:
        first, *parts = name.removeprefix("data-sc-").split("-")
        name = first + "".join(part[:1].upper() + part[1:] for part in parts)
        # The attribute named data-sc-lang refers to data.lang, separate from lang.
        name = "data:" + name
    elif name != "lang":
        return None
    if len(tokens) == 1:
        return _Attribute(name)
    if len(tokens) != 3:
        return None
    operator, value = tokens[1:]
    if not isinstance(operator, LiteralToken) or operator.value not in {
        "=",
        "~=",
        "|=",
        "^=",
        "$=",
        "*=",
    }:
        return None
    if not isinstance(value, (StringToken, IdentToken)):
        return None
    if len(value.value) > _MAX_ATTRIBUTE_LENGTH or (not value.value and operator.value != "="):
        return None
    return _Attribute(name, operator.value, value.value)


def _parse_compound(tokens: list[Node]) -> _Compound | None:
    tag: str | None = None
    offset = 0
    if isinstance(tokens[0], IdentToken):
        tag = tokens[0].lower_value
        offset = 1
    elif _is_literal(tokens[0], "*"):
        offset = 1
    attributes: list[_Attribute] = []
    structured_root = False
    while offset < len(tokens):
        token = tokens[offset]
        if isinstance(token, SquareBracketsBlock):
            attribute = _parse_attribute(token)
            if attribute is None:
                return None
            attributes.append(attribute)
            offset += 1
        elif (
            _is_literal(token, ".")
            and offset + 1 < len(tokens)
            and isinstance(name := tokens[offset + 1], IdentToken)
            and name.value == _STYLE_ROOT_CLASS
            and not structured_root
        ):
            structured_root = True
            offset += 2
        else:
            return None
    return _Compound(tag, tuple(attributes), structured_root)


def _selector(tokens: list[Node], declarations: tuple[_Declaration, ...]) -> _Rule | None:
    if len(tokens) > _MAX_SELECTOR_TOKENS:
        return None
    compounds: list[_Compound] = []
    combinators: list[str] = []
    current: list[Node] = []
    relation: str | None = None
    for token in tokens:
        if isinstance(token, WhitespaceToken) or _is_literal(token, ">"):
            if current:
                compound = _parse_compound(current)
                if compound is None:
                    return None
                compounds.append(compound)
                current = []
                relation = " "
            if _is_literal(token, ">"):
                if relation != " ":
                    return None
                relation = ">"
        else:
            if not current and compounds:
                if relation is None:
                    return None
                combinators.append(relation)
                relation = None
            current.append(token)
    if current:
        compound = _parse_compound(current)
        if compound is None:
            return None
        compounds.append(compound)
    if not 0 < len(compounds) <= _MAX_COMPOUNDS or relation == ">":
        return None
    return _Rule(
        tuple(compounds),
        tuple(combinators),
        (
            sum(len(compound.attributes) + compound.structured_root for compound in compounds),
            sum(compound.tag is not None for compound in compounds),
        ),
        declarations,
    )


def _value_tokens(tokens: list[Node]) -> bool:
    if len(tokens) > 32:
        return False
    for token in tokens:
        if isinstance(
            token,
            (WhitespaceToken, IdentToken, NumberToken, DimensionToken, PercentageToken, HashToken),
        ):
            continue
        if not isinstance(token, FunctionBlock) or token.lower_name not in {"rgb", "rgba"}:
            return False
        if len(token.arguments) > 16 or not all(
            isinstance(argument, (WhitespaceToken, NumberToken)) or _is_literal(argument, ",")
            for argument in token.arguments
        ):
            return False
    return True


def _declarations(tokens: list[Node]) -> tuple[_Declaration, ...]:
    accepted: dict[tuple[str, bool], str] = {}
    for token in parse_blocks_contents(tokens, skip_comments=True, skip_whitespace=True):
        if not isinstance(token, Declaration) or not _value_tokens(token.value):
            continue
        name = token.lower_name
        value = serialize(token.value).strip().lower()
        key = _CSS_PROPERTIES.get(name)
        if key is not None:
            values = {key: value}
        elif name == "background":
            values = {"backgroundColor": value}
        elif name in {"margin", "padding"}:
            parts = value.split()
            if not 1 <= len(parts) <= 4:
                continue
            top = parts[0]
            right = parts[1] if len(parts) > 1 else top
            bottom = parts[2] if len(parts) > 2 else top
            left = parts[3] if len(parts) > 3 else right
            values = {
                name + "Top": top,
                name + "Right": right,
                name + "Bottom": bottom,
                name + "Left": left,
            }
        elif name == "border":
            parts = [
                part.serialize().strip().lower()
                for part in token.value
                if not isinstance(part, WhitespaceToken)
            ]
            values: dict[str, str] = {}
            for part in parts:
                matched = next(
                    (
                        key
                        for key in ("borderStyle", "borderWidth", "borderColor")
                        if is_supported_style_value(key, part)
                    ),
                    None,
                )
                if matched is None or matched in values:
                    break
                values[matched] = part
            else:
                if values:
                    values = {
                        "borderWidth": "3px",
                        "borderStyle": "none",
                        "borderColor": "currentcolor",
                        **values,
                    }
                    accepted.update(((key, token.important), item) for key, item in values.items())
            continue
        else:
            continue
        if all(is_supported_style_value(key, item) for key, item in values.items()):
            accepted.update(((key, token.important), item) for key, item in values.items())
    return tuple((key, item, important) for (key, important), item in accepted.items())


class DictionaryStylesheet:
    def __init__(self, rules: Sequence[_Rule]) -> None:
        by_tag: dict[str | None, list[tuple[int, _Rule]]] = {}
        for offset, rule in enumerate(rules):
            by_tag.setdefault(rule.compounds[-1].tag, []).append((offset, rule))
        self._by_tag = by_tag

    def style_for(self, path: tuple[StyleNode, ...], inline: object) -> object:
        rules = (*self._by_tag.get(path[-1].tag, ()), *self._by_tag.get(None, ()))
        if not rules:
            return inline
        matches = sorted(
            ((rule.specificity, order, rule) for order, rule in rules if rule.matches(path)),
            key=lambda item: (item[0], item[1]),
        )
        if not matches:
            return inline
        normal: dict[str, object] = {}
        important: dict[str, object] = {}
        for _, _, rule in matches:
            for key, value, is_important in rule.declarations:
                (important if is_important else normal)[key] = value
        if isinstance(inline, dict):
            normal.update(
                (key, value)
                for key, value in cast(dict[str, object], inline).items()
                if isinstance(value, str) and is_supported_style_value(key, value.strip().lower())
            )
        normal.update(important)
        return normal


def compile_stylesheet(source: str | None) -> DictionaryStylesheet | None:
    if not source:
        return None
    rules: list[_Rule] = []
    for raw in parse_stylesheet(source, skip_comments=True, skip_whitespace=True):
        if not isinstance(raw, QualifiedRule):
            continue
        declarations = _declarations(raw.content)
        if not declarations:
            continue
        group: list[_Rule] = []
        selector: list[Node] = []
        for token in [*raw.prelude, LiteralToken(0, 0, ",")]:
            if not _is_literal(token, ","):
                selector.append(token)
                continue
            parsed = _selector(selector, declarations)
            if parsed is None:
                break
            group.append(parsed)
            selector = []
        else:
            if len(rules) + len(group) > _MAX_SELECTORS:
                break
            rules.extend(group)
    return DictionaryStylesheet(rules) if rules else None
