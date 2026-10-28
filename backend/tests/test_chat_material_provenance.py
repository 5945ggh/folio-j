"""Readable material provenance is frozen and follows the ordinary context stream."""

import copy
import json
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, NoReturn
from uuid import uuid4

import pytest
from chat_tool_fixture import install_text_turn
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from test_analysis_agent import refreshed
from test_chat_api import accept, chat_client, question_payload, seed_chat
from test_chat_prompt_scope import accepted_input
from test_material_context_snapshot import snapshot_bytes, stored_origin
from test_segment_provenance import compiled_provenance, create_segment, provenance, upload

from app.jobs import runtime
from app.llm import adapters
from app.services import context_provenance


@pytest.fixture(autouse=True)
def offline_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    monkeypatch.setattr("app.llm.adapters.discover_models", discover)
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)


async def material_chat(client: AsyncClient) -> dict[str, Any]:
    seed = await seed_chat(client)
    material = await upload(client, seed["source"]["id"])
    created = await create_segment(
        client,
        seed["source"]["id"],
        provenance(material),
        source_ref="用户填写的出处补充",
        note="不提供给模型的片段管理备注",
    )
    assert created.status_code == 201, created.text
    segment = created.json()
    response = await client.post(
        f"/api/segments/{segment['id']}/threads", json={"request_id": str(uuid4())}
    )
    assert response.status_code == 201, response.text
    return {**seed, "segment": segment, "thread": response.json(), "material": material}


@pytest.mark.asyncio
async def test_manual_segment_keeps_free_text_origin_and_excludes_management_notes(
    tmp_path: Path,
) -> None:
    database = tmp_path / "manual.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        changed = await client.patch(
            f"/api/segments/{seed['segment']['id']}", json={"source_ref": "手动记录：第42页"}
        )
        assert changed.status_code == 200, changed.text
        job = await accept(client, await refreshed(client, seed))
        snapshot = accepted_input(database, job["id"])
        material = snapshot["messages"][-2]["content"]
        assert "手动记录：第42页" in material
        assert "未关联材料出处" in material
        assert snapshot["segment"]["material_provenance"] is None
        assert "note" not in snapshot["segment"] and "note" not in snapshot["source"]
        assert "私有管理备注" not in json.dumps(snapshot, ensure_ascii=False)
        assert "片段管理备注" not in json.dumps(snapshot, ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["none", "rename", "delete"])
async def test_material_origin_is_frozen_and_only_changes_append_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    captured: list[list[dict[str, Any]] | None] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        captured.append(copy.deepcopy(snapshot.messages))
        return adapters.GenerateResult("离线回答。", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    database = tmp_path / f"{change}.db"
    async with chat_client(database) as (client, app):
        seed = await material_chat(client)
        first = await accept(client, seed)
        frozen = snapshot_bytes(database, first["id"])
        initial = json.loads(frozen)
        origin = stored_origin(database, seed["segment"]["id"])
        expected = "引用検証 · 同じ章 · 章内约 16%"
        assert initial["segment"]["material_provenance"] == {
            "display": expected,
            "status": "resolved",
            "material_id": seed["material"]["id"],
            "version_id": seed["material"]["version_id"],
        }
        assert expected in initial["messages"][-2]["content"]
        assert "用户填写的出处补充" in initial["messages"][-2]["content"]
        assert expected not in initial["messages"][0]["content"]
        assert expected not in initial["messages"][-1]["content"]
        assert "不提供给模型的片段管理备注" not in json.dumps(initial, ensure_ascii=False)

        if change == "rename":
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "UPDATE materials SET title='現在の題名', "
                    "metadata_revision=metadata_revision+1 WHERE id=?",
                    (seed["material"]["id"],),
                )
        elif change == "delete":
            response = await client.delete(f"/api/materials/{seed['material']['id']}")
            assert response.status_code == 204, response.text

        await runtime.execute_job(app, first["id"])
        assert captured == [initial["messages"]]
        assert (await client.get(f"/api/jobs/{first['id']}")).json()["status"] == "succeeded"
        assert snapshot_bytes(database, first["id"]) == frozen
        current = await refreshed(client, seed)
        assert current["segment"]["revision"] == seed["segment"]["revision"]
        second = await accept(client, current, question="请继续")
        following = accepted_input(database, second["id"])
        prefix = initial["messages"]
        assert following["messages"][: len(prefix)] == prefix
        appended = following["messages"][len(prefix) + 1 :]
        assert len(appended) == (1 if change == "none" else 2)
        assert "请继续" in appended[-1]["content"]
        if change == "rename":
            assert "現在の題名 · 同じ章 · 章内约 16%" in appended[0]["content"]
            assert expected not in appended[0]["content"]
        elif change == "delete":
            assert "原材料已删除" in appended[0]["content"]
            assert "引用検証" in appended[0]["content"]
            assert "章内约" not in appended[0]["content"]
            assert following["segment"]["material_provenance"]["status"] == "material_deleted"

        await runtime.execute_job(app, second["id"])
        third = await accept(client, await refreshed(client, seed), question="接着说")
        latest = accepted_input(database, third["id"])
        assert len(latest["messages"]) == len(following["messages"]) + 2
        assert snapshot_bytes(database, first["id"]) == frozen
        assert stored_origin(database, seed["segment"]["id"]) == origin


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["version", "bundle", "foreign"])
async def test_unavailable_origin_keeps_status_without_unverified_location(
    tmp_path: Path, change: str
) -> None:
    database = tmp_path / f"{change}.db"
    async with chat_client(database) as (client, _app):
        seed = await material_chat(client)
        other = (await client.post("/api/sources", json={"title": "其他来源"})).json()
        with sqlite3.connect(database) as connection:
            if change == "version":
                connection.execute(
                    "UPDATE materials SET version_id='unavailable' WHERE id=?",
                    (seed["material"]["id"],),
                )
            elif change == "bundle":
                connection.execute(
                    "UPDATE materials SET compiled_bundle=? WHERE id=?",
                    (b"broken", seed["material"]["id"]),
                )
            else:
                connection.execute(
                    "UPDATE materials SET source_id=?, title='其他来源的材料名称' WHERE id=?",
                    (other["id"], seed["material"]["id"]),
                )
        job = await accept(client, seed)
        snapshot = accepted_input(database, job["id"])
        status, label = {
            "version": ("version_unavailable", "材料版本不可用"),
            "bundle": ("snapshot_mismatch", "原文快照不匹配"),
            "foreign": ("invalid_reference", "材料出处记录无效"),
        }[change]
        assert snapshot["segment"]["material_provenance"]["status"] == status
        material = snapshot["messages"][-2]["content"]
        assert label in material
        assert "同じ章" not in material and "章内约" not in material
        assert "其他来源的材料名称" not in json.dumps(snapshot, ensure_ascii=False)


@pytest.mark.asyncio
async def test_material_change_before_acceptance_rejects_without_partial_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "acceptance-race.db"
    async with chat_client(database) as (client, _app):
        seed = await material_chat(client)
        original = context_provenance.prepare

        async def prepare_then_change(
            session: AsyncSession, segment_id: str
        ) -> context_provenance.PreparedContextProvenance | None:
            prepared = await original(session, segment_id)
            with sqlite3.connect(database) as connection:
                connection.execute(
                    "UPDATE materials SET title='受理前的新名称' WHERE id=?",
                    (seed["material"]["id"],),
                )
            return prepared

        monkeypatch.setattr(context_provenance, "prepare", prepare_then_change)
        response = await client.post(
            f"/api/threads/{seed['thread']['id']}/jobs", json=question_payload(seed)
        )
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "stale_provenance"
        assert (await client.get(f"/api/segments/{seed['segment']['id']}")).json() == seed[
            "segment"
        ]
        assert (await client.get(f"/api/threads/{seed['thread']['id']}")).json() == seed["thread"]
        with sqlite3.connect(database) as connection:
            for table in ("chat_jobs", "chat_messages", "runs"):
                assert connection.execute(f"SELECT count(*) FROM {table}").fetchone() == (0,)


@pytest.mark.asyncio
async def test_existing_request_replays_without_resolving_changed_material(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "replay.db"
    async with chat_client(database) as (client, _app):
        seed = await material_chat(client)
        payload = question_payload(seed)
        url = f"/api/threads/{seed['thread']['id']}/jobs"
        first = await client.post(url, json=payload)
        assert first.status_code == 202, first.text
        frozen = snapshot_bytes(database, first.json()["id"])
        assert (await client.delete(f"/api/materials/{seed['material']['id']}")).status_code == 204

        async def forbidden_prepare(*_args: object) -> NoReturn:
            raise AssertionError("幂等重放不应重新解析出处")

        monkeypatch.setattr(context_provenance, "prepare", forbidden_prepare)
        replay = await client.post(url, json=payload)
        assert replay.status_code == 202, replay.text
        assert replay.json()["id"] == first.json()["id"]
        assert snapshot_bytes(database, first.json()["id"]) == frozen
