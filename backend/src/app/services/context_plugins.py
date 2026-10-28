"""Application context adapters; profile structure belongs here and in templates."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from app.prompting import ContextEvent, ContextPlugin, Stream

PROMPTS = Path(__file__).resolve().parents[3] / "prompts" / "chat"
ENV = Environment(loader=FileSystemLoader(PROMPTS), undefined=StrictUndefined, autoescape=False)


@dataclass(frozen=True)
class TemplateContextPlugin:
    id: str
    version: str
    template: str
    stream: Stream = "context"

    def emit(self, facts: Mapping[str, Any]) -> Sequence[ContextEvent]:
        return (
            ContextEvent(
                key="state",
                version=self.version,
                content=ENV.get_template(self.template).render(**facts).strip(),
                stream=self.stream,
            ),
        )


# Tuple order is the configuration seam; no registry or external plugin lifecycle.
CONTEXT_PLUGINS: tuple[ContextPlugin, ...] = (
    TemplateContextPlugin("assistant_rules", "v8", "system_v8.j2", "system"),
    TemplateContextPlugin("source", "v1", "context_source_v1.j2"),
    TemplateContextPlugin("segment", "v1", "context_segment_v1.j2"),
    TemplateContextPlugin("learning_profile", "v1", "context_profile_v1.j2"),
    TemplateContextPlugin("explanation_style", "v1", "context_style_v1.j2"),
)
