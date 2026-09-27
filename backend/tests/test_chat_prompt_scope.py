"""Check the actual accepted chat prompt and its offline Run snapshot."""

import json
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from chat_tool_fixture import install_text_turn
from test_chat_api import accept, chat_client, seed_chat

from app.jobs import runtime
from app.llm import adapters
from app.services import context


def accepted_input(database: Path, job_id: str) -> dict[str, Any]:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT input_snapshot FROM chat_jobs WHERE id = ?", (job_id,)
        ).fetchone()
    assert row is not None
    return json.loads(row[0])


@pytest.mark.asyncio
@pytest.mark.parametrize("style_choice", ["default", "custom", "none"])
async def test_chat_system_scope_is_rendered_for_each_style_choice(
    tmp_path: Path, style_choice: str
) -> None:
    database = tmp_path / "chat.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        changes: dict[str, Any] = {}
        if style_choice == "custom":
            response = await client.post(
                "/api/settings/styles",
                json={"name": "只看发音", "body_md": "只在需要时提示重音。"},
            )
            assert response.status_code == 201, response.text
            changes["style_id"] = response.json()["id"]
        elif style_choice == "none":
            changes["style_id"] = None

        job = await accept(client, seed, question="这里的だった是什么用法？", **changes)
        snapshot = accepted_input(database, job["id"])
        assert snapshot["prompt_version"] == "v4+tools_v3"
        assert [message["role"] for message in snapshot["messages"]] == ["system", "user"]
        system = snapshot["messages"][0]["content"]
        user = snapshot["messages"][1]["content"]
        assert "だった是什么用法？" in user
        assert "昨日は雨だった。" in user
        assert "昨日は雨だった。" not in system

        # These constraints must survive selection of either preset and its explicit removal.
        assert "普通提问、比较、追问或讨论：直接回答当前问题" in system
        assert "不强制给出整段大意、结构总览、逐块解析或 Markdown 二级标题" in system
        assert "专题" in system and "不扩写为整个 Segment 的完整解析" in system
        assert "只有本轮明确要求总体讲解、完整解析" in system
        assert "不把上一轮的讲解或报告任务自动延续到本轮" in system
        assert (
            "主对话具备当前 Segment 的 Analysis 列表、读取、生成和 Section 局部编辑工具" in system
        )
        assert "收到运行时追加的专用写作分支要求时，直接输出讲解 Markdown 正文" in system
        assert "不再调用生成工具，也不声称已经保存" in system

        if style_choice == "default":
            assert snapshot["style"]["id"] == seed["settings"]["defaults"]["style_id"]
            assert "## 标题" in user
            assert "## 标题" not in system
        elif style_choice == "custom":
            assert snapshot["style"]["body_md"] == "只在需要时提示重音。"
            assert "只在需要时提示重音。" in user
            assert "## 标题" not in system
        else:
            assert snapshot["style"] is None
            assert "## 标题" not in system
            assert "本轮未选择讲解预设" in user


@pytest.mark.asyncio
async def test_run_reuses_accepted_prompt_after_style_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "chat.db"
    captured: list[list[dict[str, str]] | None] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        captured.append(snapshot.messages)
        return adapters.GenerateResult("过去式。", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        accepted = accepted_input(database, job["id"])
        style = accepted["style"]
        assert style is not None
        response = await client.put(
            f"/api/settings/styles/{style['id']}",
            json={"name": "改后的预设", "body_md": "以后只讨论读音。"},
        )
        assert response.status_code == 200, response.text

        def reject_late_template_load(_name: str) -> Any:
            raise AssertionError("worker must use the accepted messages without rerendering")

        monkeypatch.setattr(context, "PROMPT_VERSION", "future-version")
        monkeypatch.setattr(context.ENV, "get_template", reject_late_template_load)

        await runtime.execute_job(app, job["id"])
        assert captured == [accepted["messages"]]
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        run = (await client.get(f"/api/runs/{result['run_id']}")).json()
        assert run["prompt_version"] == accepted["prompt_version"] == "v4+tools_v3"

    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT messages FROM runs WHERE job_id = ?", (job["id"],)
        ).fetchone()
    assert row is not None
    assert json.loads(row[0]) == accepted["messages"]
    assert "以后只讨论读音。" not in json.dumps(captured, ensure_ascii=False)
