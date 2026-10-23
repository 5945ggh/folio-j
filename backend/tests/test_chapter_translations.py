"""Offline exact chapter history is complete, deduplicated, ordered and read-only."""

import asyncio
import base64
import hashlib
import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from test_chat_api import chat_client
from test_segment_provenance import compiled_provenance, provenance, setup_material, span

from app.epub_schemas import CompiledBook
from app.provenance_schemas import MaterialProvenance
from app.services import chapter_translations, translations
from app.services.material_provenance import identity_sha256, validate_reference
from app.translation_models import TranslationResult, TranslationTask


def endpoint(material: dict[str, Any], chapter: str = "c1") -> str:
    return f"/api/materials/{material['id']}/chapters/{chapter}/translations"


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


def table_counts(database: Path) -> list[int]:
    with sqlite3.connect(database) as connection:
        return [
            connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in (
                "segments",
                "translation_tasks",
                "translation_results",
                "translation_adoptions",
                "runs",
                "reading_positions",
            )
        ]


@pytest.mark.asyncio
async def test_exact_groups_keep_latest_success_and_original_order_without_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)

    async def forbidden(*_args: Any) -> None:
        pytest.fail("reading chapter history must not invoke the model")

    monkeypatch.setattr(translations, "generate_text", forbidden)
    database = tmp_path / "ordered.db"
    async with chat_client(database) as (client, app):
        source, material = await setup_material(client)
        early = provenance(material, span("r1", 0, 0, 2))
        repeated = provenance(material, span("r1", 2, 0, 2))
        short = provenance(material, span("r1", 0, 0, 1))
        middle = provenance(material)
        later_id = await seed_result(app, source, repeated, 1)
        middle_id = await seed_result(app, source, middle, 2)
        old_id = await seed_result(app, source, early, 3)
        short_id = await seed_result(app, source, short, 4)
        same_time = datetime(2026, 2, 1, tzinfo=UTC)
        await seed_result(app, source, early, 5, timestamp=same_time)
        latest_id = await seed_result(app, source, early, 6, timestamp=same_time)
        await seed_result(app, source, provenance(material, span("r3", 3, 0, 2)), 7)
        for ordinal, status in enumerate(
            ("failed", "cancelled", "queued", "running", "interrupted"), start=8
        ):
            await seed_result(app, source, early, ordinal, status=status)
        before = table_counts(database)
        response = await client.get(
            endpoint(material), params={"version_id": material["version_id"]}
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["next_cursor"] is None and data["unavailable_count"] == 0
        assert [item["result_id"] for item in data["items"]] == [
            short_id,
            latest_id,
            middle_id,
            later_id,
        ]
        assert old_id not in [item["result_id"] for item in data["items"]]
        assert [item["result_count"] for item in data["items"]] == [1, 3, 1, 1]
        early_item, repeated_item = data["items"][1], data["items"][3]
        assert early_item["excerpt"] == repeated_item["excerpt"] == "前か"
        assert early_item["identity_sha256"] != repeated_item["identity_sha256"]
        assert early_item["translation_excerpt"] == "译文6"
        assert early_item["target_language"] == "简体中文"
        assert early_item["created_at"].endswith("Z")
        assert table_counts(database) == before


@pytest.mark.asyncio
async def test_keyset_pages_all_targets_over_hundred_and_retranslation_does_not_repeat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = compiled_provenance(b"")
    text = "日本語" * 40
    resource = base.resources[0].model_copy(
        update={"text": text, "text_sha256": hashlib.sha256(text.encode()).hexdigest()}
    )
    part = base.chapters[0].parts[0].model_copy(update={"end": len(text)})
    book = base.model_copy(
        update={
            "resources": [resource],
            "chapters": [base.chapters[0].model_copy(update={"parts": [part]})],
        }
    )

    def compile_book(_data: bytes) -> CompiledBook:
        return book

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compile_book)
    async with chat_client(tmp_path / "pages.db") as (client, app):
        source, material = await setup_material(client)

        def reference(index: int) -> dict[str, Any]:
            return provenance(
                material,
                dict(
                    resource_id="r1",
                    spine_index=0,
                    start=index,
                    end=index + 1,
                    exact=text[index : index + 1],
                    text_sha256=resource.text_sha256,
                ),
            )

        expected: list[str] = []
        for index in reversed(range(105)):
            expected.insert(0, await seed_result(app, source, reference(index), index, book=book))
        params: dict[str, Any] = {"version_id": material["version_id"], "limit": 17}
        seen: list[str] = []
        data: dict[str, Any] = {}
        for page in range(7):
            response = await client.get(endpoint(material), params=params)
            assert response.status_code == 200, response.text
            data = response.json()
            seen.extend(item["result_id"] for item in data["items"])
            if page == 0:
                # Result identity changes; its source position and cursor identity do not.
                await seed_result(app, source, reference(0), 999, book=book)
            if data["next_cursor"] is None:
                break
            params["after"] = data["next_cursor"]
        assert seen == expected and len(set(seen)) == 105
        assert data["next_cursor"] is None


@pytest.mark.asyncio
async def test_scoped_unavailable_targets_do_not_replace_valid_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "invalid.db") as (client, app):
        source, material = await setup_material(client)
        good = provenance(material, span("r1", 0, 0, 2))
        good_id = await seed_result(app, source, good, 1)
        await seed_result(app, source, good, 2)
        unavailable = provenance(material, span("r1", 2, 0, 2))
        await seed_result(app, source, unavailable, 3)
        await seed_result(app, source, unavailable, 4)
        await seed_result(app, source, provenance(material, span("r3", 3, 0, 2)), 5)
        await seed_result(app, source, provenance(material), 6)
        async with app.state.session_factory() as session:
            for ordinal in (2, 3, 4, 5, 6):
                task = await session.get(TranslationTask, f"T{ordinal:025d}")
                assert task is not None
                payload = json.loads(task.payload)
                payload["material_provenance"]["ranges"][0]["exact"] = "坏"
                task.payload = "broken-json" if ordinal == 6 else json.dumps(payload)
            await session.commit()
        data = (
            await client.get(endpoint(material), params={"version_id": material["version_id"]})
        ).json()
        assert [item["result_id"] for item in data["items"]] == [good_id]
        assert data["items"][0]["result_count"] == 1
        assert data["unavailable_count"] == 1
        other = (
            await client.get(
                endpoint(material, "c2"), params={"version_id": material["version_id"]}
            )
        ).json()
        assert other["items"] == [] and other["unavailable_count"] == 1


@pytest.mark.asyncio
async def test_cursor_binding_input_bounds_and_ancestor_version_gates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "gates.db") as (client, app):
        source, material = await setup_material(client)
        await seed_result(app, source, provenance(material, span("r1", 0, 0, 1)), 1)
        await seed_result(app, source, provenance(material, span("r1", 0, 0, 2)), 2)
        params = {"version_id": material["version_id"]}
        first = (await client.get(endpoint(material), params=params | {"limit": 1})).json()
        cursor = first["next_cursor"]
        assert cursor
        assert (
            await client.get(endpoint(material, "c2"), params=params | {"after": cursor})
        ).status_code == 422
        for field, value in (("material_id", "other"), ("version_id", "old"), ("chapter_id", "c2")):
            value_cursor = json.loads(base64.urlsafe_b64decode(cursor))
            value_cursor[field] = value
            changed = base64.urlsafe_b64encode(json.dumps(value_cursor).encode()).decode()
            assert (
                await client.get(endpoint(material), params=params | {"after": changed})
            ).status_code == 422
        for position in (
            [-1, 0, 0, 1, "a" * 64],
            [0, 2, 0, 1, "a" * 64],
            [1, 0, 0, 1, "a" * 64],
            [0, 0, 0, 1, "z" * 64],
            [False, 0, 0, 1, "a" * 64],
        ):
            value_cursor = json.loads(base64.urlsafe_b64decode(cursor))
            value_cursor["position"] = position
            changed = base64.urlsafe_b64encode(json.dumps(value_cursor).encode()).decode()
            assert (
                await client.get(endpoint(material), params=params | {"after": changed})
            ).status_code == 422
        for invalid in (
            {"after": "broken"},
            {"after": ""},
            {"limit": 0},
            {"limit": 101},
            {"version_id": ""},
        ):
            assert (
                await client.get(endpoint(material), params=params | invalid)
            ).status_code == 422
        assert (await client.get(endpoint(material))).status_code == 422
        assert (
            await client.get(endpoint(material), params={"version_id": "stale"})
        ).status_code == 409
        assert (await client.get(endpoint(material, "absent"), params=params)).status_code == 404
        assert (await client.delete(f"/api/materials/{material['id']}")).status_code == 204
        assert (await client.get(endpoint(material), params=params)).status_code == 404
        _, other = await setup_material(client)
        assert (await client.delete(f"/api/sources/{other['source_id']}")).status_code == 204
        assert (
            await client.get(endpoint(other), params={"version_id": other["version_id"]})
        ).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "corruption", ["identity", "text", "parts", "chapter", "version", "material", "source", "empty"]
)
async def test_persisted_metadata_cannot_misplace_a_successful_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corruption: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    async with chat_client(tmp_path / "metadata.db") as (client, app):
        source, material = await setup_material(client)
        other = (await client.post("/api/sources", json={"title": "其他来源"})).json()
        await seed_result(app, source, provenance(material), 1)
        async with app.state.session_factory() as session:
            task = await session.get(TranslationTask, f"T{1:025d}")
            result = await session.get(TranslationResult, f"{1:026d}")
            assert task is not None and result is not None
            payload = json.loads(task.payload)
            if corruption == "identity":
                task.identity_sha256 = "a" * 64
            elif corruption == "source":
                task.source_id = other["id"]
            elif corruption == "empty":
                result.translation = "  "
            elif corruption == "text":
                payload["text"] = "不同的原文"
            elif corruption == "parts":
                payload["parts"][0]["start"] = 0
            elif corruption == "chapter":
                payload["chapter_id"] = "c2"
            else:
                payload["material_provenance"][f"{corruption}_id"] = "different"
            task.payload = json.dumps(payload)
            await session.commit()
        response = await client.get(
            endpoint(material), params={"version_id": material["version_id"]}
        )
        assert response.status_code == 200, response.text
        assert response.json()["items"] == []
        assert response.json()["unavailable_count"] == int(
            corruption in {"identity", "text", "parts", "empty"}
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation", ["material", "source", "version", "bundle", "payload", "result", "status"]
)
async def test_final_gate_rechecks_visibility_and_immutable_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled_provenance)
    database = tmp_path / "race.db"
    async with chat_client(database) as (client, app):
        source, material = await setup_material(client)
        await seed_result(app, source, provenance(material), 1)
        entered, release = threading.Event(), threading.Event()
        original = chapter_translations.validate_candidates

        def delayed(
            identity: chapter_translations.MaterialIdentity,
            chapter: str,
            rows: list[chapter_translations.Candidate],
        ) -> dict[str, tuple[chapter_translations.Validated | None, bool]]:
            result = original(identity, chapter, rows)
            entered.set()
            assert release.wait(5)
            return result

        monkeypatch.setattr(chapter_translations, "validate_candidates", delayed)
        pending = asyncio.create_task(
            client.get(endpoint(material), params={"version_id": material["version_id"]})
        )
        assert await asyncio.to_thread(entered.wait, 5)
        try:
            if mutation in {"material", "source"}:
                target = (
                    f"/api/materials/{material['id']}"
                    if mutation == "material"
                    else f"/api/sources/{source}"
                )
                assert (await client.delete(target)).status_code == 204
            else:
                with sqlite3.connect(database) as connection:
                    statement, parameters = {
                        "version": (
                            "UPDATE materials SET version_id='changed' WHERE id=?",
                            (material["id"],),
                        ),
                        "bundle": (
                            "UPDATE materials SET compiled_bundle=? WHERE id=?",
                            (b"changed", material["id"]),
                        ),
                        "payload": (
                            "UPDATE translation_tasks SET payload='changed' WHERE id=?",
                            (f"T{1:025d}",),
                        ),
                        "result": (
                            "UPDATE translation_results SET translation='changed' WHERE id=?",
                            (f"{1:026d}",),
                        ),
                        "status": (
                            "UPDATE translation_tasks SET status='failed' WHERE id=?",
                            (f"T{1:025d}",),
                        ),
                    }[mutation]
                    connection.execute(statement, parameters)
                    connection.commit()
        finally:
            release.set()
        response = await pending
        assert response.status_code == (
            404
            if mutation in {"material", "source"}
            else 409
            if mutation in {"version", "bundle"}
            else 200
        ), response.text
        if response.status_code == 200:
            assert response.json()["items"] == []
            assert response.json()["unavailable_count"] == int(mutation in {"payload", "result"})
