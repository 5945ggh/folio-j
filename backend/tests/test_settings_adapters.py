"""Exercise actual SDK adapters through an in-memory HTTP transport."""

from typing import cast

import httpx2 as httpx
import pytest
from support_adapter_responses import (
    Protocol,
    completed_response,
    event,
    install_transport,
    snapshot,
)

from app.llm import adapters


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
    clock = iter([0.0, 0.1, 0.25, 0.3])
    monkeypatch.setattr(adapters, "monotonic", lambda: next(clock))
    if protocol == "chat_completions":
        chunks = [
            {
                "id": "chat_test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": part},
                        "finish_reason": "stop" if part == "章" else None,
                    }
                ],
            }
            for part in "前半文章"
        ]
    else:
        chunks = [
            {
                "type": "response.output_text.delta",
                "sequence_number": index,
                "item_id": "msg_test",
                "output_index": 0,
                "content_index": 0,
                "delta": part,
            }
            for index, part in enumerate("前半文章", 1)
        ] + [
            {
                "type": "response.completed",
                "sequence_number": 5,
                "response": completed_response("前半文章"),
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
    assert result.text == "前半文章"
    assert progress == ["前", "前半文", "前半文章"]


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
