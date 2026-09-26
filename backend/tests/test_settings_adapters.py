"""Exercise actual SDK adapters through an in-memory HTTP transport."""

import json
from collections.abc import Callable, Mapping
from typing import Any, Literal, cast

import httpx2 as httpx
import pytest
from openai import AsyncOpenAI as SDKAsyncOpenAI

from app.llm import adapters

Protocol = Literal["chat_completions", "responses"]


def snapshot(protocol: Protocol, stream: bool) -> adapters.CallSnapshot:
    return adapters.CallSnapshot(
        base_url="http://model.invalid/v1",
        model_id="demo-model",
        protocol=protocol,
        stream=stream,
        prompt="固定短提示",
        temperature=None,
        max_output_tokens=None,
        reasoning_effort=None,
    )


def install_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    def client_factory(**options: Any) -> SDKAsyncOpenAI:
        return SDKAsyncOpenAI(
            **options, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )

    monkeypatch.setattr(adapters, "AsyncOpenAI", client_factory)


def completed_response(text: str, status: str = "completed") -> dict[str, object]:
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 1,
        "model": "demo-model",
        "status": status,
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
    }


def event(payload: Mapping[str, object]) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


@pytest.mark.asyncio
async def test_no_key_model_discovery_sends_no_authorization_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"object": "list", "data": [{"id": "demo-model"}]})

    install_transport(monkeypatch, handler)
    assert await adapters.discover_models("http://model.invalid/v1", None) == ["demo-model"]
    assert len(requests) == 1
    assert requests[0].url.path == "/v1/models"
    assert "authorization" not in requests[0].headers


@pytest.mark.asyncio
async def test_no_key_generation_sends_no_authorization_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
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
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "回答"},
                    }
                ],
            },
        )

    install_transport(monkeypatch, handler)

    async def on_progress(_text: str) -> None:
        pass

    result = await adapters.generate_text(snapshot("chat_completions", False), None, on_progress)
    assert result.completed is True
    assert result.text == "回答"
    assert len(requests) == 1
    assert "authorization" not in requests[0].headers


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_non_stream_text_and_usage(monkeypatch: pytest.MonkeyPatch, protocol: str) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if protocol == "chat_completions":
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
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "回答"},
                        }
                    ],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
                },
            )
        return httpx.Response(200, json=completed_response("回答"))

    install_transport(monkeypatch, handler)
    progress: list[str] = []

    async def on_progress(text: str) -> None:
        progress.append(text)

    result = await adapters.generate_text(
        snapshot(cast(Protocol, protocol), False), "fictional_test_key", on_progress
    )
    assert result.text == "回答"
    assert result.completed is True
    assert result.usage == {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
    assert progress == ["回答"]
    assert len(requests) == 1
    assert requests[0].headers["authorization"] == "Bearer fictional_test_key"
    assert requests[0].url.path.endswith(
        "/chat/completions" if protocol == "chat_completions" else "/responses"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_stream_accumulates_visible_text_and_requires_terminal_event(
    monkeypatch: pytest.MonkeyPatch, protocol: str
) -> None:
    if protocol == "chat_completions":
        chunks = [
            {
                "id": "chat_test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [{"index": 0, "delta": {"content": "前"}, "finish_reason": None}],
            },
            {
                "id": "chat_test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [{"index": 0, "delta": {"content": "半"}, "finish_reason": "stop"}],
            },
        ]
    else:
        chunks = [
            {
                "type": "response.output_text.delta",
                "sequence_number": 1,
                "item_id": "msg_test",
                "output_index": 0,
                "content_index": 0,
                "delta": "前",
            },
            {
                "type": "response.output_text.delta",
                "sequence_number": 2,
                "item_id": "msg_test",
                "output_index": 0,
                "content_index": 0,
                "delta": "半",
            },
            {
                "type": "response.completed",
                "sequence_number": 3,
                "response": completed_response("前半"),
            },
        ]

    def handler(_request: httpx.Request) -> httpx.Response:
        body = "".join(event(chunk) for chunk in chunks) + "data: [DONE]\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    install_transport(monkeypatch, handler)
    progress: list[str] = []

    async def on_progress(text: str) -> None:
        progress.append(text)

    result = await adapters.generate_text(
        snapshot(cast(Protocol, protocol), True), "fictional_test_key", on_progress
    )
    assert result.completed is True
    assert result.text == "前半"
    assert progress == ["前", "前半"]


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_stream_without_terminal_completion_is_not_success(
    monkeypatch: pytest.MonkeyPatch, protocol: str
) -> None:
    if protocol == "chat_completions":
        chunk: dict[str, object] = {
            "id": "chat_test",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "demo-model",
            "choices": [{"index": 0, "delta": {"content": "途中"}, "finish_reason": None}],
        }
    else:
        chunk = {
            "type": "response.output_text.delta",
            "sequence_number": 1,
            "item_id": "msg_test",
            "output_index": 0,
            "content_index": 0,
            "delta": "途中",
        }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text=event(chunk) + "data: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)

    async def on_progress(_text: str) -> None:
        pass

    result = await adapters.generate_text(
        snapshot(cast(Protocol, protocol), True), "fictional_test_key", on_progress
    )
    assert result.completed is False


@pytest.mark.asyncio
async def test_responses_terminal_object_must_have_completed_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        chunks = [
            {
                "type": "response.output_text.delta",
                "sequence_number": 1,
                "item_id": "msg_test",
                "output_index": 0,
                "content_index": 0,
                "delta": "途中",
            },
            {
                "type": "response.completed",
                "sequence_number": 2,
                "response": completed_response("途中", status="incomplete"),
            },
        ]
        return httpx.Response(
            200,
            text="".join(event(chunk) for chunk in chunks) + "data: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)

    async def on_progress(_text: str) -> None:
        pass

    result = await adapters.generate_text(snapshot("responses", True), "fictional", on_progress)
    assert result.completed is False


@pytest.mark.asyncio
async def test_streaming_key_echo_never_reaches_progress_or_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "fictional_secret"

    def handler(_request: httpx.Request) -> httpx.Response:
        chunks = [
            {
                "id": "chat_test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {"index": 0, "delta": {"content": "fictional_"}, "finish_reason": None}
                ],
            },
            {
                "id": "chat_test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [{"index": 0, "delta": {"content": "secret"}, "finish_reason": "stop"}],
            },
        ]
        return httpx.Response(
            200,
            text="".join(event(chunk) for chunk in chunks) + "data: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)
    progress: list[str] = []

    async def on_progress(text: str) -> None:
        progress.append(text)

    result = await adapters.generate_text(snapshot("chat_completions", True), secret, on_progress)
    assert all(secret not in item for item in progress)
    assert secret not in result.text
    assert result.raw_response is not None and secret not in result.raw_response
    assert "fictional_" not in result.raw_response
    assert '"secret"' not in result.raw_response
