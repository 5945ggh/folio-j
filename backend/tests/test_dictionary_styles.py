"""Bounded package and inline presentation, including indexes from prior versions."""

import asyncio
import errno
import json
import sqlite3
import threading
import zlib
from contextlib import closing
from pathlib import Path

import pytest
from support_api import chat_client
from support_dictionary_store import archive, chunks, installed_path, record

from app.dictionary_schemas import DictionaryNode
from app.services import dictionary_store
from app.services.dictionary_store import DictionaryStore
from app.services.dictionary_styles import StyleContext, sanitize_style
from app.services.dictionary_stylesheet import MAX_STYLESHEET_BYTES, DictionaryStylesheet, StyleNode


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
    with sqlite3.connect(installed_path(store, await store.status())) as connection:
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
        value: object,
        depth: int = 0,
        context: StyleContext | None = None,
        stylesheet: DictionaryStylesheet | None = None,
        ancestors: tuple[StyleNode, ...] = (),
    ) -> list[DictionaryNode]:
        nonlocal calls
        calls += 1
        return original(value, depth, context, stylesheet, ancestors)

    monkeypatch.setattr(dictionary_store, "_nodes", counted)
    async with DictionaryStore(store.path).snapshot() as snapshot:
        entries = await snapshot.find_terms(["雨"])
        first = await snapshot.load_definitions(entries)
        assert first[0].definitions == expected and calls > 0
        after_first = calls
        second = await snapshot.load_definitions(entries)
        assert second[0].definitions is first[0].definitions and calls == after_first
    with sqlite3.connect(installed_path(store, await store.status())) as connection:
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

        async def unexpected_source(*_: object) -> str:
            raise AssertionError("Fresh trees must not read the retained stylesheet")

        monkeypatch.setattr(dictionary_store, "_nodes", unexpected)
        monkeypatch.setattr(
            dictionary_store.DictionarySnapshot, "_read_stylesheet_source", unexpected_source
        )
        response = await client.post("/api/dictionary/lookup", json={"text": "雨"})
        assert response.status_code == 200, response.text
        nodes = response.json()["matches"][0]["definitions"]
        assert nodes[0]["style"] == {"fontSize": "1.3rem", "marginLeft": "-1.3rem"}
        assert nodes[0]["content"][0]["style"] == {"fontSize": "1.17rem", "color": "limegreen"}
        assert "style" not in nodes[1]


def package_definition() -> dict[str, object]:
    return {
        "type": "structured-content",
        "content": [
            {
                "tag": "ul",
                "data": {"content": "glossary"},
                "style": {"color": "forestgreen", "paddingTop": "0.5em"},
                "content": [
                    {
                        "tag": "li",
                        "lang": "ja",
                        "content": {
                            "tag": "span",
                            "data": {"senseType": "primary"},
                            "content": "雨",
                        },
                    },
                ],
            },
            {"tag": "ul", "data": {"content": "other"}, "content": ["別"]},
        ],
    }


_PACKAGE_CSS = """
/* Official Yomitan test dictionary selector. */
ul[data-sc-content='glossary'] { color: #ffff00; }
.structured-content ul[data-sc-content=glossary] { font-weight: 700; }
.structured-content > ul[data-sc-content=glossary] li[lang=ja] > [data-sc-sense-type] {
    color: #fff; color: url(https://example.invalid/x);
    font-weight: bold; background: rgb(8, 12, 20);
    margin: 1em 0.5em; border: 1px solid blue;
}
ul[data-sc-content] { color: blue; padding: 0.25em 0.5em; font-weight: 100; }
ul[data-sc-content] { padding-left: -1px; }
[data-sc-content=glossary] {
    color: orange !important; font-size: 1.25em; font-size: -10%;
    margin-left: -0.5em;
    margin-top: 9999px; position: fixed;
    background-image: url(https://example.invalid/x);
}
[data-sc-content=glossary], [data-sc-content=other] { text-align: center }
[data-sc-sense-type] a, [data-sc-sense-type]:hover { color: pink; }
@import url(https://example.invalid/styles.css);
@media (prefers-color-scheme: dark) { ul { color: pink !important; } }
body > ul { color: green !important; }
"""


@pytest.mark.asyncio
async def test_package_styles_use_one_bounded_definition_tree_for_lookup(tmp_path: Path) -> None:
    async with chat_client(tmp_path / "app.db") as (client, _):
        uploaded = archive(
            [record("雨", definitions=[package_definition()])], stylesheet=_PACKAGE_CSS
        )
        imported = await client.post("/api/dictionary/library/import", content=uploaded)
        assert imported.status_code == 200, imported.text
        response = await client.post("/api/dictionary/lookup", json={"text": "雨"})
        assert response.status_code == 200, response.text
        glossary, other = response.json()["matches"][0]["definitions"]
    assert glossary["style"] == {
        "color": "orange",
        "fontSize": "1.25rem",
        "fontWeight": "700",
        "marginLeft": "-0.625rem",
        "paddingTop": "0.625rem",
        "paddingBottom": "0.3125rem",
        "paddingLeft": "0.625rem",
        "paddingRight": "0.625rem",
        "textAlign": "center",
    }
    assert set(glossary) == {"tag", "lang", "text", "content", "role", "style"}
    keyword = glossary["content"][0]["content"][0]
    assert keyword["content"][0]["text"] == "雨"
    assert keyword["style"] == {
        "color": "#fff",
        "fontWeight": "bold",
        "backgroundColor": "rgb(8, 12, 20)",
        "marginTop": "1.25rem",
        "marginBottom": "1.25rem",
        "marginLeft": "0.625rem",
        "marginRight": "0.625rem",
        "borderColor": "blue",
        "borderStyle": "solid",
        "borderWidth": "0.0625rem",
    }
    assert other["style"] == {
        "color": "blue",
        "fontWeight": "100",
        "paddingTop": "0.25rem",
        "paddingBottom": "0.25rem",
        "paddingLeft": "0.5rem",
        "paddingRight": "0.5rem",
        "textAlign": "center",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stylesheet", [b"\xff", " " * (MAX_STYLESHEET_BYTES + 1)], ids=["invalid-utf8", "oversized"]
)
async def test_unreadable_or_oversized_stylesheet_keeps_inline_presentation(
    tmp_path: Path, stylesheet: str | bytes
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    await store.import_stream(
        chunks(archive([record("雨", definitions=[styled_definition()])], stylesheet=stylesheet))
    )
    root = (await store.find_terms(["雨"]))[0].definitions[0]
    assert root.style is not None and root.style.fontSize == "1.3rem"


@pytest.mark.asyncio
async def test_same_zip_rebuilds_old_index_without_replacing_an_open_reader(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    raw = archive(
        [record("雨", definitions=[package_definition()])],
        stylesheet="ul[data-sc-content=glossary] { color: #ffff00 !important; }",
    )
    installed = await store.import_library_stream(chunks(raw))
    status = await store.status()
    old_path = installed_path(store, status)
    with closing(sqlite3.connect(old_path)) as connection, connection:
        connection.execute("DROP TABLE stylesheet")
        connection.execute("PRAGMA user_version = 0")
        for identity, _ in connection.execute("SELECT id, payload FROM definitions"):
            value = {
                "source": [package_definition()],
                "nodes": [{"text": "既有释义"}],
                "tree_version": dictionary_store.TREE_VERSION,
            }
            connection.execute(
                "UPDATE definitions SET payload = ? WHERE id = ?",
                (zlib.compress(json.dumps(value).encode()), identity),
            )

    original_unlink = Path.unlink
    original_build = dictionary_store._build  # pyright: ignore[reportPrivateUsage]
    build_barrier = threading.Barrier(2)
    busy = True

    def build_together(source: Path, target: Path) -> dictionary_store.DictionaryStatus:
        result = original_build(source, target)
        build_barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(dictionary_store, "_build", build_together)

    def cannot_remove_open_index(path: Path, missing_ok: bool = False) -> None:
        if busy and path == old_path:
            raise PermissionError(errno.EACCES, "SQLite file open", path)
        original_unlink(path, missing_ok=missing_ok)

    original_replace = dictionary_store.os.replace

    def cannot_move_open_index(source: Path, target: Path) -> None:
        if busy and old_path in {source, target}:
            raise PermissionError(errno.EACCES, "SQLite file open", old_path)
        original_replace(source, target)

    monkeypatch.setattr(Path, "unlink", cannot_remove_open_index)
    monkeypatch.setattr(dictionary_store.os, "replace", cannot_move_open_index)
    async with store.snapshot() as reader:
        upgraded, concurrent = await asyncio.gather(
            store.import_library_stream(chunks(raw)),
            DictionaryStore(store.path).import_library_stream(chunks(raw)),
        )
        assert upgraded.already_installed and concurrent == upgraded
        assert upgraded.library == installed.library
        retained = (await reader.load_definitions(await reader.find_terms(["雨"])))[0]
        assert retained.definitions[0].text == "既有释义" and old_path.is_file()
        current = (await store.find_terms(["雨"]))[0].definitions[0]
        assert current.style is not None and current.style.color == "#ffff00"
        monkeypatch.setattr(dictionary_store, "_build", original_build)
        assert not (await store.delete(installed.dictionary_id)).dictionaries
        reinstalled = await store.import_library_stream(chunks(raw))
        assert not reinstalled.already_installed and reinstalled.library == installed.library
        current = (await store.find_terms(["雨"]))[0].definitions[0]
        assert current.style is not None and current.style.color == "#ffff00"
        assert old_path.is_file()
        busy = False
    assert not old_path.exists()
    assert len(list(store.library_path.glob("*.sqlite3"))) == 2
    duplicate = await DictionaryStore(store.path).import_library_stream(chunks(raw))
    assert duplicate == upgraded


@pytest.mark.asyncio
async def test_stale_trees_recompile_with_retained_package_styles_across_batches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = DictionaryStore(tmp_path / "dictionary.sqlite3")
    terms = [f"雨{i}" for i in range(40)]
    raw = archive(
        [
            record(term, sequence=i, definitions=[package_definition(), term])
            for i, term in enumerate(terms)
        ],
        stylesheet="[data-sc-content=glossary] { color: teal !important; }",
    )
    status = await store.import_stream(chunks(raw))
    path = installed_path(store, status)
    with closing(sqlite3.connect(path)) as connection, connection:
        for identity, payload in connection.execute("SELECT id, payload FROM definitions"):
            envelope = json.loads(zlib.decompress(payload))
            envelope["tree_version"] = "past"
            connection.execute(
                "UPDATE definitions SET payload = ? WHERE id = ?",
                (zlib.compress(json.dumps(envelope).encode()), identity),
            )
    original = dictionary_store.compile_stylesheet
    calls = 0

    def counted(source: str | None) -> DictionaryStylesheet | None:
        nonlocal calls
        calls += 1
        return original(source)

    monkeypatch.setattr(dictionary_store, "compile_stylesheet", counted)
    definitions = await store.find_terms(terms)
    assert len(definitions) == 40 and calls == 1
    for entry in definitions:
        style = entry.definitions[0].style
        assert style is not None and style.color == "teal"
