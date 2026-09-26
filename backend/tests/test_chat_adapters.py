"""Actual SDK request shapes must preserve each historical message's role."""

import json
from dataclasses import replace

import httpx2 as httpx
import pytest
from test_settings_adapters import Protocol, completed_response, event, install_transport, snapshot

from app.llm import adapters


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
async def test_conversation_roles_reach_both_protocols(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol, stream: bool
) -> None:
    messages = [
        {"role": "system", "content": "用中文解释日语。"},
        {"role": "user", "content": "过去的问题"},
        {"role": "assistant", "content": "过去的回答"},
        {"role": "user", "content": "新的问题"},
    ]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if protocol == "responses":
            response = completed_response("新的回答")
            if stream:
                payload = event(
                    {"type": "response.completed", "response": response, "sequence_number": 1}
                )
                return httpx.Response(
                    200, text=payload, headers={"content-type": "text/event-stream"}
                )
            return httpx.Response(200, json=response)
        if stream:
            chunk = {
                "id": "chat_test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {"index": 0, "delta": {"content": "新的回答"}, "finish_reason": "stop"}
                ],
            }
            return httpx.Response(
                200,
                text=event(chunk) + "data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
        return httpx.Response(
            200,
            json={
                "id": "chat_test",
                "object": "chat.completion",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "新的回答"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    async def progress(_text: str) -> None:
        pass

    install_transport(monkeypatch, handler)
    result = await adapters.generate_text(
        replace(snapshot(protocol, stream), messages=messages), None, progress
    )
    assert result.completed
    assert result.text == "新的回答"
    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["messages" if protocol == "chat_completions" else "input"] == messages
    assert "previous_response_id" not in body
    assert "authorization" not in requests[0].headers
