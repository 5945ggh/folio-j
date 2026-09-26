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
    messages: list[dict[str, str]] | None = None


@dataclass(frozen=True)
class GenerateResult:
    text: str
    completed: bool
    usage: dict[str, int | None] | None
    raw_response: str | None


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


def _safe_progress(value: str, api_key: str | None) -> str:
    safe = _safe(value, api_key)
    if api_key:
        # A streamed echo can split the credential across chunks. Hide a trailing
        # prefix until the following chunk proves it is ordinary text.
        for length in range(min(len(api_key) - 1, len(safe)), 0, -1):
            if safe.endswith(api_key[:length]):
                return safe[:-length] + "[redacted]"
    return safe


def _chat_usage(response: ChatCompletion | ChatCompletionChunk) -> dict[str, int | None] | None:
    usage = response.usage
    if usage is None:
        return None
    return {
        "input_tokens": usage.prompt_tokens,
        "output_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
    }


def _response_usage(response: Response) -> dict[str, int | None] | None:
    usage = response.usage
    if usage is None:
        return None
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
    }


def _role_messages(snapshot: CallSnapshot) -> list[dict[str, str]]:
    """Keep the 2A fixed prompt path and preserve each 2B role boundary."""
    if snapshot.messages is None:
        return [{"role": "user", "content": snapshot.prompt}]
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
