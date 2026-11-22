import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from fastapi import FastAPI
from httpx import AsyncClient
from support_api import seed_chat
from support_segment_provenance import compiled_provenance, provenance, setup_material

from app.epub_schemas import CompiledBook
from app.provenance_schemas import MaterialProvenance
from app.services.material_provenance import identity_sha256, validate_reference
from app.translation_models import TranslationResult, TranslationTask


async def setup(client: AsyncClient) -> tuple[str, dict[str, Any], dict[str, Any]]:
    seed = await seed_chat(client)
    settings = await client.put(
        "/api/settings/translation", json={"expected_revision": 0, "model_id": seed["model"]["id"]}
    )
    assert settings.status_code == 200, settings.text
    source_id, material = await setup_material(client)
    return source_id, material, seed


def request(source_id: str, material: dict[str, Any]) -> dict[str, Any]:
    return dict(
        request_id=str(uuid4()),
        source_id=source_id,
        material_provenance=provenance(material),
        text="が𠮷",
        context_before="前",
        context_after="後",
    )


def segment_request(material: dict[str, Any], result_id: str, **fields: Any) -> dict[str, Any]:
    return (
        dict(
            request_id=str(uuid4()),
            material_provenance=provenance(material),
            translation_result_id=result_id,
        )
        | fields
    )


async def seed_result(
    app: FastAPI,
    source: str,
    reference: dict[str, Any],
    ordinal: int,
    *,
    book: CompiledBook | None = None,
    status: str = "succeeded",
    timestamp: datetime | None = None,
) -> str:
    normalized, text, chapter, parts = validate_reference(
        book or compiled_provenance(b""), MaterialProvenance.model_validate(reference)
    )
    result_id = f"{ordinal:026d}"
    task_id = f"T{ordinal:025d}"
    created = timestamp or datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=ordinal)
    async with app.state.session_factory() as session:
        session.add(
            TranslationTask(
                id=task_id,
                request_id=str(uuid4()),
                request_payload="{}",
                source_id=source,
                material_id=reference["material_id"],
                identity_sha256=identity_sha256(normalized),
                payload=json.dumps(
                    {
                        "material_provenance": normalized.model_dump(),
                        "chapter_id": chapter,
                        "parts": [part.model_dump() for part in parts],
                        "text": text,
                        "target_language": "简体中文",
                    }
                ),
                status=status,
                result_id=result_id,
                created_at=created,
            )
        )
        await session.flush()
        session.add(
            TranslationResult(
                id=result_id,
                task_id=task_id,
                translation=f"译文{ordinal}",
                created_at=created,
            )
        )
        await session.commit()
    return result_id
