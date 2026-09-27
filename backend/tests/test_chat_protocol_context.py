"""Portable history conversion when a user explicitly switches provider protocol."""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.models import Segment, Source
from app.services.context import convert_protocol_messages, make_input_snapshot
from app.settings_models import Profile


def test_chat_to_responses_closes_real_tool_call_and_counts_private_reasoning() -> None:
    history = [
        {"role": "system", "content": "稳定规则"},
        {"role": "user", "content": "讲解这句"},
        {
            "role": "assistant",
            "content": None,
            "reasoning_content": "provider-only",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "list_analyses", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": '{"items":[]}'},
        {"role": "assistant", "content": "已有清单为空"},
    ]
    result, omitted = convert_protocol_messages(history, "chat_completions", "responses")
    assert result[:2] == history[:2]
    assert result[2] == {
        "type": "function_call",
        "call_id": "call_1",
        "name": "list_analyses",
        "arguments": "{}",
    }
    assert result[3] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": '{"items":[]}',
    }
    assert result[4] == history[4]
    assert omitted == 1


def test_responses_to_chat_preserves_call_and_visible_answer() -> None:
    history = [
        {"role": "system", "content": "稳定规则"},
        {"role": "user", "content": "读取讲解"},
        {"type": "reasoning", "id": "r1"},
        {
            "type": "function_call",
            "call_id": "call_2",
            "name": "read_analysis",
            "arguments": '{"analysis_id":"A"}',
        },
        {"type": "function_call_output", "call_id": "call_2", "output": "讲解内容"},
        {"type": "message", "content": [{"type": "output_text", "text": "已读到讲解"}]},
    ]
    result, omitted = convert_protocol_messages(history, "responses", "chat_completions")
    assert result[2]["tool_calls"][0]["id"] == "call_2"
    assert result[3] == {"role": "tool", "tool_call_id": "call_2", "content": "讲解内容"}
    assert result[4] == {"role": "assistant", "content": "已读到讲解"}
    assert omitted == 1


def test_same_protocol_keeps_every_prefix_object_unmodified() -> None:
    history = [{"role": "assistant", "content": "答复", "reasoning_content": "保留"}]
    result, omitted = convert_protocol_messages(history, "chat_completions", "chat_completions")
    assert result is history
    assert omitted == 0


@pytest.mark.asyncio
async def test_next_turn_keeps_complete_protocol_prefix_and_appends_new_material() -> None:
    prefix = [
        {"role": "system", "content": "固定规则"},
        {"role": "user", "content": "旧问题及补充要求"},
        {"role": "assistant", "content": "答复", "reasoning_content": "保留推理"},
    ]
    prior = SimpleNamespace(
        id="previous",
        execution_state={"protocol_messages": prefix},
        model_snapshot={"protocol": "chat_completions"},
        created_at=datetime.now(UTC),
        input_snapshot={"messages": prefix},
    )
    failed = SimpleNamespace(
        created_at=datetime.now(UTC),
        execution_state={
            "artifacts": [
                {
                    "analysis_id": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                    "revision_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
                }
            ]
        },
    )
    rows = [
        (SimpleNamespace(id="m1", role="user", content="旧问题", job_id="previous"), prior),
        (SimpleNamespace(id="m2", role="assistant", content="答复", job_id="previous"), prior),
    ]

    class Result:
        def all(self) -> list[tuple[Any, Any]]:
            return rows

    class Jobs:
        def all(self) -> list[Any]:
            return [failed]

    class Session:
        async def execute(self, _query: Any) -> Result:
            return Result()

        async def scalars(self, _query: Any) -> Jobs:
            return Jobs()

    source = cast(
        Source,
        SimpleNamespace(
            id="source",
            title="标题",
            description="",
            updated_at=datetime.now(UTC),
        ),
    )
    segment = cast(
        Segment,
        SimpleNamespace(
            id="segment",
            source_id="source",
            revision=1,
            text="雨だった。",
            translation="",
            context_before="",
            context_after="",
            transcription="",
            source_ref="",
        ),
    )
    profile = cast(
        Profile,
        SimpleNamespace(
            native_language="中文",
            explain_language="中文",
            level_note="初级",
        ),
    )
    snapshot = await make_input_snapshot(
        cast(Any, Session()),
        "thread",
        source,
        segment,
        profile,
        None,
        "继续讨论",
        "请关注过去式",
        "chat_completions",
    )
    assert snapshot["messages"][: len(prefix)] == prefix
    assert "01ARZ3NDEKTSV4RRFFQ69G5FAX" in snapshot["messages"][-2]["content"]
    assert "writer_v1" not in str(snapshot["messages"])
    assert "本轮补充要求：请关注过去式" in snapshot["messages"][-1]["content"]
    assert "本轮未选择讲解预设" in snapshot["messages"][-1]["content"]
