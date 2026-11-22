import json
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from app.llm import adapters

DOCUMENT_BODY_MARKER = "だった是过去式。"


DOCUMENT = f"## 大意\n\n昨日は雨だった。\n\n## 语法\n\n{DOCUMENT_BODY_MARKER}\n"


def call(name: str, args: dict[str, Any] | None = None, identity: str = "call_1") -> dict[str, str]:
    return {"id": identity, "name": name, "arguments": json.dumps(args or {}, ensure_ascii=False)}


def scripted_turn(
    monkeypatch: pytest.MonkeyPatch,
    script: list[tuple[str, list[dict[str, str]], bool]],
) -> list[dict[str, Any]]:
    captured: list[dict[str, Any]] = []

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
        assert key == "fictional-chat-secret"
        assert script, "unexpected model call"
        text, calls, completed = script.pop(0)
        captured.append(
            {
                "snapshot": snapshot,
                "messages": json.loads(json.dumps(messages)),
                "tools": json.loads(json.dumps(tools)),
                "tool_choice": tool_choice,
            }
        )
        if on_progress and text:
            await on_progress(text)
        history: list[dict[str, Any]]
        if snapshot.protocol == "chat_completions":
            item: dict[str, Any] = {
                "role": "assistant",
                "content": text or None,
                "reasoning_content": "real-reasoning",
            }
            if calls:
                item["tool_calls"] = [
                    {
                        "id": entry["id"],
                        "type": "function",
                        "function": {
                            "name": entry["name"],
                            "arguments": entry["arguments"],
                        },
                    }
                    for entry in calls
                ]
            history = [item]
        else:
            history = [
                {"type": "reasoning", "id": f"r_{len(captured)}", "summary": []},
                *(
                    [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": text}],
                        }
                    ]
                    if text
                    else []
                ),
                *[
                    {
                        "type": "function_call",
                        "call_id": entry["id"],
                        "name": entry["name"],
                        "arguments": entry["arguments"],
                    }
                    for entry in calls
                ],
            ]
        return adapters.ToolTurn(
            text=text,
            completed=completed,
            calls=calls,
            history_items=history if completed else [],
            usage=None,
            raw_response="{}",
        )

    monkeypatch.setattr(adapters, "complete_with_tools", complete)
    return captured
