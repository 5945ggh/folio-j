"""External requests contain current learning content without writes or private state."""

import sqlite3
from pathlib import Path

import pytest
from support_api import accept, chat_client, seed_chat
from test_segment_provenance import compiled_provenance, create_segment, provenance, upload


def database_dump(database: Path) -> list[str]:
    with sqlite3.connect(database) as connection:
        return list(connection.iterdump())


@pytest.mark.asyncio
async def test_prompt_without_model_or_initialized_settings_is_read_only(tmp_path: Path) -> None:
    database = tmp_path / "fresh.db"
    async with chat_client(database) as (client, _app):
        source = (
            await client.post(
                "/api/sources",
                json={"title": "作品名", "description": "作品の背景", "note": "秘密の管理メモ"},
            )
        ).json()
        segment = (
            await client.post(
                f"/api/sources/{source['id']}/segments",
                json={
                    "text": "昨日は雨だった。",
                    "context_before": "朝のこと。",
                    "context_after": "今日は晴れだ。",
                    "translation": "昨天是雨天。",
                    "transcription": "きのうはあめだった",
                    "source_ref": "手入力の出典",
                    "note": "片段的私有备注",
                },
            )
        ).json()
        before = database_dump(database)
        response = await client.get(f"/api/segments/{segment['id']}/explanation-prompt")
        assert response.status_code == 200, response.text
        assert set(response.json()) == {"prompt"}
        prompt = response.json()["prompt"]
        for expected in (
            "作品名",
            "作品の背景",
            "昨日は雨だった。",
            "朝のこと。",
            "今日は晴れだ。",
            "昨天是雨天。",
            "きのうはあめだった",
            "手入力の出典",
            "母语：中文",
            "当前预设：默认讲解",
            "完整的普通 Markdown 正文",
            "## 标题",
        ):
            assert expected in prompt
        assert "秘密の管理メモ" not in prompt
        assert "片段的私有备注" not in prompt
        assert database_dump(database) == before
        assert (await client.get(f"/api/segments/{segment['id']}")).json()["text_locked_at"] is None


@pytest.mark.asyncio
async def test_prompt_uses_latest_content_and_default_preferences_without_history(
    tmp_path: Path,
) -> None:
    database = tmp_path / "current.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        segment_id = seed["segment"]["id"]
        url = f"/api/segments/{segment_id}/explanation-prompt"
        assert (
            await client.patch(
                f"/api/segments/{segment_id}",
                json={"expected_revision": 1, "text": "今日は晴れだ。", "context_before": ""},
            )
        ).status_code == 200
        assert (
            await client.put(
                "/api/settings/profile",
                json={
                    "native_language": "英语",
                    "explain_language": "英语",
                    "level_note": "入门学习背景",
                },
            )
        ).status_code == 200
        style = (
            await client.post(
                "/api/settings/styles",
                json={"name": "新的默认预设", "body_md": "解释助词的作用。"},
            )
        ).json()
        defaults = {**seed["settings"]["defaults"], "style_id": style["id"]}
        assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
        await accept(
            client,
            seed,
            expected_segment_revision=2,
            question="私有历史标记",
        )
        before = database_dump(database)
        response = await client.get(url)
        assert response.status_code == 200, response.text
        prompt = response.json()["prompt"]
        for expected in ("今日は晴れだ。", "母语：英语", "入门学习背景", "解释助词的作用。"):
            assert expected in prompt
        for excluded in (
            "昨日は雨だった。",
            "朝のこと。",
            "私有历史标记",
            "fictional-chat-secret",
            "私有管理备注",
            "片段管理备注",
            "tools_v5",
            "save_analysis",
            "generate_analysis",
            seed["thread"]["id"],
            seed["provider"]["id"],
        ):
            assert excluded not in prompt
        assert database_dump(database) == before
        defaults["style_id"] = None
        assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
        prompt = (await client.get(url)).json()["prompt"]
        assert "解释助词的作用。" not in prompt
        assert "未选择讲解预设" in prompt


@pytest.mark.asyncio
@pytest.mark.parametrize("deleted", ["segment", "source", "missing"])
async def test_prompt_obeys_segment_and_source_visibility(tmp_path: Path, deleted: str) -> None:
    async with chat_client(tmp_path / "deleted.db") as (client, _app):
        source = (await client.post("/api/sources", json={"title": "作品"})).json()
        segment = (
            await client.post(
                f"/api/sources/{source['id']}/segments",
                json={"text": "原文"},
            )
        ).json()
        segment_id = segment["id"]
        if deleted == "missing":
            segment_id = "missing"
        else:
            target = f"segments/{segment_id}" if deleted == "segment" else f"sources/{source['id']}"
            assert (await client.delete(f"/api/{target}")).status_code == 204
        assert (
            await client.get(f"/api/segments/{segment_id}/explanation-prompt")
        ).status_code == 404


@pytest.mark.asyncio
async def test_prompt_uses_validated_material_provenance_and_degrades_deleted_material(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "provenance.db") as (client, _app):
        source = (await client.post("/api/sources", json={"title": "作品"})).json()
        material = await upload(client, source["id"])
        response = await create_segment(client, source["id"], provenance(material))
        assert response.status_code == 201, response.text
        url = f"/api/segments/{response.json()['id']}/explanation-prompt"
        prompt = (await client.get(url)).json()["prompt"]
        assert "が𠮷" in prompt
        assert "引用検証" in prompt
        assert "同じ章" in prompt
        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        prompt = (await client.get(url)).json()["prompt"]
        assert "引用検証" in prompt
        assert "原材料已删除" in prompt
        assert "同じ章" not in prompt
