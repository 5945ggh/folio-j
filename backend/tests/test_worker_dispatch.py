"""API requests must reach background execution without manually invoking workers."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from support_api import accept, api_client, seed_chat
from test_manual_analyses import create_payload

from app.llm import adapters


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def discover(_url: str, _key: str | None) -> list[str]:
        return ["offline-model"]

    monkeypatch.setattr(adapters, "discover_models", discover)


async def wait_status(client: AsyncClient, path: str, expected: str) -> dict[str, Any]:
    async with asyncio.timeout(5):
        while True:
            response = await client.get(path)
            assert response.status_code == 200, response.text
            result = response.json()
            if result["status"] == expected:
                return result
            assert result["status"] not in {"failed", "interrupted"}, result
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_api_dispatches_chat_and_resumes_after_review_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    document: dict[str, Any] = {}
    calls = 0

    async def complete(
        snapshot: adapters.CallSnapshot,
        _key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_tool_name: Callable[[str], Awaitable[None]] | None = None,
    ) -> adapters.ToolTurn:
        nonlocal calls
        calls += 1
        assert snapshot.protocol == "chat_completions"
        if calls == 1:
            arguments = json.dumps(
                {
                    "analysis_id": document["id"],
                    "base_revision_id": document["revision_id"],
                    "sid": document["sections"][1]["uid"],
                    "title": "已审核标题",
                },
                ensure_ascii=False,
            )
            call = {"id": "edit-1", "name": "update_analysis_section", "arguments": arguments}
            history = {
                "role": "assistant",
                "content": "请审核标题修改",
                "tool_calls": [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {
                            "name": call["name"],
                            "arguments": arguments,
                        },
                    }
                ],
            }
            return adapters.ToolTurn("请审核标题修改", True, [call], [history], None, "{}")
        return adapters.ToolTurn(
            "修改已保存", True, [], [{"role": "assistant", "content": "修改已保存"}], None, "{}"
        )

    monkeypatch.setattr(adapters, "complete_with_tools", complete)
    async with api_client(tmp_path / "dispatch.db") as client:
        seed = await seed_chat(client)
        saved = await client.post(
            f"/api/segments/{seed['segment']['id']}/analyses",
            json=create_payload(seed["segment"]),
        )
        assert saved.status_code == 200, saved.text
        document = saved.json()
        seed["segment"] = (await client.get(f"/api/segments/{seed['segment']['id']}")).json()
        job = await accept(client, seed, question="请修改讲解标题")
        path = f"/api/jobs/{job['id']}"
        waiting = await wait_status(client, path, "waiting_review")
        assert waiting["review_proposal"]
        assert (await client.get(f"/api/analyses/{document['id']}")).json()[
            "revision_id"
        ] == document["revision_id"]
        approved = await client.post(
            path + "/decision",
            json={"expected_version": waiting["version"], "decision": "approve"},
        )
        assert approved.status_code == 200, approved.text
        finished = await wait_status(client, path, "succeeded")
        assert finished["assistant_message"]["content"] == "修改已保存"
        assert len(finished["artifacts"]) == 1
        assert calls == 2
        current = (await client.get(f"/api/analyses/{document['id']}")).json()
        assert current["sections"][1]["title"] == "已审核标题"
        assert current["revision_id"] != document["revision_id"]
        thread = (await client.get(f"/api/threads/{seed['thread']['id']}")).json()
        assert thread["active_job_id"] is None


@pytest.mark.asyncio
async def test_verification_request_runs_automatically_and_updates_model_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        await progress("离线验证完成")
        return adapters.GenerateResult("离线验证完成", True, None, "{}")

    monkeypatch.setattr(adapters, "generate_text", generate)
    async with api_client(tmp_path / "verification.db") as client:
        seed = await seed_chat(client)
        accepted = await client.post(
            f"/api/provider-models/{seed['model']['id']}/verifications", json={"stream": False}
        )
        assert accepted.status_code == 202, accepted.text
        run = await wait_status(client, f"/api/runs/{accepted.json()['id']}", "succeeded")
        assert run["output_text"] == "离线验证完成"
        model = (await client.get(f"/api/providers/{seed['provider']['id']}")).json()["models"][0]
        assert model["text_status"] == "succeeded"
        assert model["text_verification"]["id"] == run["id"]
