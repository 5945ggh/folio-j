"""Small value grammar for untrusted structured-content presentation.

Lengths become bounded rem values, including inherited relative font sizes. This
prevents nested em/percent sizes or indentation from multiplying without a bound.
No CSS parser, external stylesheets, arbitrary declarations or resources are used.
"""

import re
from dataclasses import dataclass
from typing import cast

from app.dictionary_schemas import DictionaryNodeStyle

_LENGTH = re.compile(r"(-?(?:\d{1,4}(?:\.\d{1,4})?|\.\d{1,4}))(px|em|rem|%)?\Z")
_HEX = re.compile(r"#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\Z")
_RGB = re.compile(
    r"(rgb|rgba)\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*(0(?:\.\d{1,4})?|1(?:\.0{1,4})?))?\)\Z"
)
_COLORS = frozenset(
    """
aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
yellowgreen transparent currentcolor
""".split()
)
_ENUMS = {
    "fontWeight": {"normal", "bold", *(str(weight) for weight in range(100, 1000, 100))},
    "borderStyle": {"none", "solid", "dotted", "dashed", "double"},
    "verticalAlign": {
        "baseline",
        "sub",
        "super",
        "text-top",
        "text-bottom",
        "middle",
        "top",
        "bottom",
    },
    "textAlign": {"left", "right", "center", "start", "end", "justify"},
}


@dataclass(frozen=True)
class StyleContext:
    font_size: float = 1.0
    left: float = 0.0
    right: float = 0.0


def _length(value: str, font_size: float, *, percent: bool = False) -> float | None:
    match = _LENGTH.fullmatch(value)
    if match is None:
        return None
    number, unit = float(match[1]), match[2]
    if unit == "px":
        return number / 16
    if unit == "rem":
        return number
    if unit == "em":
        return number * font_size
    if unit == "%" and percent:
        return number / 100 * font_size
    return 0.0 if unit is None and number == 0 else None


def _rem(number: float) -> str:
    return f"{number:.4f}".rstrip("0").rstrip(".") + "rem"


def _color(value: str) -> bool:
    if value in _COLORS or _HEX.fullmatch(value):
        return True
    match = _RGB.fullmatch(value)
    return bool(
        match
        and all(int(match[index]) <= 255 for index in (2, 3, 4))
        and ((match[1] == "rgba") == (match[5] is not None))
    )


def sanitize_style(
    value: object, parent: StyleContext
) -> tuple[DictionaryNodeStyle | None, StyleContext]:
    if not isinstance(value, dict):
        return None, parent
    source = cast(dict[object, object], value)
    safe: dict[str, str] = {}
    font_size, left, right = parent.font_size, parent.left, parent.right
    raw_font = source.get("fontSize")
    if isinstance(raw_font, str) and len(raw_font) <= 32:
        parsed = _length(raw_font.strip().lower(), font_size, percent=True)
        if parsed is not None and 0.5 <= parsed <= 2.5:
            font_size = parsed
            safe["fontSize"] = _rem(parsed)
    for key, raw in source.items():
        if not isinstance(key, str) or not isinstance(raw, str) or len(raw) > 64:
            continue
        text = raw.strip().lower()
        if key in _ENUMS and text in _ENUMS[key]:
            safe[key] = text
        elif key in {"color", "backgroundColor", "borderColor"} and _color(text):
            safe[key] = text
        elif key in {
            "marginTop",
            "marginBottom",
            "marginLeft",
            "marginRight",
            "paddingTop",
            "paddingBottom",
            "paddingLeft",
            "paddingRight",
            "borderWidth",
            "borderRadius",
        }:
            if key == "borderRadius" and text.endswith("%"):
                radius = _length(text, 1, percent=True)
                if radius is not None and 0 <= radius <= 0.5:
                    safe[key] = text
                continue
            number = _length(text, font_size)
            minimum = -2.0 if key in {"marginLeft", "marginRight"} else 0.0
            maximum = 0.25 if key == "borderWidth" else 2.0
            if number is None or not minimum <= number <= maximum:
                continue
            if key in {"marginLeft", "paddingLeft"}:
                if not -2 <= left + number <= 8:
                    continue
                left += number
            elif key in {"marginRight", "paddingRight"}:
                if not -2 <= right + number <= 8:
                    continue
                right += number
            safe[key] = _rem(number)
    return (
        DictionaryNodeStyle.model_validate(safe) if safe else None,
        StyleContext(font_size, left, right),
    )
