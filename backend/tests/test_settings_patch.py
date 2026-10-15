"""Partial settings saves preserve other groups and commit atomically, offline."""

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from test_settings_api import (
    create_provider,
    settings_client,
)
from test_settings_api import (
    offline_discovery as offline_discovery,
)

PROFILE = {"native_language": "日本語", "explain_language": "中文", "level_note": "N2"}


@pytest.mark.asyncio
async def test_patch_saves_only_submitted_fields_and_supports_explicit_clears(
    tmp_path: Path,
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        initial = (await client.get("/api/settings")).json()
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        defaults = {
            **initial["defaults"],
            "analysis_model_id": model["id"],
            "chat_model_id": model["id"],
            "extraction_model_id": model["id"],
        }
        assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
        saved = await client.patch(
            "/api/settings", json={"profile": PROFILE, "defaults": {"style_id": None}}
        )
        assert saved.status_code == 200, saved.text
        expected: dict[str, Any] = {
            **initial,
            "profile": PROFILE,
            "defaults": {**defaults, "style_id": None},
        }
        assert saved.json() == expected
        changed = await client.patch(
            "/api/settings",
            json={"defaults": {"analysis_model_id": None, "permission_mode": "full_access"}},
        )
        assert changed.status_code == 200, changed.text
        expected["defaults"].update(analysis_model_id=None, permission_mode="full_access")
        assert changed.json() == expected
        noop_payloads: list[dict[str, Any]] = [{}, {"defaults": {}}]
        for payload in noop_payloads:
            response = await client.patch("/api/settings", json=payload)
            assert response.status_code == 200, response.text
            assert response.json() == expected
        cleared = await client.patch(
            "/api/settings", json={"defaults": {"chat_model_id": None, "extraction_model_id": None}}
        )
        assert cleared.status_code == 200, cleared.text
        expected["defaults"].update(chat_model_id=None, extraction_model_id=None)
        assert cleared.json() == expected


@pytest.mark.asyncio
async def test_concurrent_first_patches_preserve_both_groups(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        responses = await asyncio.gather(
            client.patch("/api/settings", json={"profile": PROFILE}),
            client.patch("/api/settings", json={"defaults": {"permission_mode": "full_access"}}),
        )
        assert [response.status_code for response in responses] == [200, 200]
        current = (await client.get("/api/settings")).json()
        assert current["profile"] == PROFILE
        assert current["defaults"]["permission_mode"] == "full_access"
        assert len(current["styles"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "defaults",
    [
        {"style_id": "missing-style"},
        {"analysis_model_id": "missing-model"},
        {"chat_model_id": "missing-model"},
        {"extraction_model_id": "missing-model"},
        {"permission_mode": "unsupported"},
        {"permission_mode": None},
    ],
)
async def test_patch_invalid_defaults_never_partially_save_profile(
    tmp_path: Path, defaults: dict[str, str | None]
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        initial = (await client.get("/api/settings")).json()
        response = await client.patch(
            "/api/settings", json={"profile": PROFILE, "defaults": defaults}
        )
        assert response.status_code == 422, response.text
        assert (await client.get("/api/settings")).json() == initial


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"profile": None},
        {"defaults": None},
        {"profile": {"level_note": "incomplete"}, "defaults": {"permission_mode": "full_access"}},
        {"profile": PROFILE, "defaults": {"unknown": True}},
        {"unknown": {}},
    ],
)
async def test_patch_rejects_invalid_groups_and_unknown_fields(
    tmp_path: Path, payload: dict[str, object]
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        initial = (await client.get("/api/settings")).json()
        assert (await client.patch("/api/settings", json=payload)).status_code == 422
        assert (await client.get("/api/settings")).json() == initial


@pytest.mark.asyncio
async def test_failed_first_patch_does_not_commit_initialization_or_profile(tmp_path: Path) -> None:
    database = tmp_path / "folio.db"
    async with settings_client(database) as client:
        response = await client.patch(
            "/api/settings", json={"profile": PROFILE, "defaults": {"style_id": "missing"}}
        )
        assert response.status_code == 422
        with sqlite3.connect(database) as connection:
            for table in ("learner_profile", "settings_defaults", "explanation_styles"):
                assert connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unavailable", ["disabled_model", "disabled_provider", "deleted_model", "deleted_provider"]
)
async def test_unsubmitted_unavailable_model_does_not_block_other_groups(
    tmp_path: Path, unavailable: str
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        initial = (await client.get("/api/settings")).json()
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        defaults = {**initial["defaults"], "analysis_model_id": model["id"]}
        assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
        target = (
            f"/api/providers/{provider['id']}"
            if "provider" in unavailable
            else f"/api/provider-models/{model['id']}"
        )
        response = (
            await client.delete(target)
            if unavailable.startswith("deleted")
            else await client.patch(target, json={"enabled": False})
        )
        assert response.status_code in (200, 204), response.text
        for payload in (
            {"profile": PROFILE},
            {"defaults": {"permission_mode": "full_access"}},
            {"defaults": {"style_id": None}},
        ):
            response = await client.patch("/api/settings", json=payload)
            assert response.status_code == 200, response.text
            assert response.json()["defaults"]["analysis_model_id"] == model["id"]
        before_invalid = (await client.get("/api/settings")).json()
        invalid = await client.patch(
            "/api/settings",
            json={
                "profile": {**PROFILE, "level_note": "changed"},
                "defaults": {"analysis_model_id": model["id"]},
            },
        )
        assert invalid.status_code == 422
        assert (await client.get("/api/settings")).json() == before_invalid
        cleared = await client.patch(
            "/api/settings", json={"defaults": {"analysis_model_id": None}}
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["defaults"]["analysis_model_id"] is None


@pytest.mark.asyncio
async def test_put_contract_remains_a_complete_replacement(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        initial = (await client.get("/api/settings")).json()
        assert (await client.put("/api/settings/profile", json=PROFILE)).json() == PROFILE
        defaults = {**initial["defaults"], "permission_mode": "full_access"}
        assert (await client.put("/api/settings/defaults", json=defaults)).json() == defaults
        assert (
            await client.put("/api/settings/defaults", json={"permission_mode": "review"})
        ).status_code == 422
        assert (
            await client.put("/api/settings/profile", json={"level_note": "partial"})
        ).status_code == 422
