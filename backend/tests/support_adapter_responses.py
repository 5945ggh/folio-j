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


def chat_response(
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


def response_with_call(
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
        payload = chat_response(arguments=arguments)
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
        payload = response_with_call(
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
