"""Synthetic provider echoes must not persist credentials in tool protocol history."""

import json
import sqlite3
from pathlib import Path

import httpx2 as httpx
import pytest
from test_chat_api import accept, chat_client, seed_chat
from test_settings_adapters import Protocol, completed_response, event, install_transport
from test_tool_adapters import assert_no_credential, tool_response

from app.jobs import runtime
from app.llm import adapters


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
async def test_encoded_credentials_never_enter_durable_tool_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, protocol: Protocol, stream: bool
) -> None:
    secret = 'fictional"secret\\suffix'
    arguments = json.dumps({"analysis_id": secret})
    calls = 0

    async def discover(_url: str, _key: str | None) -> list[str]:
        return []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return tool_response(protocol, stream, arguments)
        if protocol == "chat_completions":
            payload = {
                "id": "chat_redaction_done",
                "object": "chat.completion",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "完成"},
                        "finish_reason": "stop",
                    }
                ],
            }
            if stream:
                payload["object"] = "chat.completion.chunk"
                payload["choices"] = [
                    {"index": 0, "delta": {"content": "完成"}, "finish_reason": "stop"}
                ]
                return httpx.Response(
                    200,
                    text=event(payload) + "data: [DONE]\n\n",
                    headers={"content-type": "text/event-stream"},
                )
        else:
            payload = completed_response("完成")
            if stream:
                return httpx.Response(
                    200,
                    text=event(
                        {"type": "response.completed", "sequence_number": 1, "response": payload}
                    ),
                    headers={"content-type": "text/event-stream"},
                )
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(adapters, "discover_models", discover)
    install_transport(monkeypatch, handler)
    database = tmp_path / "redaction.db"
    async with chat_client(database) as (client, app):
        seed = await seed_chat(client)
        provider = await client.patch(
            f"/api/providers/{seed['provider']['id']}",
            json={"api_key": secret, "protocol": protocol},
        )
        assert provider.status_code == 200, provider.text
        job = await accept(client, seed, stream=stream)
        await runtime.execute_job(app, job["id"])
        result = (await client.get(f"/api/jobs/{job['id']}")).json()
        assert result["status"] == "succeeded"
        assert calls == 2
        with sqlite3.connect(database) as connection:
            state = connection.execute(
                "SELECT execution_state FROM chat_jobs WHERE id=?", (job["id"],)
            ).fetchone()
            runs = connection.execute(
                "SELECT messages, raw_response FROM runs WHERE job_id=?", (job["id"],)
            ).fetchall()
        assert state is not None
        assert len(runs) == 2
        assert_no_credential(json.loads(state[0]), secret)
        for messages, raw_response in runs:
            assert_no_credential(json.loads(messages), secret)
            assert_no_credential(json.loads(raw_response), secret)
