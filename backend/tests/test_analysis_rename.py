"""Metadata renames preserve immutable content and serialize with revision writes."""

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from race_helpers import paused_task
from sqlalchemy.ext.asyncio import AsyncSession
from test_chat_api import chat_client
from test_manual_analyses import create_payload, revision_payload, seed_segment

from app.services import analyses
from app.services.sources import begin_write


def snapshot_content(database: Path) -> dict[str, list[tuple[Any, ...]]]:
    with sqlite3.connect(database) as connection:
        return {
            table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
            for table in ("analysis_revisions", "analysis_sections", "runs", "segments")
        }


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", ["manual", "generated"])
async def test_rename_changes_only_metadata_and_retries_without_touching_time(
    tmp_path: Path, origin: str
) -> None:
    database = tmp_path / "rename.db"
    async with chat_client(database) as (client, app):
        _, segment = await seed_segment(client)
        async with app.state.session_factory() as session:
            await begin_write(session)
            document = (
                await analyses.create_analysis(
                    session,
                    segment_id=segment["id"],
                    source_md="## 文法\n正文\n",
                    operation_key="rename:seed",
                    origin=origin,
                    title="原标题",
                )
            ).model_dump(mode="json")
            await session.commit()
        content = snapshot_content(database)
        url = f"/api/analyses/{document['id']}"
        payload = {"title": "  自定义e\u0301  ", "expected_title": document["title"]}
        renamed = await client.patch(url, json=payload)
        assert renamed.status_code == 200, renamed.text
        metadata = renamed.json()
        assert metadata["title"] == "自定义é"
        assert metadata["updated_at"] != document["updated_at"]
        for key in ("id", "segment_id", "excerpt", "current_revision_id", "created_at"):
            assert metadata[key] == document[key]
        assert (await client.patch(url, json=payload)).json() == metadata
        # A stale expectation is also harmless when the desired title is already current.
        assert (
            await client.patch(url, json={"title": "自定义é", "expected_title": "更早标题"})
        ).json() == metadata
        detail = (await client.get(url)).json()
        assert detail == {**document, **metadata}
        assert (await client.get(f"/api/segments/{segment['id']}/analyses")).json() == [metadata]
        assert snapshot_content(database) == content


@pytest.mark.asyncio
async def test_rename_validation_and_legacy_expected_titles(tmp_path: Path) -> None:
    database = tmp_path / "validation.db"
    async with chat_client(database) as (client, _app):
        _, segment = await seed_segment(client)
        document = (
            await client.post(
                f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
            )
        ).json()
        url = f"/api/analyses/{document['id']}"
        for title in ("", " \n\t ", "あ" * 201):
            response = await client.patch(
                url, json={"title": title, "expected_title": document["title"]}
            )
            assert response.status_code == 422, response.text
        assert (await client.get(url)).json() == document
        boundary = await client.patch(
            url, json={"title": " " + "e\u0301" * 200 + " ", "expected_title": document["title"]}
        )
        assert boundary.status_code == 200, boundary.text
        assert boundary.json()["title"] == "é" * 200
        # Historical metadata is compared after NFC, without stripping or imposing new limits.
        for legacy_title in (" \t ", "旧" * 201, "e\u0301"):
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "UPDATE analyses SET title = ? WHERE id = ?", (legacy_title, document["id"])
                )
            response = await client.patch(
                url, json={"title": "新标题", "expected_title": legacy_title}
            )
            assert response.status_code == 200, response.text
            assert response.json()["title"] == "新标题"


@pytest.mark.asyncio
async def test_concurrent_renames_have_one_winner_and_stale_requests_do_not_overwrite(
    tmp_path: Path,
) -> None:
    async with chat_client(tmp_path / "conflict.db") as (client, _app):
        _, segment = await seed_segment(client)
        document = (
            await client.post(
                f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
            )
        ).json()
        url = f"/api/analyses/{document['id']}"
        responses = await asyncio.gather(
            *(
                client.patch(url, json={"title": title, "expected_title": document["title"]})
                for title in ("标题甲", "标题乙")
            )
        )
        assert sorted(response.status_code for response in responses) == [200, 409]
        winner = next(response.json() for response in responses if response.status_code == 200)
        conflict = next(response.json() for response in responses if response.status_code == 409)
        assert "标题已变化" in conflict["detail"]
        current = (await client.get(url)).json()
        assert current["title"] == winner["title"]
        assert current["updated_at"] == winner["updated_at"]


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", ["source", "segment", "analysis", "missing"])
async def test_deleted_targets_and_parents_cannot_be_renamed(tmp_path: Path, deleted: str) -> None:
    database = tmp_path / "deleted.db"
    async with chat_client(database) as (client, _app):
        source, segment = await seed_segment(client)
        document = (
            await client.post(
                f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
            )
        ).json()
        url = f"/api/analyses/{document['id']}"
        if deleted in ("source", "segment"):
            # Leave the Analysis active to exercise the parent gate independently of cascades.
            table = "sources" if deleted == "source" else "segments"
            parent_id = source if deleted == "source" else segment["id"]
            with sqlite3.connect(database) as connection:
                connection.execute(
                    f"UPDATE {table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", (parent_id,)
                )
            response = None
        elif deleted == "analysis":
            response = await client.delete(url)
        else:
            response = None
            url = "/api/analyses/missing"
        if response is not None:
            assert response.status_code == 204, response.text
        renamed = await client.patch(
            url, json={"title": "新标题", "expected_title": document["title"]}
        )
        assert renamed.status_code == 404, renamed.text


@pytest.mark.asyncio
@pytest.mark.parametrize("first", ["rename", "revision"])
async def test_rename_and_revision_interleaving_preserves_both_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, first: str
) -> None:
    async with chat_client(tmp_path / "revision-race.db") as (client, _app):
        _, segment = await seed_segment(client)
        document = (
            await client.post(
                f"/api/segments/{segment['id']}/analyses", json=create_payload(segment)
            )
        ).json()
        url = f"/api/analyses/{document['id']}"
        entered, release = asyncio.Event(), asyncio.Event()
        original = analyses.begin_write
        delayed_once = False

        async def delayed(session: AsyncSession) -> None:
            nonlocal delayed_once
            if not delayed_once:
                delayed_once = True
                entered.set()
                await release.wait()
            await original(session)

        monkeypatch.setattr(analyses, "begin_write", delayed)
        rename_body = {"title": "用户新标题", "expected_title": document["title"]}
        revision_body = revision_payload(segment, document, "## 新块\n新正文\n")
        pending_request = (
            client.post(url + "/revisions", json=revision_body)
            if first == "rename"
            else client.patch(url, json=rename_body)
        )
        async with asyncio.timeout(5), paused_task(pending_request, entered, release) as pending:
            winning = (
                await client.patch(url, json=rename_body)
                if first == "rename"
                else await client.post(url + "/revisions", json=revision_body)
            )
            assert winning.status_code == 200, winning.text
        assert pending.result().status_code == 200, pending.result().text
        current = (await client.get(url)).json()
        revision = winning.json() if first == "revision" else pending.result().json()
        rename = winning.json() if first == "rename" else pending.result().json()
        assert current["title"] == "用户新标题"
        assert current["source_md"] == revision_body["source_md"]
        assert current["revision_id"] == revision["revision_id"]
        assert current["sections"] == revision["sections"]
        if first == "revision":
            assert rename["current_revision_id"] == revision["revision_id"]
            assert rename["excerpt"] == revision["excerpt"]
        old = (await client.get(url, params={"revision_id": document["revision_id"]})).json()
        assert old["source_md"] == document["source_md"]
        assert old["sections"] == document["sections"]
