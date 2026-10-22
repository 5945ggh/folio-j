"""Independent context defaults survive restart and never rewrite learning content."""

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from test_source_segment import api_client

URL = "/api/settings/segment-context"
DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "before_sentences": 3,
    "after_sentences": 3,
    "before_characters": 200,
    "after_characters": 200,
    "revision": 0,
}
BUDGET_FIELDS = ("before_sentences", "after_sentences", "before_characters", "after_characters")


def update(**changes: Any) -> dict[str, Any]:
    values = {key: value for key, value in DEFAULTS.items() if key != "revision"}
    return {**values, "expected_revision": 0, **changes}


def old_content(database: Path) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
            for (table,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name != 'segment_context_settings'"
            )
        }


@pytest.mark.asyncio
async def test_default_roundtrip_restart_and_independent_save(tmp_path: Path) -> None:
    database = tmp_path / "settings.db"
    async with api_client(database) as client:
        defaults = await client.get(URL)
        assert defaults.status_code == 200 and defaults.json() == DEFAULTS
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT * FROM segment_context_settings").fetchall() == []
        general = (await client.get("/api/settings")).json()
        source_id = (await client.post("/api/sources", json={"title": "保持"})).json()["id"]
        segment = await client.post(
            f"/api/sources/{source_id}/segments",
            json={"text": "対象", "context_before": "保存された前文", "context_after": "後文"},
        )
        assert segment.status_code == 201, segment.text
        before = old_content(database)
        payload = update(
            enabled=False,
            before_sentences=0,
            after_sentences=100000,
            before_characters=100000,
            after_characters=0,
        )
        saved = await client.put(URL, json=payload)
        assert saved.status_code == 200, saved.text
        expected = {key: value for key, value in payload.items() if key != "expected_revision"}
        assert saved.json() == {**expected, "revision": 1}
        assert old_content(database) == before
        assert (await client.get("/api/settings")).json() == general
        assert (await client.get(f"/api/segments/{segment.json()['id']}")).json()[
            "context_before"
        ] == "保存された前文"
        assert (await client.put(URL, json=payload)).status_code == 409
        assert (await client.get(URL)).json() == saved.json()
        changed_general = await client.patch(
            "/api/settings", json={"profile": {**general["profile"], "level_note": "別の設定"}}
        )
        assert changed_general.status_code == 200, changed_general.text
        assert (await client.get(URL)).json() == saved.json()
    async with api_client(database) as client:
        assert (await client.get(URL)).json() == saved.json()
        second = await client.put(URL, json=update(expected_revision=1))
        assert second.status_code == 200, second.text
        assert second.json() == {**DEFAULTS, "revision": 2}


@pytest.mark.asyncio
@pytest.mark.parametrize("field", BUDGET_FIELDS)
@pytest.mark.parametrize("value", [-1, 100001, 1.5, "3", True, None])
async def test_budgets_are_bounded_strict_nonnegative_integers(
    tmp_path: Path, field: str, value: Any
) -> None:
    async with api_client(tmp_path / "invalid.db") as client:
        result = await client.put(URL, json=update(**{field: value}))
        assert result.status_code == 422, result.text
        assert (await client.get(URL)).json() == DEFAULTS


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"enabled": "true"},
        {"enabled": 1},
        {"enabled": None},
        {"expected_revision": -1},
        {"expected_revision": True},
        {"expected_revision": "0"},
        {"expected_revision": 0.5},
        {"extra": "ignored"},
    ],
)
async def test_other_fields_remain_strict(tmp_path: Path, changes: dict[str, Any]) -> None:
    async with api_client(tmp_path / "invalid.db") as client:
        assert (await client.put(URL, json=update(**changes))).status_code == 422
        assert (await client.get(URL)).json() == DEFAULTS


@pytest.mark.asyncio
async def test_put_requires_complete_group_and_serializes_first_write(tmp_path: Path) -> None:
    database = tmp_path / "concurrent.db"
    async with api_client(database) as client:
        assert (
            await client.put(URL, json={"enabled": False, "expected_revision": 0})
        ).status_code == 422
        first, second = await asyncio.gather(
            client.put(URL, json=update(before_sentences=1)),
            client.put(URL, json=update(before_sentences=2)),
        )
        assert sorted((first.status_code, second.status_code)) == [200, 409]
        winner = first if first.status_code == 200 else second
        loser = second if second.status_code == 409 else first
        assert loser.json()["detail"]["code"] == "settings_conflict"
        assert (await client.get(URL)).json() == winner.json()
        retry = await client.put(URL, json=update(before_sentences=9, expected_revision=1))
        assert retry.status_code == 200, retry.text
        assert retry.json()["before_sentences"] == 9 and retry.json()["revision"] == 2
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM segment_context_settings").fetchone() == (
            1,
        )
        for table in ("runs", "chat_threads", "chat_jobs"):
            assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)
