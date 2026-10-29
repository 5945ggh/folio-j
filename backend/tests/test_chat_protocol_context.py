"""Frozen chat input keeps the complete provider protocol prefix."""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from jinja2 import Environment, FileSystemLoader

from app.models import Segment, Source
from app.services.context import make_input_snapshot
from app.settings_models import Profile


@pytest.fixture
def writer_instructions() -> dict[str, str]:
    writers = Environment(
        loader=FileSystemLoader(Path(__file__).resolve().parents[1] / "prompts" / "analysis"),
        autoescape=False,
    )
    return {name: writers.get_template(name).render().strip() for name in writers.list_templates()}


@pytest.mark.asyncio
@pytest.mark.parametrize("writer_template", ["writer_v1.j2", "writer_v2.j2"])
async def test_next_turn_keeps_complete_protocol_prefix_and_appends_new_material(
    writer_template: str,
    writer_instructions: dict[str, str],
) -> None:
    # Old writer instructions remain legitimate frozen history, but must never be
    # introduced again by ordinary chat context assembly. Read their actual text:
    # the filenames do not occur in rendered provider messages.
    writer_text = writer_instructions[writer_template]
    prefix = [
        {"role": "system", "content": "固定规则"},
        {"role": "user", "content": "旧问题及补充要求"},
        {"role": "user", "content": writer_text},
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
        created_at=prior.created_at + timedelta(seconds=1),
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
        "继续讨论\n\n请关注过去式",
        "chat_completions",
    )
    assert snapshot["messages"][: len(prefix)] == prefix
    assert "01ARZ3NDEKTSV4RRFFQ69G5FAX" in snapshot["messages"][-2]["content"]
    appended = "\n".join(item["content"] for item in snapshot["messages"][len(prefix) :])
    for instructions in writer_instructions.values():
        assert instructions.splitlines()[0] not in appended
    assert "继续讨论\n\n请关注过去式" in snapshot["messages"][-1]["content"]
    assert "additional_instructions" not in snapshot
    assert "未选择讲解预设" in snapshot["messages"][-3]["content"]
    assert "雨だった。" not in snapshot["messages"][-1]["content"]
