import io
import json
import zipfile
from collections.abc import AsyncGenerator
from pathlib import Path

from app.dictionary_schemas import DictionaryStatus
from app.services import dictionary_store
from app.services.dictionary_store import DictionaryStore


def archive(
    records: list[list[object]],
    *,
    title: str = "合成词典",
    version: int = 3,
    stylesheet: str | bytes | None = None,
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr(
            "index.json", json.dumps({"title": title, "format": version, "revision": "test-1"})
        )
        package.writestr("term_bank_1.json", json.dumps(records))
        if stylesheet is not None:
            package.writestr("styles.css", stylesheet)
    return output.getvalue()


def record(
    term: str, sequence: object = 1, definitions: list[object] | None = None
) -> list[object]:
    return [
        term,
        "アメ",
        "n",
        "",
        0,
        ["合成释义"] if definitions is None else definitions,
        sequence,
        "",
    ]


async def chunks(value: bytes) -> AsyncGenerator[bytes]:
    midpoint = len(value) // 2
    yield value[:midpoint]
    yield value[midpoint:]


def installed_path(store: DictionaryStore, status: DictionaryStatus) -> Path:
    return store.library_path / f"{status.dictionary_id}.sqlite3"


def seed_legacy(store: DictionaryStore, raw: bytes) -> DictionaryStatus:
    source = store.path.with_suffix(".zip")
    source.write_bytes(raw)
    try:
        return dictionary_store._build(source, store.path)  # pyright: ignore[reportPrivateUsage]
    finally:
        source.unlink()
