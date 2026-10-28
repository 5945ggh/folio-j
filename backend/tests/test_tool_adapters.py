"""Offline wire contracts for complete tool-capable turns."""

import json
from dataclasses import replace
from typing import Any, cast

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
async def test_tool_choice_none_and_no_call(
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
    assert_no_credential(result.calls, secret)
    assert_no_credential(result.history_items, secret)
    assert_no_credential(result.raw_response, secret)
    assert_no_credential(result.text, secret)
    assert_no_credential(progress, secret)


def assert_no_credential(value: Any, secret: str) -> None:
    """Inspect decoded fields, including JSON strings embedded in protocol objects."""
    if isinstance(value, str):
        assert secret not in value
        assert json.dumps(secret, ensure_ascii=False)[1:-1] not in value
        assert json.dumps(secret, ensure_ascii=True)[1:-1] not in value
        try:
            decoded = json.loads(value)
        except ValueError:
            return
        assert_no_credential(decoded, secret)
    elif isinstance(value, dict):
        for key, item in cast(dict[Any, Any], value).items():
            assert_no_credential(key, secret)
            assert_no_credential(item, secret)
    elif isinstance(value, list):
        for item in cast(list[Any], value):
            assert_no_credential(item, secret)


def tool_response(
    protocol: Protocol, stream: bool, arguments: str, *, completed: bool = True
) -> httpx.Response:
    """Build synthetic tool responses for SDK tests and durable redaction checks."""
    if protocol == "chat_completions":
        payload = _chat_response(arguments=arguments)
        finish = "tool_calls" if completed else "length"
        payload["choices"][0]["finish_reason"] = finish
        if stream:
            message = payload["choices"][0]["message"]
            fragment = {"index": 0, **message["tool_calls"][0]}
            payload["object"] = "chat.completion.chunk"
            payload["choices"] = [
                {"index": 0, "delta": {"tool_calls": [fragment]}, "finish_reason": finish}
            ]
            return httpx.Response(
                200,
                text=event(payload) + "data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
    else:
        payload = _response_with_call(
            status="completed" if completed else "incomplete", arguments=arguments
        )
        if stream:
            return httpx.Response(
                200,
                text=event(
                    {
                        "type": "response.completed" if completed else "response.incomplete",
                        "sequence_number": 1,
                        "response": payload,
                    }
                ),
                headers={"content-type": "text/event-stream"},
            )
    return httpx.Response(200, json=payload)


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("unicode_escape", [False, True])
async def test_nested_json_arguments_redact_values_and_preserve_other_text(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol, stream: bool, unicode_escape: bool
) -> None:
    secret = 'fictional"secret\\suffix'
    note = '引用「説明」 "quoted" \\ path'
    nested = json.dumps({"credential": secret}, ensure_ascii=False)
    arguments = json.dumps(
        {"id": secret, "nested": json.dumps(nested), "note": note}, ensure_ascii=False
    )
    if unicode_escape:
        arguments = arguments.replace("fictional", "\\u0066ictional")

    def handler(_request: httpx.Request) -> httpx.Response:
        return tool_response(protocol, stream, arguments)

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        snapshot(protocol, stream), secret, messages=MESSAGES, tools=TOOLS
    )
    assert result.completed
    assert_no_credential(result.calls, secret)
    assert_no_credential(result.history_items, secret)
    assert_no_credential(result.raw_response, secret)
    decoded = json.loads(result.calls[0]["arguments"])
    assert decoded["id"] == "[redacted]"
    assert json.loads(json.loads(decoded["nested"]))["credential"] == "[redacted]"
    assert decoded["note"] == note


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("api_key", [None, 'fictional"secret\\suffix'])
@pytest.mark.parametrize("invalid_escape", [False, True])
async def test_tool_arguments_without_credentials_keep_exact_bytes_in_replay(
    monkeypatch: pytest.MonkeyPatch,
    protocol: Protocol,
    stream: bool,
    api_key: str | None,
    invalid_escape: bool,
) -> None:
    arguments = ' { "id" : "原文\\\\path", "note": "引用\\"内容\\"" } '
    assert json.loads(arguments)["id"] == "原文\\path"
    if invalid_escape:
        arguments = r'{ "id": "harmless\q", "note": "quoted\"text" }'
    if api_key is None:
        arguments = json.dumps({"id": 'fictional"secret\\suffix', "note": arguments})
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return tool_response(protocol, stream, arguments)

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        snapshot(protocol, stream), api_key, messages=MESSAGES, tools=TOOLS
    )
    assert result.completed
    assert result.calls[0]["arguments"] == arguments
    continuation = [*MESSAGES, *result.history_items]
    await adapters.complete_with_tools(
        snapshot(protocol, stream), api_key, messages=continuation, tools=TOOLS
    )
    body = json.loads(requests[-1].content)
    assert body["messages" if protocol == "chat_completions" else "input"] == continuation
    replayed = (
        body["messages"][-1]["tool_calls"][0]["function"]["arguments"]
        if protocol == "chat_completions"
        else next(
            item["arguments"] for item in body["input"] if item.get("type") == "function_call"
        )
    )
    assert replayed == arguments


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("completed", [False, True])
async def test_invalid_or_incomplete_arguments_do_not_expose_encoded_credentials(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol, stream: bool, completed: bool
) -> None:
    secret = 'fictional"secret\\suffix'
    arguments = json.dumps({"id": secret})[:-1]

    def handler(_request: httpx.Request) -> httpx.Response:
        return tool_response(protocol, stream, arguments, completed=completed)

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        snapshot(protocol, stream), secret, messages=MESSAGES, tools=TOOLS
    )
    assert result.completed is completed
    if not completed:
        assert result.calls == result.history_items == []
    else:
        redacted = result.calls[0]["arguments"]
        assert "[redacted]" in redacted
        with pytest.raises(json.JSONDecodeError):
            json.loads(redacted)
    assert_no_credential(result.calls, secret)
    assert_no_credential(result.history_items, secret)
    assert_no_credential(result.raw_response, secret)


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize(
    "case", ["json_key", "duplicate", "truncated", "unclosed_string", "invalid_escape"]
)
async def test_redaction_handles_json_shaped_keys_duplicates_and_partial_unicode(
    monkeypatch: pytest.MonkeyPatch, protocol: Protocol, stream: bool, case: str
) -> None:
    secret = '"123"' if case == "json_key" else 'fictional"secret\\suffix'
    encoded = json.dumps(secret).replace("fictional", "\\u0066ictional")
    replacement = '"[redacted]"'
    if case == "invalid_escape":
        arguments = '{ "id": ' + encoded[:-1] + '\\q" }'
        expected = '{ "id": [redacted-invalid-json] }'
    elif case == "duplicate":
        arguments = '{ "id": ' + encoded + ', "id": "public" }'
        expected = '{ "id": ' + replacement + ', "id": "public" }'
    else:
        arguments = '{ "id": ' + encoded + " }"
        expected = '{ "id": ' + replacement + " }"
        if case == "truncated":
            arguments, expected = arguments[:-2], expected[:-2]
        elif case == "unclosed_string":
            arguments, expected = arguments[:-3], expected[:-3]

    def handler(_request: httpx.Request) -> httpx.Response:
        return tool_response(protocol, stream, arguments)

    install_transport(monkeypatch, handler)
    result = await adapters.complete_with_tools(
        snapshot(protocol, stream), secret, messages=MESSAGES, tools=TOOLS
    )
    assert result.completed
    assert result.calls[0]["arguments"] == expected
    if case == "invalid_escape":
        with pytest.raises(json.JSONDecodeError):
            json.loads(result.calls[0]["arguments"])
    historical = (
        result.history_items[0]["tool_calls"][0]["function"]["arguments"]
        if protocol == "chat_completions"
        else result.history_items[1]["arguments"]
    )
    assert historical == expected
    if not (protocol == "chat_completions" and stream):
        raw = json.loads(result.raw_response or "null")
        raw_arguments = (
            raw["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
            if protocol == "chat_completions"
            else raw["output"][1]["arguments"]
        )
        assert raw_arguments == expected
