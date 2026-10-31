"""Adapt existing offline text generators to the complete tool-turn contract."""

from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from app.llm import adapters


def install_text_turn(
    monkeypatch: pytest.MonkeyPatch,
    generate: Callable[
        [adapters.CallSnapshot, str | None, Callable[[str], Awaitable[None]]],
        Awaitable[adapters.GenerateResult],
    ],
) -> None:
    async def complete(
        snapshot: adapters.CallSnapshot,
        key: str | None,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_tool_name: Callable[[str], Awaitable[None]] | None = None,
    ) -> adapters.ToolTurn:
        assert tools and tool_choice in {"auto", "none"}

        async def noop(_value: str) -> None:
            return None

        result = await generate(snapshot, key, on_progress or noop)
        item: dict[str, Any]
        if snapshot.protocol == "chat_completions":
            item = {"role": "assistant", "content": result.text}
        else:
            item = {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": result.text}],
            }
        return adapters.ToolTurn(
            text=result.text,
            completed=result.completed,
            calls=[],
            history_items=[item] if result.completed else [],
            usage=result.usage,
            raw_response=result.raw_response,
        )

    monkeypatch.setattr(adapters, "complete_with_tools", complete)
