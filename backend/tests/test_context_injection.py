"""Context events replace complete modules while keeping caller state opaque."""

import copy
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import pytest

from app.prompting import ContextEvent, assemble_context


@dataclass
class Plugin:
    id: str
    events: Sequence[ContextEvent]

    def emit(self, facts: Mapping[str, Any]) -> Sequence[ContextEvent]:
        return self.events


def contents(messages: list[dict[str, Any]]) -> str:
    return "\n".join(str(message["content"]) for message in messages)


def test_custom_plugin_emits_multiple_events_and_unchanged_state_is_silent() -> None:
    plugin = Plugin(
        "custom",
        [
            ContextEvent("rules", "v1", "CUSTOM_RULES", "system"),
            ContextEvent("profile", "v1", "FULL_PROFILE"),
            ContextEvent("material", "v1", "FULL_MATERIAL"),
        ],
    )
    first = assemble_context([plugin], {})
    assert [message["role"] for message in first.messages] == ["system", "user"]
    assert "CUSTOM_RULES" in first.messages[0]["content"]
    assert "FULL_PROFILE" in first.messages[1]["content"]
    assert "FULL_MATERIAL" in first.messages[1]["content"]
    frozen = copy.deepcopy(first.state)
    # State is persisted through the existing JSON snapshot field.
    second = assemble_context([plugin], {}, json.loads(json.dumps(first.state)))
    assert second.messages == []
    assert first.state == frozen


@pytest.mark.parametrize("change", ["body", "version", "clear"])
def test_one_event_change_replaces_only_that_complete_event(change: str) -> None:
    before = Plugin(
        "custom",
        [ContextEvent("one", "v1", "OLD_FULL"), ContextEvent("two", "v1", "UNCHANGED_OTHER")],
    )
    first = assemble_context([before], {})
    content = "NEW_FULL" if change == "body" else "OLD_FULL"
    if change == "clear":
        content = ""
    version = "v2" if change == "version" else "v1"
    after = Plugin("custom", [ContextEvent("one", version, content), before.events[1]])
    changed = assemble_context([after], {}, first.state)
    assert len(changed.messages) == 1
    text = contents(changed.messages)
    assert "UNCHANGED_OTHER" not in text
    if content:
        assert content in text
    else:
        assert "OLD_FULL" not in text
        assert "该模块内容已清空" in text
    assert assemble_context([after], {}, changed.state).messages == []


@pytest.mark.parametrize("change", ["order", "remove", "add", "stream"])
def test_structure_changes_rebuild_affected_stream_and_revoke_old_members(change: str) -> None:
    one = ContextEvent("one", "v1", "FIRST_MODULE")
    two = ContextEvent("two", "v1", "SECOND_MODULE")
    before = Plugin("custom", [one, two])
    first = assemble_context([before], {})
    if change == "order":
        events = [two, one]
    elif change == "remove":
        events = [one]
    elif change == "add":
        events = [one, two, ContextEvent("three", "v1", "THIRD_MODULE")]
    else:
        events = [ContextEvent("one", "v1", "FIRST_MODULE", "system"), two]
    after = Plugin("custom", events)
    changed = assemble_context([after], {}, first.state)
    text = contents(changed.messages)
    assert "FIRST_MODULE" in text
    assert ("SECOND_MODULE" in text) is (change != "remove")
    if change == "order":
        assert text.index("SECOND_MODULE") < text.index("FIRST_MODULE")
    if change == "stream":
        assert [message["role"] for message in changed.messages] == ["system", "user"]
    assert assemble_context([after], {}, changed.state).messages == []


@pytest.mark.parametrize("state", [None, {}, [], "unknown", {"version": "future"}])
def test_unknown_or_corrupt_state_rebuilds_full_context(state: object) -> None:
    plugin = Plugin("custom", [ContextEvent("one", "v1", "FULL_CURRENT")])
    result = assemble_context([plugin], {}, state)
    assert "FULL_CURRENT" in contents(result.messages)


def test_duplicate_event_identity_is_rejected() -> None:
    plugin = Plugin(
        "custom", [ContextEvent("same", "v1", "one"), ContextEvent("same", "v2", "two")]
    )
    with pytest.raises(ValueError):
        assemble_context([plugin], {})


def test_duplicate_plugin_id_is_rejected() -> None:
    with pytest.raises(ValueError):
        assemble_context([Plugin("same", []), Plugin("same", [])], {})


def test_removing_last_module_still_emits_revocation() -> None:
    first = assemble_context([Plugin("custom", [ContextEvent("one", "v1", "REMOVED")])], {})
    removed = assemble_context([], {}, first.state)
    assert removed.messages
    assert "REMOVED" not in contents(removed.messages)
    assert assemble_context([], {}, removed.state).messages == []


def test_system_rule_change_keeps_unchanged_context_silent() -> None:
    rules = Plugin("rules", [ContextEvent("policy", "v1", "OLD_POLICY", "system")])
    material = Plugin("material", [ContextEvent("text", "v1", "SAME_MATERIAL")])
    first = assemble_context([rules, material], {})
    new_rules = Plugin("rules", [ContextEvent("policy", "v2", "NEW_POLICY", "system")])
    changed = assemble_context([new_rules, material], {}, first.state)
    assert [message["role"] for message in changed.messages] == ["system"]
    assert "NEW_POLICY" in contents(changed.messages)
    assert "SAME_MATERIAL" not in contents(changed.messages)


def test_corrupt_saved_entry_cannot_suppress_current_material() -> None:
    plugin = Plugin("custom", [ContextEvent("one", "v1", "FULL_CURRENT")])
    first = assemble_context([plugin], {})
    corrupt = copy.deepcopy(first.state)
    corrupt["streams"]["context"][0].pop("digest")
    rebuilt = assemble_context([plugin], {}, corrupt)
    assert "FULL_CURRENT" in contents(rebuilt.messages)


def test_unknown_baseline_with_no_modules_explicitly_revokes_both_streams() -> None:
    empty = assemble_context([], {}, {"unrecognized": "older context"})
    assert [message["role"] for message in empty.messages] == ["system", "user"]
    assert all("撤销" in message["content"] for message in empty.messages)
    assert assemble_context([], {}, empty.state).messages == []
