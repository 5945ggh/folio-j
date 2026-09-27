"""OpenAI-compatible provider adapters for verification and chat."""

import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, cast

from openai import AsyncOpenAI, omit
from openai.types.chat import ChatCompletion, ChatCompletionChunk
from openai.types.responses import Response


@dataclass(frozen=True)
class CallSnapshot:
    base_url: str
    model_id: str
    protocol: Literal["chat_completions", "responses"]
    stream: bool
    prompt: str
    temperature: float | None
    max_output_tokens: int | None
    reasoning_effort: Literal["none", "low", "medium", "high"] | None
    messages: list[dict[str, Any]] | None = None
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | None = None
    timeout_seconds: float | None = None


@dataclass(frozen=True)
class GenerateResult:
    text: str
    completed: bool
    usage: dict[str, int | None] | None
    raw_response: str | None


@dataclass(frozen=True)
class ToolTurn:
    """One complete assistant turn, including protocol objects for exact replay."""

    text: str
    completed: bool
    calls: list[dict[str, str]]
    history_items: list[dict[str, Any]]
    usage: dict[str, int | None] | None
    raw_response: str | None


async def complete_with_tools(
    snapshot: CallSnapshot,
    api_key: str | None,
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    tool_choice: str = "auto",
    on_progress: Callable[[str], Awaitable[None]] | None = None,
) -> ToolTurn:
    """Request a complete tool-capable turn; incomplete output is never dispatched."""
    timeout = _timeout(snapshot)
    async with _client(snapshot.base_url, api_key) as client:
        if snapshot.protocol == "chat_completions":
            if snapshot.stream:
                stream = await client.chat.completions.create(
                    model=snapshot.model_id,
                    messages=cast(Any, messages),
                    tools=cast(Any, tools),
                    tool_choice=cast(Any, tool_choice),
                    stream=True,
                    stream_options={"include_usage": True},
                    temperature=snapshot.temperature if snapshot.temperature is not None else omit,
                    max_tokens=snapshot.max_output_tokens
                    if snapshot.max_output_tokens is not None
                    else omit,
                    reasoning_effort=snapshot.reasoning_effort
                    if snapshot.reasoning_effort is not None
                    else omit,
                    timeout=timeout,
                    extra_headers=_headers(api_key),
                )
                text_parts: list[str] = []
                reasoning_parts: list[str] = []
                reasoning_seen = False
                fragments: dict[int, dict[str, Any]] = {}
                finish_reason: str | None = None
                usage: dict[str, int | None] | None = None
                try:
                    async for chunk in stream:
                        if chunk.usage is not None:
                            usage = _chat_usage(chunk)
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        delta = choice.delta
                        if delta.content:
                            text_parts.append(delta.content)
                            if on_progress is not None:
                                await on_progress(_safe_progress("".join(text_parts), api_key))
                        reasoning = getattr(delta, "reasoning_content", None)
                        if reasoning is not None:
                            reasoning_seen = True
                            reasoning_parts.append(reasoning)
                        for fragment in delta.tool_calls or []:
                            entry = fragments.setdefault(
                                fragment.index,
                                {
                                    "id": "",
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""},
                                },
                            )
                            if fragment.id:
                                entry["id"] += fragment.id
                            if fragment.function is not None:
                                if fragment.function.name:
                                    entry["function"]["name"] += fragment.function.name
                                if fragment.function.arguments:
                                    entry["function"]["arguments"] += fragment.function.arguments
                        if choice.finish_reason is not None:
                            finish_reason = choice.finish_reason
                finally:
                    await stream.close()
                raw_text = "".join(text_parts)
                item: dict[str, Any] = {"role": "assistant", "content": raw_text or None}
                if reasoning_seen:
                    item["reasoning_content"] = "".join(reasoning_parts)
                calls: list[dict[str, str]] = []
                if finish_reason == "tool_calls":
                    tool_calls = [fragments[index] for index in sorted(fragments)]
                    item["tool_calls"] = tool_calls
                    calls = [
                        {
                            "id": value["id"],
                            "name": value["function"]["name"],
                            "arguments": value["function"]["arguments"],
                        }
                        for value in tool_calls
                    ]
                completed = finish_reason in {"stop", "tool_calls"}
                item = cast(dict[str, Any], _redact_payload(item, api_key))
                calls = cast(list[dict[str, str]], _redact_payload(calls, api_key))
                return ToolTurn(
                    _safe(raw_text, api_key),
                    completed,
                    calls if completed else [],
                    [item] if completed else [],
                    usage,
                    _safe_json(
                        {
                            "protocol": "chat_completions",
                            "stream": True,
                            "finish_reason": finish_reason,
                            "usage": usage,
                            "partial_tool_calls": fragments if not completed else None,
                        },
                        api_key,
                    ),
                )
            response = await client.chat.completions.create(
                model=snapshot.model_id,
                messages=cast(Any, messages),
                tools=cast(Any, tools),
                tool_choice=cast(Any, tool_choice),
                temperature=snapshot.temperature if snapshot.temperature is not None else omit,
                max_tokens=snapshot.max_output_tokens
                if snapshot.max_output_tokens is not None
                else omit,
                reasoning_effort=snapshot.reasoning_effort
                if snapshot.reasoning_effort is not None
                else omit,
                timeout=timeout,
                extra_headers=_headers(api_key),
            )
            choice = response.choices[0] if response.choices else None
            if choice is None:
                return ToolTurn(
                    "",
                    False,
                    [],
                    [],
                    _chat_usage(response),
                    _safe_json(response.model_dump(mode="json"), api_key),
                )
            message = choice.message.model_dump(exclude_none=True)
            item: dict[str, Any] = {"role": "assistant", **message}
            calls: list[dict[str, str]] = []
            if choice.finish_reason == "tool_calls":
                item["tool_calls"] = message.get("tool_calls", [])
                for call in item["tool_calls"]:
                    calls.append(
                        {
                            "id": call["id"],
                            "name": call["function"]["name"],
                            "arguments": call["function"]["arguments"],
                        }
                    )
            completed = choice.finish_reason in {"stop", "tool_calls"}
            item = cast(dict[str, Any], _redact_payload(item, api_key))
            calls = cast(list[dict[str, str]], _redact_payload(calls, api_key))
            return ToolTurn(
                _safe(message.get("content") or "", api_key),
                completed,
                calls if completed else [],
                [item] if completed else [],
                _chat_usage(response),
                _safe_json(response.model_dump(mode="json"), api_key),
            )
        output_items: dict[int, dict[str, Any]] = {}
        if snapshot.stream:
            stream = await client.responses.create(
                model=snapshot.model_id,
                input=cast(Any, messages),
                tools=cast(Any, _responses_tools(tools)),
                tool_choice=cast(Any, tool_choice),
                stream=True,
                temperature=snapshot.temperature if snapshot.temperature is not None else omit,
                max_output_tokens=snapshot.max_output_tokens
                if snapshot.max_output_tokens is not None
                else omit,
                reasoning={"effort": snapshot.reasoning_effort}
                if snapshot.reasoning_effort is not None
                else omit,
                timeout=timeout,
                extra_headers=_headers(api_key),
            )
            final_response: Response | None = None
            terminal_response: Response | None = None
            parts: list[str] = []
            failed = False
            try:
                async for event in stream:
                    if event.type == "response.output_text.delta":
                        parts.append(event.delta)
                        if on_progress is not None:
                            await on_progress(_safe_progress("".join(parts), api_key))
                    elif event.type == "response.output_item.done":
                        output_items[event.output_index] = event.item.model_dump(exclude_none=True)
                    elif event.type == "response.function_call_arguments.done":
                        output_item = output_items.get(event.output_index)
                        if output_item is not None and output_item.get("type") == "function_call":
                            output_item["arguments"] = event.arguments
                    elif event.type == "response.completed":
                        final_response = event.response
                    elif event.type == "response.incomplete":
                        failed = True
                        terminal_response = event.response
                    elif event.type == "response.failed":
                        failed = True
                        terminal_response = event.response
                    elif event.type == "error":
                        failed = True
            finally:
                await stream.close()
            if final_response is None:
                partial = terminal_response
                return ToolTurn(
                    _safe(partial.output_text if partial is not None else "".join(parts), api_key),
                    False,
                    [],
                    [],
                    _response_usage(partial) if partial is not None else None,
                    _safe_json(partial.model_dump(mode="json"), api_key)
                    if partial is not None
                    else _safe_json(
                        {"protocol": "responses", "stream": True, "text": "".join(parts)}, api_key
                    ),
                )
            response = final_response
            if failed:
                return ToolTurn(
                    _safe(response.output_text, api_key),
                    False,
                    [],
                    [],
                    _response_usage(response),
                    _safe_json(response.model_dump(mode="json"), api_key),
                )
        else:
            response = await client.responses.create(
                model=snapshot.model_id,
                input=cast(Any, messages),
                tools=cast(Any, _responses_tools(tools)),
                tool_choice=cast(Any, tool_choice),
                temperature=snapshot.temperature if snapshot.temperature is not None else omit,
                max_output_tokens=snapshot.max_output_tokens
                if snapshot.max_output_tokens is not None
                else omit,
                reasoning={"effort": snapshot.reasoning_effort}
                if snapshot.reasoning_effort is not None
                else omit,
                timeout=timeout,
                extra_headers=_headers(api_key),
            )
        actual_items = (
            [item.model_dump(exclude_none=True) for item in response.output]
            if response.output
            else [output_items[index] for index in sorted(output_items)]
            if snapshot.stream
            else []
        )
        items = cast(list[dict[str, Any]], _redact_payload(actual_items, api_key))
        calls = [
            {"id": item["call_id"], "name": item["name"], "arguments": item["arguments"]}
            for item in items
            if item.get("type") == "function_call"
        ]
        return ToolTurn(
            _safe(response.output_text, api_key),
            response.status == "completed",
            calls if response.status == "completed" else [],
            items if response.status == "completed" else [],
            _response_usage(response),
            _safe_json(response.model_dump(mode="json"), api_key),
        )


async def generate_text(
    snapshot: CallSnapshot,
    api_key: str | None,
    on_progress: Callable[[str], Awaitable[None]],
) -> GenerateResult:
    async with _client(snapshot.base_url, api_key) as client:
        if snapshot.protocol == "chat_completions":
            return await _chat(client, snapshot, api_key, on_progress)
        return await _responses(client, snapshot, api_key, on_progress)


async def discover_models(base_url: str, api_key: str | None) -> list[str]:
    async with _client(base_url, api_key) as client:
        page = await client.models.list(extra_headers=_headers(api_key))
        return sorted({model.id for model in page.data})


def _headers(api_key: str | None) -> Mapping[str, str] | None:
    return cast(Mapping[str, str], {"Authorization": omit}) if not api_key else None


def _client(base_url: str, api_key: str | None) -> AsyncOpenAI:
    # SDK 3 rejects an empty key during construction. The internal value is never
    # sent because an omitted Authorization header overrides its bearer default.
    return AsyncOpenAI(
        api_key=api_key or "unauthenticated-local-provider",
        base_url=base_url,
        max_retries=0,
        timeout=60.0,
    )


def _safe(value: str, api_key: str | None) -> str:
    return value.replace(api_key, "[redacted]") if api_key else value


def _redact_payload(value: Any, api_key: str | None) -> Any:
    """Redact before JSON encoding so quotes and escapes cannot split a credential."""
    if isinstance(value, str):
        return _safe(value, api_key)
    if isinstance(value, list):
        return [_redact_payload(item, api_key) for item in cast(list[Any], value)]
    if isinstance(value, dict):
        return {
            _safe(key, api_key): _redact_payload(item, api_key)
            for key, item in cast(dict[str, Any], value).items()
        }
    return value


def _safe_json(value: Any, api_key: str | None) -> str:
    return json.dumps(_redact_payload(value, api_key), ensure_ascii=False)


def _timeout(snapshot: CallSnapshot) -> float:
    value = snapshot.timeout_seconds if snapshot.timeout_seconds is not None else 60.0
    if value <= 0:
        raise ValueError("模型请求超时须为正数")
    return value


def _safe_progress(value: str, api_key: str | None) -> str:
    safe = _safe(value, api_key)
    if api_key:
        # A streamed echo can split the credential across chunks. Hide a trailing
        # prefix until the following chunk proves it is ordinary text.
        for length in range(min(len(api_key) - 1, len(safe)), 0, -1):
            if safe.endswith(api_key[:length]):
                return safe[:-length] + "[redacted]"
    return safe


def _responses_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"type": "function", **item["function"]} for item in tools]


def _chat_usage(response: ChatCompletion | ChatCompletionChunk) -> dict[str, int | None] | None:
    usage = response.usage
    if usage is None:
        return None
    cached = getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", None)
    result: dict[str, int | None] = {
        "input_tokens": usage.prompt_tokens,
        "output_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
    }
    for key, value in (
        ("cached_tokens", cached),
        ("cache_hit_tokens", getattr(usage, "prompt_cache_hit_tokens", None)),
        ("cache_miss_tokens", getattr(usage, "prompt_cache_miss_tokens", None)),
    ):
        if value is not None:
            result[key] = value
    return result


def _response_usage(response: Response) -> dict[str, int | None] | None:
    usage = response.usage
    if usage is None:
        return None
    result: dict[str, int | None] = {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
    }
    for key, value in (
        (
            "cached_tokens",
            getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", None),
        ),
        ("cache_hit_tokens", getattr(usage, "prompt_cache_hit_tokens", None)),
        ("cache_miss_tokens", getattr(usage, "prompt_cache_miss_tokens", None)),
    ):
        if value is not None:
            result[key] = value
    return result


def _role_messages(snapshot: CallSnapshot) -> list[dict[str, Any]]:
    """Keep the 2A fixed prompt path and preserve each 2B role boundary."""
    if snapshot.messages is None:
        return [{"role": "user", "content": snapshot.prompt}]
    if snapshot.tools is not None:
        return snapshot.messages
    if not snapshot.messages or any(
        item.get("role") not in {"system", "user", "assistant"}
        or not isinstance(item.get("content"), str)
        for item in snapshot.messages
    ):
        raise ValueError("无效的角色消息")
    return [{"role": item["role"], "content": item["content"]} for item in snapshot.messages]


async def _chat(
    client: AsyncOpenAI,
    snapshot: CallSnapshot,
    api_key: str | None,
    on_progress: Callable[[str], Awaitable[None]],
) -> GenerateResult:
    timeout = _timeout(snapshot)
    if not snapshot.stream:
        response = await client.chat.completions.create(
            model=snapshot.model_id,
            messages=cast(Any, _role_messages(snapshot)),
            temperature=snapshot.temperature if snapshot.temperature is not None else omit,
            max_tokens=snapshot.max_output_tokens
            if snapshot.max_output_tokens is not None
            else omit,
            reasoning_effort=snapshot.reasoning_effort
            if snapshot.reasoning_effort is not None
            else omit,
            tools=cast(Any, snapshot.tools) if snapshot.tools is not None else omit,
            tool_choice=cast(Any, snapshot.tool_choice)
            if snapshot.tool_choice is not None
            else omit,
            timeout=timeout,
            extra_headers=_headers(api_key),
        )
        choice = response.choices[0] if response.choices else None
        text = _safe(choice.message.content or "", api_key) if choice else ""
        if text:
            await on_progress(text)
        return GenerateResult(
            text=text,
            completed=bool(text.strip()) and choice is not None and choice.finish_reason == "stop",
            usage=_chat_usage(response),
            raw_response=_safe(response.model_dump_json(), api_key),
        )

    stream = await client.chat.completions.create(
        model=snapshot.model_id,
        messages=cast(Any, _role_messages(snapshot)),
        stream=True,
        stream_options={"include_usage": True},
        temperature=snapshot.temperature if snapshot.temperature is not None else omit,
        max_tokens=snapshot.max_output_tokens if snapshot.max_output_tokens is not None else omit,
        reasoning_effort=snapshot.reasoning_effort
        if snapshot.reasoning_effort is not None
        else omit,
        tools=cast(Any, snapshot.tools) if snapshot.tools is not None else omit,
        tool_choice=cast(Any, snapshot.tool_choice) if snapshot.tool_choice is not None else omit,
        timeout=timeout,
        extra_headers=_headers(api_key),
    )
    parts: list[str] = []
    chunk_count = 0
    finish_reason: str | None = None
    usage: dict[str, int | None] | None = None
    try:
        async for chunk in stream:
            chunk_count += 1
            if chunk.usage is not None:
                usage = _chat_usage(chunk)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            if choice.delta.content:
                parts.append(choice.delta.content)
                await on_progress(_safe_progress("".join(parts), api_key))
            if choice.finish_reason is not None:
                finish_reason = choice.finish_reason
    finally:
        await stream.close()
    text = _safe("".join(parts), api_key)
    return GenerateResult(
        text=text,
        completed=bool(text.strip()) and finish_reason == "stop",
        usage=usage,
        # Preserve the terminal facts while dropping unsanitized delta fragments:
        # JSON serialization separates chunks, so a split credential survives a
        # replacement on the serialized stream even when the final text is safe.
        raw_response=json.dumps(
            {
                "protocol": "chat_completions",
                "stream": True,
                "text": text,
                "finish_reason": finish_reason,
                "usage": usage,
                "chunk_count": chunk_count,
            },
            ensure_ascii=False,
        ),
    )


async def _responses(
    client: AsyncOpenAI,
    snapshot: CallSnapshot,
    api_key: str | None,
    on_progress: Callable[[str], Awaitable[None]],
) -> GenerateResult:
    timeout = _timeout(snapshot)
    if not snapshot.stream:
        response = await client.responses.create(
            model=snapshot.model_id,
            input=cast(Any, _role_messages(snapshot))
            if snapshot.messages is not None
            else snapshot.prompt,
            temperature=snapshot.temperature if snapshot.temperature is not None else omit,
            max_output_tokens=snapshot.max_output_tokens
            if snapshot.max_output_tokens is not None
            else omit,
            reasoning={"effort": snapshot.reasoning_effort}
            if snapshot.reasoning_effort is not None
            else omit,
            tools=cast(Any, _responses_tools(snapshot.tools))
            if snapshot.tools is not None
            else omit,
            tool_choice=cast(Any, snapshot.tool_choice)
            if snapshot.tool_choice is not None
            else omit,
            timeout=timeout,
            extra_headers=_headers(api_key),
        )
        text = _safe(response.output_text, api_key)
        if text:
            await on_progress(text)
        return GenerateResult(
            text=text,
            completed=bool(text.strip()) and response.status == "completed",
            usage=_response_usage(response),
            raw_response=_safe(response.model_dump_json(), api_key),
        )

    stream = await client.responses.create(
        model=snapshot.model_id,
        input=cast(Any, _role_messages(snapshot))
        if snapshot.messages is not None
        else snapshot.prompt,
        stream=True,
        temperature=snapshot.temperature if snapshot.temperature is not None else omit,
        max_output_tokens=snapshot.max_output_tokens
        if snapshot.max_output_tokens is not None
        else omit,
        reasoning={"effort": snapshot.reasoning_effort}
        if snapshot.reasoning_effort is not None
        else omit,
        tools=cast(Any, _responses_tools(snapshot.tools)) if snapshot.tools is not None else omit,
        tool_choice=cast(Any, snapshot.tool_choice) if snapshot.tool_choice is not None else omit,
        timeout=timeout,
        extra_headers=_headers(api_key),
    )
    parts: list[str] = []
    event_count = 0
    final_response: Response | None = None
    failed = False
    try:
        async for event in stream:
            event_count += 1
            if event.type == "response.output_text.delta":
                parts.append(event.delta)
                await on_progress(_safe_progress("".join(parts), api_key))
            elif event.type == "response.completed":
                final_response = event.response
            elif event.type in {"response.incomplete", "response.failed", "error"}:
                failed = True
    finally:
        await stream.close()
    final_text = final_response.output_text if final_response is not None else ""
    text = _safe(final_text or "".join(parts), api_key)
    return GenerateResult(
        text=text,
        completed=bool(text.strip())
        and not failed
        and final_response is not None
        and final_response.status == "completed",
        usage=_response_usage(final_response) if final_response is not None else None,
        raw_response=json.dumps(
            {
                "protocol": "responses",
                "stream": True,
                "text": text,
                "status": final_response.status if final_response is not None else None,
                "failed_event": failed,
                "usage": _response_usage(final_response) if final_response is not None else None,
                "event_count": event_count,
            },
            ensure_ascii=False,
        ),
    )
