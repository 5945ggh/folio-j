"""Read-only, portable explanation requests using the ordinary learning context."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas import SegmentExplanationPromptResponse
from app.services import material_provenance, settings
from app.services.context_plugins import ENV
from app.services.sources import require_segment, require_source


async def for_segment(session: AsyncSession, segment_id: str) -> SegmentExplanationPromptResponse:
    provenance = await material_provenance.resolve(session, segment_id)
    segment = await require_segment(session, segment_id)
    source = await require_source(session, segment.source_id)
    profile, style = await settings.explanation_preferences(session)
    # Explicit allowlist: neither management notes nor chat/provider state belongs
    # in text the user copies to an external service.
    prompt = (
        ENV.get_template("external_explanation_v1.j2")
        .render(
            source={"title": source.title, "description": source.description},
            segment={
                "text": segment.text,
                "context_before": segment.context_before,
                "context_after": segment.context_after,
                "translation": segment.translation,
                "transcription": segment.transcription,
                "source_ref": segment.source_ref,
                "material_provenance": provenance if provenance.status != "none" else None,
            },
            profile=profile,
            style=style,
        )
        .strip()
    )
    return SegmentExplanationPromptResponse(prompt=prompt)
