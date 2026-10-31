"""Untrusted inline presentation remains bounded and upgrades existing v2 indexes."""

import json
import sqlite3
import zlib
from pathlib import Path

import pytest
from support_api import chat_client
from test_dictionary_store import archive, chunks, record

from app.dictionary_schemas import DictionaryNode
from app.services import dictionary_store
from app.services.dictionary_store import DictionaryStore
from app.services.dictionary_styles import StyleContext, sanitize_style


def test_safe_actual_dictionary_properties_and_compact_serialization() -> None:
    style, context = sanitize_style(
        {
            "fontSize": "1.3em",
            "fontWeight": "bold",
            "color": "DarkRed",
            "backgroundColor": "Indigo",
            "marginLeft": "-1.0em",
            "marginRight": "0.2em",
            "paddingLeft": "0.0em",
            "borderWidth": "0.1em",
            "borderStyle": "solid",
            "borderColor": "OrangeRed",
            "borderRadius": "50%",
            "verticalAlign": "super",
            "textAlign": "center",
        },
        StyleContext(),
    )
    assert style is not None
    assert style.model_dump() == {
        "fontSize": "1.3rem",
        "fontWeight": "bold",
        "color": "darkred",
        "backgroundColor": "indigo",
        "marginLeft": "-1.3rem",
        "marginRight": "0.26rem",
        "paddingLeft": "0rem",
        "borderWidth": "0.13rem",
        "borderStyle": "solid",
        "borderColor": "orangered",
        "borderRadius": "50%",
        "verticalAlign": "super",
        "textAlign": "center",
    }
    assert context.font_size == 1.3
    assert "style" not in DictionaryNode(text="普通文字").model_dump()
    relative, _ = sanitize_style({"fontSize": "0.75rem"}, context)
    assert relative is not None and relative.fontSize == "0.75rem"


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("position", "fixed"),
        ("width", "999vw"),
        ("display", "none"),
        ("--color", "red"),
        ("backgroundImage", "url(https://invalid.test/a)"),
        ("color", "var(--foreground)"),
        ("color", "red;position:fixed"),
        ("color", "rgb(256,0,0)"),
        ("color", "rgba(0,0,0,2)"),
        ("color", "expression(alert(1))"),
        ("color", "url(data:image/svg+xml,bad)"),
        ("fontSize", "calc(1rem * 9999)"),
        ("fontSize", "999em"),
        ("fontSize", "0.01px"),
        ("marginLeft", "-999px"),
        ("marginTop", "-1em"),
        ("marginLeft", "100vw"),
        ("paddingLeft", "-1px"),
        ("paddingTop", "999rem"),
        ("borderWidth", "5em"),
        ("borderRadius", "999%"),
        ("verticalAlign", "999px"),
        ("textAlign", "garbage"),
        ("color", {"nested": "red"}),
        ("fontSize", True),
    ],
)
def test_rejects_unknown_dangerous_and_unbounded_values(key: str, value: object) -> None:
    style, context = sanitize_style({key: value}, StyleContext())
    assert style is None
    assert context == StyleContext()


def test_relative_font_and_cumulative_indentation_stay_bounded() -> None:
    context = StyleContext()
    for _ in range(40):
        style, context = sanitize_style(
            {"fontSize": "130%", "marginLeft": "-1em", "paddingRight": "1em"}, context
        )
        assert style is not None or context.font_size > 1
        assert 0.5 <= context.font_size <= 2.5
        assert -2 <= context.left <= 8 and -2 <= context.right <= 8
    for _ in range(40):
        _, context = sanitize_style({"fontSize": "50%", "paddingLeft": "2rem"}, context)
        assert 0.5 <= context.font_size <= 2.5
        assert -2 <= context.left <= 8


def styled_definition() -> dict[str, object]:
    return {
        "type": "structured-content",
        "content": {
            "tag": "div",
            "style": {"fontSize": "1.3em", "marginLeft": "-1em"},
            "content": {
                "tag": "span",
                "style": {"fontSize": "0.9em", "color": "LimeGreen"},
                "content": "合成释义",
            },
        },
    }


@pytest.mark.asyncio
async def test_existing_v2_source_upgrades_once_per_shared_definition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    await store.import_stream(chunks(archive([record("雨", definitions=[styled_definition()])])))
    expected = (await store.find_terms(["雨"]))[0].definitions
    with sqlite3.connect(store.path) as connection:
        identity, compressed = connection.execute("SELECT id, payload FROM definitions").fetchone()
        envelope = json.loads(zlib.decompress(compressed))
        envelope.pop("tree_version")
        envelope["nodes"] = [{"text": "旧渲染树不含新样式"}]
        connection.execute(
            "UPDATE definitions SET payload = ? WHERE id = ?",
            (zlib.compress(json.dumps(envelope).encode()), identity),
        )
    calls = 0
    original = dictionary_store._nodes  # pyright: ignore[reportPrivateUsage]

    def counted(
        value: object, depth: int = 0, context: StyleContext | None = None
    ) -> list[DictionaryNode]:
        nonlocal calls
        calls += 1
        return original(value, depth, context)

    monkeypatch.setattr(dictionary_store, "_nodes", counted)
    async with DictionaryStore(store.path).snapshot() as snapshot:
        entries = await snapshot.find_terms(["雨"])
        first = await snapshot.load_definitions(entries)
        assert first[0].definitions == expected and calls > 0
        after_first = calls
        second = await snapshot.load_definitions(entries)
        assert second[0].definitions is first[0].definitions and calls == after_first
    with sqlite3.connect(store.path) as connection:
        assert connection.execute("SELECT payload FROM definitions").fetchone()[0] == zlib.compress(
            json.dumps(envelope).encode()
        )


@pytest.mark.asyncio
async def test_fresh_tree_does_not_resanitize_and_api_does_not_expand_plain_nodes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with chat_client(tmp_path / "app.db") as (client, _):
        imported = await client.post(
            "/api/dictionary/import",
            content=archive([record("雨", definitions=[styled_definition(), "普通释义"])]),
        )
        assert imported.status_code == 200

        def unexpected(*_: object) -> list[DictionaryNode]:
            raise AssertionError("Fresh sanitized nodes must not reparse their source")

        monkeypatch.setattr(dictionary_store, "_nodes", unexpected)
        response = await client.post("/api/dictionary/lookup", json={"text": "雨"})
        assert response.status_code == 200, response.text
        nodes = response.json()["matches"][0]["definitions"]
        assert nodes[0]["style"] == {"fontSize": "1.3rem", "marginLeft": "-1.3rem"}
        assert nodes[0]["content"][0]["style"] == {"fontSize": "1.17rem", "color": "limegreen"}
        assert "style" not in nodes[1]
