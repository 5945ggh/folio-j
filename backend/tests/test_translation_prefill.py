"""Selection saves preserve translation provenance without changing selected text."""

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError
from support_api import chat_client
from support_api import offline_chat_discovery as offline_chat_discovery
from test_segment_provenance import compiled_provenance, provenance, span
from test_translations import request, setup

from app.ids import new_ulid
from app.llm.adapters import GenerateResult
from app.provenance_schemas import MaterialProvenance
from app.schemas import SegmentCreate
from app.services import material_provenance as provenance_service
from app.services import translations
from app.services.material_provenance import request_payload, translation_reference_matches


def reference(*pieces: tuple[int, str], spine: int = 0) -> MaterialProvenance:
    return MaterialProvenance.model_validate(
        {
            "contract_version": "1",
            "material_id": "material",
            "version_id": "version",
            "ranges": [
                {
                    "resource_id": "resource",
                    "spine_index": spine,
                    "start": start,
                    "end": start + len(text),
                    "exact": text,
                    "text_sha256": "a" * 64,
                }
                for start, text in pieces
            ],
        }
    )


def test_matching_trims_complete_target_and_merges_codepoint_ranges() -> None:
    full = reference((0, "\u0085\u00a0"), (2, "　𠮷"), (4, " 文。"), (7, "\u202f\n"))
    exact = reference((3, "𠮷 文。"))
    assert translation_reference_matches(full, exact)
    assert translation_reference_matches(exact, full)
    assert full.ranges[0].exact == "\u0085\u00a0"
    assert translation_reference_matches(reference((3, "𠮷"), (4, " 文。")), exact)
    assert not translation_reference_matches(reference((0, " \u0085")), reference((0, " \u0085")))


@pytest.mark.parametrize(
    "left,right",
    [
        (reference((3, "𠮷 文。")), reference((4, "𠮷 文。"))),
        (reference((3, "𠮷 文。")), reference((3, "𠮷 文。"), spine=1)),
        (reference((3, "𠮷 文。")), reference((3, "𠮷文。"))),
        (reference((3, "𠮷 文。")), reference((3, "𠮷 文"))),
        (reference((0, "\ufeff文")), reference((1, "文"))),
        (reference((0, "\x1c文")), reference((1, "文"))),
        (reference((0, "文"), (1, " "), (2, "字")), reference((0, "文字"))),
    ],
)
def test_matching_rejects_distinct_locations_or_internal_text(
    left: MaterialProvenance, right: MaterialProvenance
) -> None:
    assert not translation_reference_matches(left, right)


@pytest.mark.parametrize(
    "field,value",
    [
        ("material_id", "other"),
        ("version_id", "other"),
    ],
)
def test_matching_requires_same_material_identity(field: str, value: str) -> None:
    original = reference((0, "文"))
    assert not translation_reference_matches(original, original.model_copy(update={field: value}))
    changed = original.ranges[0].model_copy(update={"text_sha256": "b" * 64})
    assert not translation_reference_matches(
        original, original.model_copy(update={"ranges": [changed]})
    )


def test_old_creation_payload_does_not_gain_default_translation_id() -> None:
    data = {"request_id": str(uuid4()), "material_provenance": reference((0, "文")).model_dump()}
    assert json.loads(request_payload(SegmentCreate.model_validate(data))) == data


@pytest.mark.asyncio
@pytest.mark.parametrize("saved_translation", ["编辑译文", ""])
async def test_selection_creation_links_actual_saved_fields_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, saved_translation: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)

    async def fake(*_args: Any) -> GenerateResult:
        return GenerateResult("翻译", True, None, None)

    monkeypatch.setattr(translations, "generate_text", fake)
    database = tmp_path / "prefill.db"
    async with chat_client(database) as (client, app):
        source_id, material, _ = await setup(client)
        task = (
            await client.post(
                f"/api/materials/{material['id']}/translations", json=request(source_id, material)
            )
        ).json()
        await translations.execute(app, task["id"])
        done = (await client.get(f"/api/translation-tasks/{task['id']}")).json()
        result_id = done["result_id"]
        body = {
            "request_id": str(uuid4()),
            "material_provenance": provenance(material),
            "translation_result_id": result_id,
            "translation": saved_translation,
            "context_before": "保存前文",
            "context_after": "",
        }
        path = f"/api/sources/{source_id}/segments"
        saved = await client.post(path, json=body)
        assert saved.status_code == 201, saved.text
        segment = saved.json()
        assert segment["text"] == "が𠮷"
        assert segment["translation"] == saved_translation
        assert segment["context_before"] == "保存前文"
        assert (await client.post(path, json=body)).json()["id"] == segment["id"]
        changed = await client.post(path, json=body | {"translation_result_id": "different"})
        assert changed.status_code == 409
        linked = await client.get(f"/api/segments/{segment['id']}/translation-results")
        assert linked.status_code == 200, linked.text
        assert [item["id"] for item in linked.json()] == [result_id]
        with sqlite3.connect(database) as connection:
            rows = connection.execute(
                "SELECT request_id, request_payload, adopted_payload FROM translation_adoptions"
            ).fetchall()
            assert len(rows) == 1
            assert rows[0][0] == body["request_id"]
            assert json.loads(rows[0][1]) == body
            assert json.loads(rows[0][2]) == {
                "action": "create",
                "fields": {
                    "translation": saved_translation,
                    "context_before": "保存前文",
                    "context_after": "",
                },
                "text_sha256": hashlib.sha256("が𠮷".encode()).hexdigest(),
            }
            counts = connection.execute("SELECT count(*) FROM segments").fetchone()[0]
        wrong = await client.post(
            path,
            json=body
            | {
                "request_id": str(uuid4()),
                "material_provenance": provenance(material, span("r1", 2, 1, 2)),
            },
        )
        assert wrong.status_code == 422, wrong.text
        manual = await client.post(path, json={"text": "が𠮷", "translation_result_id": result_id})
        assert manual.status_code == 422
        missing = await client.post(
            path, json=body | {"request_id": str(uuid4()), "translation_result_id": "missing"}
        )
        assert missing.status_code == 404
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM segments").fetchone()[0] == counts
            adoption_id = connection.execute("SELECT id FROM translation_adoptions").fetchone()[0]
        # Force failure after the Segment/provenance flush: all three writes must roll back.
        with monkeypatch.context() as scoped:
            ids = iter([new_ulid(), adoption_id])
            scoped.setattr(provenance_service, "new_ulid", ids.__next__)
            with pytest.raises(IntegrityError):
                await client.post(path, json=body | {"request_id": str(uuid4())})
        with sqlite3.connect(database) as connection:
            assert connection.execute("SELECT count(*) FROM segments").fetchone()[0] == counts
            assert (
                connection.execute("SELECT count(*) FROM translation_adoptions").fetchone()[0] == 1
            )
            assert (
                connection.execute("SELECT count(*) FROM segment_material_provenance").fetchone()[0]
                == 1
            )
        deleted = await client.delete(f"/api/materials/{material['id']}")
        assert deleted.status_code == 204, deleted.text
        # Existing adoption keeps the result visible, but never allows new material saves.
        assert (await client.get(f"/api/translation-results/{result_id}")).status_code == 200
        rejected = await client.post(path, json=body | {"request_id": str(uuid4())})
        assert rejected.status_code == 404


@pytest.mark.asyncio
async def test_whitespace_match_preserves_original_selection_and_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from test_segment_provenance import TEXTS

    monkeypatch.setitem(TEXTS, "r1", " \u0085𠮷 文。\u3000")
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)

    async def fake(*_args: Any) -> GenerateResult:
        return GenerateResult("翻译", True, None, None)

    monkeypatch.setattr(translations, "generate_text", fake)
    async with chat_client(tmp_path / "whitespace.db") as (client, app):
        source_id, material, _ = await setup(client)
        task = (
            await client.post(
                f"/api/materials/{material['id']}/translations",
                json=request(source_id, material)
                | {
                    "material_provenance": provenance(material, span("r1", 0, 2, 6)),
                    "text": "𠮷 文。",
                },
            )
        ).json()
        await translations.execute(app, task["id"])
        done = (await client.get(f"/api/translation-tasks/{task['id']}")).json()
        original = provenance(material, span("r1", 0, 0, 7))
        saved = await client.post(
            f"/api/sources/{source_id}/segments",
            json={
                "request_id": str(uuid4()),
                "material_provenance": original,
                "translation_result_id": done["result_id"],
                "translation": "副本",
            },
        )
        assert saved.status_code == 201, saved.text
        assert saved.json()["text"] == TEXTS["r1"]
        stored = await client.get(f"/api/segments/{saved.json()['id']}/material-provenance")
        assert stored.status_code == 200, stored.text
        assert stored.json()["material_provenance"]["ranges"][0]["start"] == 0
        assert stored.json()["material_provenance"]["ranges"][0]["end"] == 7
        assert stored.json()["material_provenance"]["ranges"][0]["exact"] == TEXTS["r1"]
