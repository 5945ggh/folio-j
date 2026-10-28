"""Ordered, versioned context events independent of application profile fields."""

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from jinja2 import Environment, FileSystemLoader, StrictUndefined

Stream = Literal["system", "context"]
STREAMS: tuple[Stream, ...] = ("system", "context")
FORMAT_VERSION = "v1"
ENV = Environment(
    loader=FileSystemLoader(Path(__file__).resolve().parents[2] / "prompts" / "context"),
    undefined=StrictUndefined,
    autoescape=False,
)


@dataclass(frozen=True)
class ContextEvent:
    """A complete current value owned by a stable plugin-local key."""

    key: str
    version: str
    content: str
    stream: Stream = "context"


class ContextPlugin(Protocol):
    @property
    def id(self) -> str: ...

    def emit(self, facts: Mapping[str, Any]) -> Sequence[ContextEvent]: ...


@dataclass(frozen=True)
class ContextAssembly:
    messages: list[dict[str, Any]]
    state: dict[str, Any]


def _read_state(value: object) -> dict[Stream, list[dict[str, str]]] | None:
    """An unknown or incomplete baseline must never suppress current context."""
    if not isinstance(value, dict):
        return None
    state = cast(dict[str, Any], value)
    if state.get("version") != 1 or state.get("format") != FORMAT_VERSION:
        return None
    raw = state.get("streams")
    if not isinstance(raw, dict):
        return None
    streams = cast(dict[str, Any], raw)
    result: dict[Stream, list[dict[str, str]]] = {}
    identities: set[tuple[str, str]] = set()
    for stream in STREAMS:
        items = streams.get(stream)
        if not isinstance(items, list):
            return None
        entries: list[dict[str, str]] = []
        for item in cast(list[Any], items):
            if not isinstance(item, dict):
                return None
            entry = cast(dict[str, Any], item)
            if any(
                not isinstance(entry.get(key), str) or not entry[key]
                for key in ("plugin", "key", "version", "digest")
            ):
                return None
            identity = (entry["plugin"], entry["key"])
            if identity in identities:
                return None
            identities.add(identity)
            entries.append({key: entry[key] for key in ("plugin", "key", "version", "digest")})
        result[stream] = entries
    return result


def assemble_context(
    plugins: Sequence[ContextPlugin],
    facts: Mapping[str, Any],
    previous_state: object = None,
) -> ContextAssembly:
    """Emit changed values, resetting a stream when its membership or order changes.

    Callers append these messages to their unchanged protocol history, then append
    the current question. Only a baseline belonging to that history is valid.
    """
    events: dict[Stream, list[dict[str, str]]] = {stream: [] for stream in STREAMS}
    manifests: dict[Stream, list[dict[str, str]]] = {stream: [] for stream in STREAMS}
    plugin_ids: set[str] = set()
    for plugin in plugins:
        if not plugin.id or plugin.id in plugin_ids:
            raise ValueError("上下文插件身份必须非空且唯一")
        plugin_ids.add(plugin.id)
        keys: set[str] = set()
        for event in plugin.emit(facts):
            if not event.key or event.key in keys or not event.version:
                raise ValueError("上下文事件身份必须非空且在插件内唯一，版本不得为空")
            if event.stream not in STREAMS:
                raise ValueError("未知上下文流")
            keys.add(event.key)
            entry = {"plugin": plugin.id, "key": event.key, "version": event.version}
            events[event.stream].append({**entry, "content": event.content})
            manifests[event.stream].append(
                {**entry, "digest": hashlib.sha256(event.content.encode()).hexdigest()}
            )
    previous = _read_state(previous_state)
    messages: list[dict[str, Any]] = []
    for stream in STREAMS:
        current = manifests[stream]
        prior = previous[stream] if previous is not None else []
        reset = previous is None or [(item["plugin"], item["key"]) for item in current] != [
            (item["plugin"], item["key"]) for item in prior
        ]
        changed = (
            events[stream]
            if reset
            else [
                event
                for event, entry, old in zip(events[stream], current, prior, strict=True)
                if entry != old
            ]
        )
        if not changed and not reset:
            continue
        content = (
            ENV.get_template("events_v1.j2")
            .render(stream=stream, reset=reset, events=changed)
            .strip()
        )
        messages.append({"role": "system" if stream == "system" else "user", "content": content})
    return ContextAssembly(
        messages=messages,
        state={"version": 1, "format": FORMAT_VERSION, "streams": manifests},
    )
