"""Offline wire contracts for complete tool-capable turns."""

import json
from dataclasses import replace
from typing import Any

import httpx2 as httpx
import pytest
from test_settings_adapters import (
    Protocol,
    completed_response,
    event,
    install_transport,
    snapshot,
)

from app.llm import adapters

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_analysis",
            "description": "读取讲解",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    }
]
MESSAGES = [{"role": "system", "content": "固定前缀"}, {"role": "user", "content": "读取"}]


def _chat_response(
    *,
    finish: str = "tool_calls",
    text: str | None = None,
    arguments: str = '{"id":"A"}',
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": "assistant",
        "content": text,
        "reasoning_content": "先检查身份",
    }
    if finish == "tool_calls":
        message["tool_calls"] = [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "read_analysis", "arguments": arguments},
            }
        ]
    return {
        "id": "chat_tools",
        "object": "chat.completion",
        "created": 1,
        "model": "demo-model",
        "choices": [{"index": 0, "finish_reason": finish, "message": message}],
        "usage": {
            "prompt_tokens": 5,
            "completion_tokens": 3,
            "total_tokens": 8,
            "prompt_tokens_details": {"cached_tokens": 0},
            "prompt_cache_hit_tokens": 0,
            "prompt_cache_miss_tokens": 5,
        },
    }


def _response_with_call(
    *, status: str = "completed", arguments: str = '{"id":"A"}'
) -> dict[str, Any]:
    response = completed_response("准备读取", status)
    old_output = response["output"]
    assert isinstance(old_output, list)
    response["output"] = [
        {"id": "rs_1", "type": "reasoning", "summary": []},
        {
            "id": "fc_1",
            "type": "function_call",
            "status": "completed",
            "call_id": "call_1",
            "name": "read_analysis",
            "arguments": arguments,
        },
        *old_output,
    ]
    response["usage"] = {
        "input_tokens": 5,
        "output_tokens": 3,
        "total_tokens": 8,
        "input_tokens_details": {"cached_tokens": 0},
        "prompt_cache_hit_tokens": 0,
        "prompt_cache_miss_tokens": 5,
    }
    return response


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_nonstream_tool_call_preserves_wire_history_and_cache_fields(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = _chat_response() if protocol == "chat_completions" else _response_with_call()
        return httpx.Response(200, json=payload)

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        replace(snapshot(protocol, False), timeout_seconds=180),
        None,
        messages=MESSAGES,
        tools=TOOLS,
    )
    assert result.completed
    assert result.calls == [{"id": "call_1", "name": "read_analysis", "arguments": '{"id":"A"}'}]
    assert result.usage == {
        "input_tokens": 5,
        "output_tokens": 3,
        "total_tokens": 8,
        "cached_tokens": 0,
        "cache_hit_tokens": 0,
        "cache_miss_tokens": 5,
    }
    assert requests[0].extensions["timeout"]["read"] == 180
    body = json.loads(requests[0].content)
    assert body["messages" if protocol == "chat_completions" else "input"] == MESSAGES
    assert "previous_response_id" not in body
    if protocol == "chat_completions":
        assert body["tools"] == TOOLS
        assert result.history_items[0]["reasoning_content"] == "先检查身份"
        assert result.history_items[0]["tool_calls"][0]["id"] == "call_1"
    else:
        assert body["tools"] == [{"type": "function", **TOOLS[0]["function"]}]
        assert [item["type"] for item in result.history_items] == [
            "reasoning",
            "function_call",
            "message",
        ]


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_full_history_is_sent_after_tool_result(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = _chat_response() if protocol == "chat_completions" else _response_with_call()
        return httpx.Response(200, json=payload)

    install_transport(monkeypatch, handler)
    first = await adapters.complete_with_tools(
        snapshot(protocol, False), None, messages=MESSAGES, tools=TOOLS
    )
    assert first.completed
    tool_result = (
        {"role": "tool", "tool_call_id": "call_1", "content": "已读取"}
        if protocol == "chat_completions"
        else {"type": "function_call_output", "call_id": "call_1", "output": "已读取"}
    )
    continuation = [*MESSAGES, *first.history_items, tool_result]
    await adapters.complete_with_tools(
        snapshot(protocol, False), None, messages=continuation, tools=TOOLS
    )
    body = json.loads(requests[-1].content)
    assert body["messages" if protocol == "chat_completions" else "input"] == continuation
    if protocol == "chat_completions":
        assert body["messages"][-2]["reasoning_content"] == "先检查身份"


@pytest.mark.asyncio
async def test_chat_stream_merges_indexed_calls_and_replays_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            "id": "chat_stream",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "demo-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    chunks: list[dict[str, Any]] = [
        chunk({"reasoning_content": "先检"}),
        chunk({"reasoning_content": "查", "content": "准备"}),
        chunk(
            {
                "content": "读取",
                "tool_calls": [
                    {
                        "index": 1,
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "read_analysis", "arguments": '{"id":'},
                    },
                    {
                        "index": 0,
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_analysis", "arguments": '{"id":'},
                    },
                ],
            }
        ),
        chunk(
            {
                "tool_calls": [
                    {"index": 1, "function": {"arguments": '"B"}'}},
                    {"index": 0, "function": {"arguments": '"A"}'}},
                ]
            },
            "tool_calls",
        ),
        {
            "id": "chat_stream",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "demo-model",
            "choices": [],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        },
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="".join(event(item) for item in chunks) + "data: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)
    progress: list[str] = []

    async def on_progress(value: str) -> None:
        progress.append(value)

    result = await adapters.complete_with_tools(
        snapshot("chat_completions", True),
        None,
        messages=MESSAGES,
        tools=TOOLS,
        on_progress=on_progress,
    )
    assert result.completed
    assert result.text == "准备读取"
    assert progress == ["准备", "准备读取"]
    assert [call["id"] for call in result.calls] == ["call_1", "call_2"]
    assert [call["arguments"] for call in result.calls] == ['{"id":"A"}', '{"id":"B"}']
    assert result.history_items[0]["reasoning_content"] == "先检查"
    assert len(result.history_items[0]["tool_calls"]) == 2


@pytest.mark.asyncio
async def test_responses_stream_retains_reasoning_and_terminal_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _response_with_call()
    events = [
        {
            "type": "response.output_item.added",
            "sequence_number": 1,
            "output_index": 0,
            "item": response["output"][0],
        },
        {
            "type": "response.output_item.done",
            "sequence_number": 2,
            "output_index": 0,
            "item": response["output"][0],
        },
        {
            "type": "response.output_item.added",
            "sequence_number": 3,
            "output_index": 1,
            "item": response["output"][1],
        },
        {
            "type": "response.function_call_arguments.delta",
            "sequence_number": 4,
            "output_index": 1,
            "item_id": "fc_1",
            "delta": '{"id":',
        },
        {
            "type": "response.function_call_arguments.done",
            "sequence_number": 5,
            "output_index": 1,
            "item_id": "fc_1",
            "arguments": '{"id":"A"}',
        },
        {
            "type": "response.output_item.done",
            "sequence_number": 6,
            "output_index": 1,
            "item": response["output"][1],
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 7,
            "item_id": "msg_test",
            "output_index": 2,
            "content_index": 0,
            "delta": "准备",
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 8,
            "item_id": "msg_test",
            "output_index": 2,
            "content_index": 0,
            "delta": "读取",
        },
        {"type": "response.completed", "sequence_number": 9, "response": response},
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="".join(event(item) for item in events),
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)
    progress: list[str] = []

    async def on_progress(value: str) -> None:
        progress.append(value)

    result = await adapters.complete_with_tools(
        snapshot("responses", True),
        None,
        messages=MESSAGES,
        tools=TOOLS,
        on_progress=on_progress,
    )
    assert result.completed
    assert result.text == "准备读取"
    assert progress == ["准备", "准备读取"]
    assert result.calls[0]["arguments"] == '{"id":"A"}'
    assert [item["type"] for item in result.history_items] == [
        "reasoning",
        "function_call",
        "message",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
async def test_writer_tool_choice_none_and_no_call(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol, stream: bool
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if protocol == "chat_completions":
            if stream:
                chunk = {
                    "id": "chat_writer",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "demo-model",
                    "choices": [
                        {"index": 0, "delta": {"content": "## 标题\n正文"}, "finish_reason": "stop"}
                    ],
                }
                return httpx.Response(
                    200,
                    text=event(chunk) + "data: [DONE]\n\n",
                    headers={"content-type": "text/event-stream"},
                )
            return httpx.Response(200, json=_chat_response(finish="stop", text="## 标题\n正文"))
        response = completed_response("## 标题\n正文")
        if stream:
            return httpx.Response(
                200,
                text=event(
                    {"type": "response.completed", "sequence_number": 1, "response": response}
                ),
                headers={"content-type": "text/event-stream"},
            )
        return httpx.Response(200, json=response)

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        snapshot(protocol, stream),
        None,
        messages=MESSAGES,
        tools=[],
        tool_choice="none",
    )
    assert result.completed and result.calls == []
    assert result.text == "## 标题\n正文"
    body = json.loads(requests[0].content)
    assert body["tool_choice"] == "none"
    assert body["tools"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_incomplete_tool_arguments_are_never_dispatched(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        if protocol == "chat_completions":
            chunk = {
                "id": "chat_truncated",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {"name": "read_analysis", "arguments": '{"id":'},
                                }
                            ]
                        },
                        "finish_reason": "length",
                    }
                ],
            }
            return httpx.Response(
                200,
                text=event(chunk) + "data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
        response = _response_with_call(status="incomplete", arguments='{"id":')
        return httpx.Response(
            200,
            text=event({"type": "response.incomplete", "sequence_number": 1, "response": response}),
            headers={"content-type": "text/event-stream"},
        )

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        snapshot(protocol, True),
        None,
        messages=MESSAGES,
        tools=TOOLS,
    )
    assert not result.completed
    assert result.calls == []
    assert result.history_items == []
    if protocol == "responses":
        assert result.usage is not None and result.usage["total_tokens"] == 8
        assert result.raw_response is not None and '"status": "incomplete"' in result.raw_response


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
async def test_secret_is_redacted_in_nested_call_history_raw_and_progress(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol
) -> None:
    secret = 'fictional"secret\\suffix'
    arguments = json.dumps({"id": secret}, ensure_ascii=False)
    if protocol == "chat_completions":
        chunks = [
            {
                "id": "s",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {"index": 0, "delta": {"content": 'fictional"'}, "finish_reason": None}
                ],
            },
            {
                "id": "s",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "content": "secret\\suffix",
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "read_analysis",
                                        "arguments": arguments[:9],
                                    },
                                }
                            ],
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "s",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "demo-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [{"index": 0, "function": {"arguments": arguments[9:]}}]
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            },
        ]

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                text="".join(event(item) for item in chunks) + "data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
    else:
        response = _response_with_call(arguments=arguments)
        response["output"][2]["content"][0]["text"] = secret

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=response)

    install_transport(monkeypatch, handler)
    progress: list[str] = []

    async def on_progress(value: str) -> None:
        progress.append(value)

    result = await adapters.complete_with_tools(
        snapshot(protocol, protocol == "chat_completions"),
        secret,
        messages=MESSAGES,
        tools=TOOLS,
        on_progress=on_progress,
    )
    serialized = json.dumps(
        {
            "calls": result.calls,
            "history": result.history_items,
            "raw": result.raw_response,
            "text": result.text,
            "progress": progress,
        },
        ensure_ascii=False,
    )
    assert secret not in serialized
    assert secret not in result.calls[0]["arguments"]
    assert all(secret not in value for value in progress)
