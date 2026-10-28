"""Check the actual accepted chat prompt and its offline Run snapshot."""

import json
import re
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


def declared_template_version(path: Path) -> str:
    match = re.search(r"\bversion:\s*([\w.-]+)", path.read_text().splitlines()[0])
    assert match is not None, path
    return match.group(1)


@pytest.mark.asyncio
async def test_accepted_template_versions_and_generation_tool_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded: list[str] = []
    get_template = context.ENV.get_template

    def track_template(name: str) -> Any:
        loaded.append(name)
        return get_template(name)

    monkeypatch.setattr(context.ENV, "get_template", track_template)
    database = tmp_path / "contract.db"
    async with chat_client(database) as (client, _app):
        seed = await seed_chat(client)
        job = await accept(client, seed)
        snapshot = accepted_input(database, job["id"])

    system_name = next(name for name in loaded if name.startswith("system_"))
    system_version = declared_template_version(context.PROMPTS / system_name)
    tools_name = snapshot["prompt_version"].split("+")[1]
    tool_contract = json.loads((context.PROMPTS / f"{tools_name}.json").read_text())
    assert (
        snapshot["prompt_version"]
        == f"{system_version}+tools_{tool_contract['version']}+context_v1+user_v4"
    )
    assert snapshot["tools"] == tool_contract["tools"]
    assert "writer_text" not in snapshot
    assert "writer_version" not in snapshot
    assert "saved_artifact_template" not in snapshot

    generation = next(
        tool["function"]
        for tool in snapshot["tools"]
        if tool["function"]["name"] == "save_analysis"
    )["parameters"]
    assert generation["properties"]["title"]["type"] == "string"
    assert generation["properties"]["title"]["maxLength"] == 200
    assert generation["properties"]["title"]["minLength"] == 1
    assert "title" not in generation.get("required", [])
    assert generation["required"] == ["source_md"]
    assert generation["properties"]["source_md"]["maxLength"] == 500000
    assert generation["additionalProperties"] is False

    # The accepted protocol message includes the versioned rules without rewriting them.
    system = snapshot["messages"][0]["content"]
    assert get_template(system_name).render().strip() in system


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
        assert [message["role"] for message in snapshot["messages"]] == ["system", "user", "user"]
        system = snapshot["messages"][0]["content"]
        material = snapshot["messages"][-2]["content"]
        user = snapshot["messages"][-1]["content"]
        assert "だった是什么用法？" in user
        assert "昨日は雨だった。" in material
        assert "昨日は雨だった。" not in user
        assert "昨日は雨だった。" not in system
        # Saved-document section guidance applies even with a custom or disabled style.
        assert "## 标题" in system

        if style_choice == "default":
            assert snapshot["style"]["id"] == seed["settings"]["defaults"]["style_id"]
            assert "## 标题" in material
        elif style_choice == "custom":
            assert snapshot["style"]["body_md"] == "只在需要时提示重音。"
            assert "只在需要时提示重音。" in material
        else:
            assert snapshot["style"] is None
            assert "未选择讲解预设" in material


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
        assert run["prompt_version"] == accepted["prompt_version"]

    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT messages FROM runs WHERE job_id = ?", (job["id"],)
        ).fetchone()
    assert row is not None
    assert json.loads(row[0]) == accepted["messages"]
    assert "以后只讨论读音。" not in json.dumps(captured, ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["none", "profile", "segment", "style", "protocol"])
async def test_successful_turn_only_appends_changed_context_modules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    from test_analysis_agent import refreshed

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        return adapters.GenerateResult("离线回答。", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    database = tmp_path / "incremental.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        first = await accept(client, seed)
        await runtime.execute_job(app, first["id"])
        assert (await client.get(f"/api/jobs/{first['id']}")).json()["status"] == "succeeded"
        prefix = accepted_input(database, first["id"])["messages"]
        changes: dict[str, Any] = {}
        if change == "profile":
            profile = {**seed["settings"]["profile"], "level_note": "能阅读中级小说"}
            response = await client.put("/api/settings/profile", json=profile)
            assert response.status_code == 200, response.text
        elif change == "segment":
            response = await client.patch(
                f"/api/segments/{seed['segment']['id']}",
                json={"expected_revision": seed["segment"]["revision"], "context_before": ""},
            )
            assert response.status_code == 200, response.text
        elif change == "style":
            changes["style_id"] = None
        elif change == "protocol":
            response = await client.patch(
                f"/api/providers/{seed['provider']['id']}", json={"protocol": "responses"}
            )
            assert response.status_code == 200, response.text
        second = await accept(client, await refreshed(client, seed), question="现在继续", **changes)
        accepted = accepted_input(database, second["id"])
        if change == "protocol":
            assert accepted["protocol_conversion"]["strategy"] == "history_material_v1"
            assert accepted["messages"][0]["role"] == "system"
            material = accepted["messages"][-2]["content"]
            assert "昨日は雨だった。" in material
            assert "学习背景" in material
            assert "## 标题" in material
            assert "现在继续" in accepted["messages"][-1]["content"]
            return
        assert accepted["messages"][: len(prefix)] == prefix
        # The successful assistant reply extends the saved input before the new turn.
        appended = accepted["messages"][len(prefix) + 1 :]
        assert "现在继续" in appended[-1]["content"]
        assert "昨日は雨だった。" not in appended[-1]["content"]
        if change == "none":
            assert len(appended) == 1
        else:
            assert len(appended) == 2
            material = appended[0]["content"]
            if change == "profile":
                assert "能阅读中级小说" in material
                assert "昨日は雨だった。" not in material
            elif change == "segment":
                assert "昨日は雨だった。" in material
                assert "朝のこと。" not in material
                assert "学习情况自述" not in material
            else:
                assert "未选择讲解预设" in material
                assert "昨日は雨だった。" not in material
        assert accepted["context_state"]


@pytest.mark.asyncio
async def test_failed_turn_does_not_advance_context_baseline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from test_analysis_agent import refreshed

    succeed = True

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        if not succeed:
            raise RuntimeError("offline failure")
        return adapters.GenerateResult("成功回答。", True, None, "{}")

    install_text_turn(monkeypatch, generate)
    database = tmp_path / "failed.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        first = await accept(client, seed)
        await runtime.execute_job(app, first["id"])
        profile = {**seed["settings"]["profile"], "level_note": "失败轮的新背景"}
        assert (await client.put("/api/settings/profile", json=profile)).status_code == 200
        failed = await accept(client, await refreshed(client, seed))
        succeed = False
        await runtime.execute_job(app, failed["id"])
        assert (await client.get(f"/api/jobs/{failed['id']}")).json()["status"] == "failed"
        retry = await accept(client, await refreshed(client, seed), question="再次继续")
        snapshot = accepted_input(database, retry["id"])
        assert "失败轮的新背景" in snapshot["messages"][-2]["content"]
        assert "再次继续" in snapshot["messages"][-1]["content"]
