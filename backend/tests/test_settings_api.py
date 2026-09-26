"""Offline API contracts for settings and local credentials."""

import asyncio
import json
import sqlite3
import stat
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.db import Base, create_engine
from app.llm import adapters
from app.main import create_app
from app.services import settings as settings_service
from app.settings_models import Run


@pytest.fixture(autouse=True)
def offline_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_models(_url: str, _key: str | None) -> list[str]:
        return []

    monkeypatch.setattr("app.llm.adapters.discover_models", no_models)


@asynccontextmanager
async def settings_app_client(database: Path) -> AsyncGenerator[tuple[AsyncClient, FastAPI], None]:
    engine = create_engine(database)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()
    application = create_app(database_path=database)
    application.state.verification_worker_enabled = False
    async with application.router.lifespan_context(application):
        async with AsyncClient(
            transport=ASGITransport(app=application), base_url="http://test"
        ) as client:
            yield client, application


@asynccontextmanager
async def settings_client(database: Path) -> AsyncGenerator[AsyncClient, None]:
    async with settings_app_client(database) as (client, _application):
        yield client


def provider_payload(**changes: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "本地测试",
        "base_url": "http://localhost:8765/v1",
        "protocol": "chat_completions",
        "enabled": True,
    }
    payload.update(changes)
    return payload


async def create_provider(client: AsyncClient, **changes: object) -> dict[str, Any]:
    response = await client.post("/api/providers", json=provider_payload(**changes))
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_settings_profile_styles_and_defaults_roundtrip(tmp_path: Path) -> None:
    database = tmp_path / "folio.db"
    async with settings_client(database) as client:
        initial = await client.get("/api/settings")
        assert initial.status_code == 200, initial.text
        settings = initial.json()
        assert settings["defaults"]["permission_mode"] == "review"
        assert len(settings["styles"]) >= 1
        assert settings["defaults"]["style_id"] in {item["id"] for item in settings["styles"]}

        profile = {
            "native_language": "中文",
            "explain_language": "日本語",
            "level_note": "初級から学ぶ",
        }
        saved = await client.put("/api/settings/profile", json=profile)
        assert saved.status_code == 200, saved.text
        assert saved.json() == profile

        created = await client.post(
            "/api/settings/styles", json={"name": "细读", "body_md": "逐句解释。"}
        )
        assert created.status_code == 201, created.text
        style = created.json()
        edited = await client.put(
            f"/api/settings/styles/{style['id']}",
            json={"name": "语法细读", "body_md": "说明活用。"},
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["body_md"] == "说明活用。"
        defaults = {
            "analysis_model_id": None,
            "chat_model_id": None,
            "extraction_model_id": None,
            "style_id": style["id"],
            "permission_mode": "full_access",
        }
        changed = await client.put("/api/settings/defaults", json=defaults)
        assert changed.status_code == 200, changed.text
        assert changed.json() == defaults
        assert (await client.delete(f"/api/settings/styles/{style['id']}")).status_code == 409

    async with settings_client(database) as client:
        reloaded = (await client.get("/api/settings")).json()
        assert reloaded["profile"] == profile
        assert reloaded["defaults"] == defaults
        assert (
            next(item for item in reloaded["styles"] if item["id"] == style["id"])["name"]
            == "语法细读"
        )


@pytest.mark.asyncio
async def test_provider_credentials_are_stripped_private_and_never_returned(tmp_path: Path) -> None:
    database = tmp_path / "folio.db"
    secret = "fictional_test_key_123"
    async with settings_client(database) as client:
        provider = await create_provider(client, api_key=f"  {secret}\n")
        assert provider["has_api_key"] is True
        assert secret not in json.dumps(provider)
        provider_id = provider["id"]
        secret_dir = tmp_path / "folio.db.secrets"
        assert stat.S_IMODE(secret_dir.stat().st_mode) == 0o700
        secret_files = list(secret_dir.iterdir())
        assert len(secret_files) == 1
        assert stat.S_IMODE(secret_files[0].stat().st_mode) == 0o600
        assert secret_files[0].read_text() == secret
        assert secret not in database.read_bytes().decode("utf-8", errors="ignore")

        retained = await client.patch(f"/api/providers/{provider_id}", json={"name": "改名"})
        assert retained.status_code == 200, retained.text
        assert retained.json()["has_api_key"] is True
        cleared = await client.patch(f"/api/providers/{provider_id}", json={"api_key": ""})
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["has_api_key"] is False
        assert secret not in (await client.get(f"/api/providers/{provider_id}")).text


@pytest.mark.asyncio
async def test_provider_rejects_unsafe_urls_and_redacts_validation_input(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        secret = "fictional_key_never_echo_this"
        for url in (
            "https://user:password@example.invalid/v1",
            "https://example.invalid/v1?key=secret",
            "https://example.invalid/v1#secret",
            "file:///tmp/model",
        ):
            response = await client.post(
                "/api/providers", json=provider_payload(base_url=url, api_key=secret)
            )
            assert response.status_code == 422, (url, response.text)
            assert secret not in response.text
        response = await client.post(
            "/api/providers", json=provider_payload(api_key=secret, unknown="bad")
        )
        assert response.status_code == 422, response.text
        assert secret not in response.text
        provider = await create_provider(client)
        assert provider["has_api_key"] is False


@pytest.mark.asyncio
async def test_models_protocol_defaults_and_provider_disable(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        provider_id = provider["id"]
        response = await client.post(
            f"/api/providers/{provider_id}/models", json={"model_id": "demo-model"}
        )
        assert response.status_code == 201, response.text
        model = response.json()
        assert model["effective_protocol"] == "chat_completions"
        assert model["text_status"] == model["stream_status"] == "unknown"
        model_id = model["id"]
        changed = await client.patch(
            f"/api/provider-models/{model_id}",
            json={"protocol_override": "responses", "reasoning_effort": "low"},
        )
        assert changed.status_code == 200, changed.text
        assert changed.json()["effective_protocol"] == "responses"
        defaults = {
            "analysis_model_id": model_id,
            "chat_model_id": model_id,
            "extraction_model_id": model_id,
            "style_id": None,
            "permission_mode": "review",
        }
        assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
        disabled = await client.patch(f"/api/providers/{provider_id}", json={"enabled": False})
        assert disabled.status_code == 200, disabled.text
        assert disabled.json()["enabled"] is False
        assert (
            await client.post(
                f"/api/provider-models/{model_id}/verifications", json={"stream": False}
            )
        ).status_code == 409
        current = (await client.get("/api/settings")).json()
        assert current["defaults"]["analysis_model_id"] == model_id


@pytest.mark.asyncio
async def test_provider_patch_only_invalidates_when_connection_changes(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client, api_key="first_key")
        provider_id = provider["id"]
        model = (
            await client.post(f"/api/providers/{provider_id}/models", json={"model_id": "demo"})
        ).json()
        accepted = (
            await client.post(
                f"/api/provider-models/{model['id']}/verifications", json={"stream": False}
            )
        ).json()
        unchanged = await client.patch(
            f"/api/providers/{provider_id}",
            json={
                "name": provider["name"],
                "base_url": provider["base_url"],
                "protocol": provider["protocol"],
                "enabled": provider["enabled"],
            },
        )
        assert unchanged.json()["revision"] == provider["revision"]
        assert unchanged.json()["models"][0]["text_verification"]["id"] == accepted["id"]
        renamed = await client.patch(
            f"/api/providers/{provider_id}", json={"name": "new", "enabled": False}
        )
        assert renamed.json()["revision"] == provider["revision"]
        assert renamed.json()["models"][0]["text_verification"]["id"] == accepted["id"]
        changed = await client.patch(
            f"/api/providers/{provider_id}", json={"protocol": "responses"}
        )
        assert changed.json()["revision"] == provider["revision"] + 1
        assert changed.json()["models"][0]["text_verification"] is None
        same_address = await client.patch(
            f"/api/providers/{provider_id}", json={"base_url": provider["base_url"]}
        )
        assert same_address.json()["revision"] == changed.json()["revision"]
        new_address = await client.patch(
            f"/api/providers/{provider_id}", json={"base_url": "http://localhost:9000/v1"}
        )
        assert new_address.json()["revision"] == changed.json()["revision"] + 1
        replaced = await client.patch(f"/api/providers/{provider_id}", json={"api_key": "new_key"})
        assert replaced.json()["revision"] == new_address.json()["revision"] + 1
        cleared = await client.patch(f"/api/providers/{provider_id}", json={"api_key": ""})
        assert cleared.json()["revision"] == replaced.json()["revision"] + 1
        clear_again = await client.patch(f"/api/providers/{provider_id}", json={"api_key": ""})
        assert clear_again.json()["revision"] == cleared.json()["revision"]


@pytest.mark.asyncio
async def test_persisted_provider_and_run_timestamps_keep_utc_offset(tmp_path: Path) -> None:
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        provider = await create_provider(client)
        provider_id = provider["id"]
        model = (
            await client.post(f"/api/providers/{provider_id}/models", json={"model_id": "demo"})
        ).json()
        accepted = (
            await client.post(
                f"/api/provider-models/{model['id']}/verifications", json={"stream": False}
            )
        ).json()
        async with application.state.session_factory() as session:
            run = await session.get(Run, accepted["id"])
            assert run is not None
            run.status = "succeeded"
            run.started_at = settings_service.now()
            run.finished_at = settings_service.now()
            await session.commit()

        persisted_provider = (await client.get(f"/api/providers/{provider_id}")).json()
        for field in ("created_at", "updated_at", "last_discovered_at"):
            assert persisted_provider[field].endswith("Z"), field
        persisted_run = (await client.get(f"/api/runs/{accepted['id']}")).json()
        for field in ("created_at", "started_at", "finished_at"):
            assert persisted_run[field].endswith("Z"), field
        summary = persisted_provider["models"][0]["text_verification"]
        assert summary["created_at"] == persisted_run["created_at"]
        assert summary["finished_at"] == persisted_run["finished_at"]


@pytest.mark.asyncio
async def test_model_patch_only_invalidates_when_parameters_change(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        accepted = (
            await client.post(
                f"/api/provider-models/{model['id']}/verifications", json={"stream": True}
            )
        ).json()
        url = f"/api/provider-models/{model['id']}"
        unchanged = await client.patch(
            url,
            json={
                "protocol_override": None,
                "enabled": True,
                "temperature": None,
                "max_output_tokens": None,
                "reasoning_effort": None,
            },
        )
        assert unchanged.json()["revision"] == model["revision"]
        assert unchanged.json()["stream_verification"]["id"] == accepted["id"]
        disabled = await client.patch(url, json={"enabled": False})
        assert disabled.json()["revision"] == model["revision"]
        assert disabled.json()["stream_verification"]["id"] == accepted["id"]
        changed = await client.patch(url, json={"max_output_tokens": 64})
        assert changed.json()["revision"] == model["revision"] + 1
        assert changed.json()["stream_verification"] is None
        assert changed.json()["stream_status"] == "unknown"
        same = await client.patch(url, json={"max_output_tokens": 64})
        assert same.json()["revision"] == changed.json()["revision"]
        protocol_changed = await client.patch(url, json={"protocol_override": "responses"})
        assert protocol_changed.json()["revision"] == changed.json()["revision"] + 1


@pytest.mark.asyncio
async def test_large_output_limit_roundtrips_and_accepted_runs_keep_their_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed: list[int | None] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        _api_key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        observed.append(snapshot.max_output_tokens)
        return adapters.GenerateResult(text="ok", completed=True, usage=None, raw_response=None)

    monkeypatch.setattr(adapters, "generate_text", generate)
    database = tmp_path / "folio.db"
    async with settings_app_client(database) as (client, application):
        provider = await create_provider(client, protocol="responses")
        created = await client.post(
            f"/api/providers/{provider['id']}/models",
            json={"model_id": "large-context", "max_output_tokens": 128000},
        )
        assert created.status_code == 201, created.text
        model = created.json()
        assert model["max_output_tokens"] == 128000
        assert (await client.get(f"/api/providers/{provider['id']}")).json()["models"][0][
            "max_output_tokens"
        ] == 128000
        verify_url = f"/api/provider-models/{model['id']}/verifications"
        old = await client.post(verify_url, json={"stream": False})
        assert old.status_code == 202, old.text
        assert old.json()["protocol"] == "responses"

        edited = await client.patch(
            f"/api/provider-models/{model['id']}", json={"max_output_tokens": 131072}
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["max_output_tokens"] == 131072
        assert edited.json()["revision"] == model["revision"] + 1
        assert (await client.get(f"/api/providers/{provider['id']}")).json()["models"][0][
            "max_output_tokens"
        ] == 131072
        fresh = await client.post(verify_url, json={"stream": True})
        assert fresh.status_code == 202, fresh.text

        async with application.state.session_factory() as session:
            old_run = await session.get(Run, old.json()["id"])
            fresh_run = await session.get(Run, fresh.json()["id"])
            assert old_run is not None and fresh_run is not None
            assert old_run.max_output_tokens == 128000
            assert fresh_run.max_output_tokens == 131072
        await settings_service.execute_verification(application, old.json()["id"])
        await settings_service.execute_verification(application, fresh.json()["id"])
        assert observed == [128000, 131072]

        cleared = await client.patch(
            f"/api/provider-models/{model['id']}", json={"max_output_tokens": None}
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["max_output_tokens"] is None
        unspecified = await client.post(verify_url, json={"stream": False})
        assert unspecified.status_code == 202, unspecified.text
        async with application.state.session_factory() as session:
            run = await session.get(Run, unspecified.json()["id"])
            assert run is not None and run.max_output_tokens is None
        await settings_service.execute_verification(application, unspecified.json()["id"])
        assert observed == [128000, 131072, None]

    async with settings_client(database) as client:
        reloaded = (await client.get(f"/api/providers/{provider['id']}")).json()
        assert reloaded["models"][0]["max_output_tokens"] is None
        assert (await client.get(f"/api/runs/{old.json()['id']}")).json()["status"] == "succeeded"


@pytest.mark.asyncio
async def test_output_limit_rejects_nonpositive_fractional_and_storage_overflow_values(
    tmp_path: Path,
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        create_url = f"/api/providers/{provider['id']}/models"
        created = await client.post(create_url, json={"model_id": "limit-boundary"})
        assert created.status_code == 201, created.text
        patch_url = f"/api/provider-models/{created.json()['id']}"
        for value in (0, -1, 1.5, 2**31):
            create = await client.post(
                create_url, json={"model_id": f"invalid-{value}", "max_output_tokens": value}
            )
            patch = await client.patch(patch_url, json={"max_output_tokens": value})
            assert create.status_code == 422, (value, create.text)
            assert patch.status_code == 422, (value, patch.text)
        maximum = await client.patch(patch_url, json={"max_output_tokens": 2**31 - 1})
        assert maximum.status_code == 200, maximum.text
        assert maximum.json()["max_output_tokens"] == 2**31 - 1


def test_model_output_limit_openapi_allows_128k_and_caps_at_storage_boundary() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    for schema_name in ("ModelInput", "ModelPatch"):
        field = schemas[schema_name]["properties"]["max_output_tokens"]
        integer = next(option for option in field["anyOf"] if option["type"] == "integer")
        assert integer["minimum"] == 1
        assert integer["maximum"] == 2**31 - 1
        assert {option["type"] for option in field["anyOf"]} == {"integer", "null"}


@pytest.mark.asyncio
async def test_first_settings_reads_initialize_once_under_concurrency(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        responses = await asyncio.gather(*(client.get("/api/settings") for _ in range(12)))
        assert all(response.status_code == 200 for response in responses), [
            (response.status_code, response.text) for response in responses
        ]
        style_ids = [response.json()["defaults"]["style_id"] for response in responses]
        assert len(set(style_ids)) == 1
        assert len((await client.get("/api/settings")).json()["styles"]) == 1


@pytest.mark.asyncio
async def test_model_discovery_failure_keeps_cached_ids_and_manual_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def discovered(_url: str, _key: str | None) -> list[str]:
        return ["remote-a", "remote-b"]

    monkeypatch.setattr("app.llm.adapters.discover_models", discovered)
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        assert provider["discovery_status"] == "succeeded"
        assert provider["discovered_models"] == ["remote-a", "remote-b"]
        manual = await client.post(
            f"/api/providers/{provider['id']}/models", json={"model_id": "manual-only"}
        )
        assert manual.status_code == 201, manual.text

        async def failed(_url: str, _key: str | None) -> list[str]:
            raise RuntimeError("fictional key must not escape")

        monkeypatch.setattr("app.llm.adapters.discover_models", failed)
        disabled = await client.patch(f"/api/providers/{provider['id']}", json={"enabled": False})
        assert disabled.json()["enabled"] is False
        refresh = await client.post(f"/api/providers/{provider['id']}/refresh-models")
        assert refresh.status_code == 200, refresh.text
        current = refresh.json()
        assert current["discovery_status"] == "failed"
        assert current["discovered_models"] == ["remote-a", "remote-b"]
        assert [model["model_id"] for model in current["models"]] == ["manual-only"]
        assert "fictional key" not in json.dumps(current)


@pytest.mark.asyncio
async def test_stale_discovery_cannot_restore_models_from_previous_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def delayed_discovery(_url: str, _key: str | None) -> list[str]:
        started.set()
        await release.wait()
        return ["old-endpoint-model"]

    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        monkeypatch.setattr(adapters, "discover_models", delayed_discovery)
        refresh_task = asyncio.create_task(
            client.post(f"/api/providers/{provider['id']}/refresh-models")
        )
        await asyncio.wait_for(started.wait(), timeout=2)
        changed = await client.patch(
            f"/api/providers/{provider['id']}",
            json={"base_url": "http://localhost:9000/v1"},
        )
        assert changed.status_code == 200, changed.text
        release.set()
        refresh = await refresh_task
        assert refresh.status_code == 200, refresh.text
        current = (await client.get(f"/api/providers/{provider['id']}")).json()
        assert current["revision"] == provider["revision"] + 1
        assert current["discovered_models"] == []
        assert current["discovery_status"] == "never"


@pytest.mark.asyncio
async def test_simultaneous_provider_and_model_edits_each_advance_revision(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        provider_url = f"/api/providers/{provider['id']}"
        responses = await asyncio.gather(
            client.patch(provider_url, json={"base_url": "http://localhost:9001/v1"}),
            client.patch(provider_url, json={"protocol": "responses"}),
        )
        assert all(response.status_code == 200 for response in responses), [
            (response.status_code, response.text) for response in responses
        ]
        current = (await client.get(provider_url)).json()
        assert current["revision"] == provider["revision"] + 2
        assert current["base_url"] == "http://localhost:9001/v1"
        assert current["protocol"] == "responses"

        model_url = f"/api/provider-models/{model['id']}"
        model_responses = await asyncio.gather(
            client.patch(model_url, json={"temperature": 0.4}),
            client.patch(model_url, json={"max_output_tokens": 64}),
        )
        assert all(response.status_code == 200 for response in model_responses), [
            (response.status_code, response.text) for response in model_responses
        ]
        current_model = (await client.get(provider_url)).json()["models"][0]
        assert current_model["revision"] == model["revision"] + 2
        assert current_model["temperature"] == 0.4
        assert current_model["max_output_tokens"] == 64


def test_openapi_provider_input_and_output_keep_credentials_separate() -> None:
    schemas = create_app().openapi()["components"]["schemas"]
    assert "api_key" in schemas["ProviderInput"]["properties"]
    assert "api_key" in schemas["ProviderPatch"]["properties"]
    assert "enabled" not in schemas["ProviderPatch"].get("required", [])
    assert "api_key" not in schemas["ProviderResponse"]["properties"]
    assert "api_key" not in schemas["RunResponse"]["properties"]


@pytest.mark.asyncio
async def test_provider_model_identity_is_unique_in_database(tmp_path: Path) -> None:
    """Two tabs can both pass the API's pre-insert lookup; SQLite must arbitrate."""
    database = tmp_path / "folio.db"
    async with settings_client(database) as client:
        provider = await create_provider(client)
        first = await client.post(
            f"/api/providers/{provider['id']}/models", json={"model_id": "same-model"}
        )
        assert first.status_code == 201, first.text

    with sqlite3.connect(database) as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO provider_models "
                "(id, provider_id, model_id, enabled, revision, text_status, stream_status) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    "01ARZ3NDEKTSV4RRFFQ69G5FAX",
                    provider["id"],
                    "same-model",
                    1,
                    1,
                    "unknown",
                    "unknown",
                ),
            )
        duplicate_count = connection.execute(
            "SELECT count(*) FROM provider_models WHERE provider_id = ? AND model_id = ?",
            (provider["id"], "same-model"),
        ).fetchone()
    assert duplicate_count == (1,)


@pytest.mark.asyncio
async def test_simultaneous_registration_of_same_model_returns_one_conflict(tmp_path: Path) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        url = f"/api/providers/{provider['id']}/models"
        first, second = await asyncio.gather(
            client.post(url, json={"model_id": "shared"}),
            client.post(url, json={"model_id": "shared"}),
        )
        assert sorted((first.status_code, second.status_code)) == [201, 409]
        models = (await client.get(f"/api/providers/{provider['id']}")).json()["models"]
        assert [model["model_id"] for model in models] == ["shared"]


@pytest.mark.asyncio
async def test_delete_model_preserves_run_and_default_then_allows_new_identity(
    tmp_path: Path,
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        provider = await create_provider(client)
        url = f"/api/providers/{provider['id']}/models"
        model_response = await client.post(url, json={"model_id": "demo"})
        assert model_response.status_code == 201, model_response.text
        model = model_response.json()
        settings = (await client.get("/api/settings")).json()
        defaults = {
            "analysis_model_id": model["id"],
            "chat_model_id": None,
            "extraction_model_id": None,
            "style_id": settings["defaults"]["style_id"],
            "permission_mode": "review",
        }
        assert (await client.put("/api/settings/defaults", json=defaults)).status_code == 200
        run_response = await client.post(
            f"/api/provider-models/{model['id']}/verifications", json={"stream": False}
        )
        assert run_response.status_code == 202, run_response.text
        run_id = run_response.json()["id"]
        delete_url = f"/api/provider-models/{model['id']}"
        assert (await client.delete(delete_url)).status_code == 409

    # Reopening marks the accepted but unexecuted verification as interrupted.
    async with settings_client(tmp_path / "folio.db") as client:
        assert (await client.get(f"/api/runs/{run_id}")).json()["status"] == "interrupted"
        assert (await client.delete(delete_url)).status_code == 204
        assert (await client.delete(delete_url)).status_code == 404
        assert (await client.patch(delete_url, json={"enabled": True})).status_code == 404
        assert (await client.get("/api/settings")).json()["defaults"]["analysis_model_id"] == model[
            "id"
        ]
        assert (await client.get(f"/api/runs/{run_id}")).json()["model_id"] == "demo"
        replacement_response = await client.post(url, json={"model_id": "demo"})
        assert replacement_response.status_code == 201, replacement_response.text
        replacement = replacement_response.json()
        assert replacement["id"] != model["id"]
        assert replacement["text_status"] == "unknown"
        assert (await client.get("/api/settings")).json()["defaults"]["analysis_model_id"] == model[
            "id"
        ]


@pytest.mark.asyncio
async def test_validation_error_matches_openapi_without_echoing_input(tmp_path: Path) -> None:
    application = create_app()
    path = application.openapi()["paths"]["/api/providers"]["post"]
    error_schema = path["responses"]["422"]["content"]["application/json"]["schema"]
    schema_name = error_schema["$ref"].removeprefix("#/components/schemas/")
    declared_detail = application.openapi()["components"]["schemas"][schema_name]["properties"][
        "detail"
    ]
    expected_type = declared_detail["type"]
    assert expected_type in {"array", "string"}

    async with settings_client(tmp_path / "folio.db") as client:
        secret = "fictional_422_secret"
        response = await client.post(
            "/api/providers", json=provider_payload(api_key=secret, base_url="file:///bad")
        )
        assert response.status_code == 422
        assert isinstance(response.json()["detail"], list if expected_type == "array" else str)
        assert secret not in response.text


@pytest.mark.asyncio
async def test_accepted_run_keeps_credential_and_call_snapshot_after_edits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "folio.db"
    original_key = "fictional_old_key_789"
    observed: list[tuple[adapters.CallSnapshot, str | None]] = []

    async def generate(
        snapshot: adapters.CallSnapshot,
        api_key: str | None,
        progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        observed.append((snapshot, api_key))
        await progress(f"partial {original_key}")
        return adapters.GenerateResult(
            text=f"answer {original_key}",
            completed=True,
            usage={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
            raw_response=f'{{"echo":"{original_key}"}}',
        )

    monkeypatch.setattr(adapters, "generate_text", generate)
    async with settings_app_client(database) as (client, application):
        provider = await create_provider(
            client,
            name="原配置",
            base_url="http://localhost:8765/v1",
            api_key=original_key,
        )
        model_response = await client.post(
            f"/api/providers/{provider['id']}/models",
            json={"model_id": "old-model", "temperature": 0.4, "max_output_tokens": 64},
        )
        assert model_response.status_code == 201, model_response.text
        model = model_response.json()
        accepted = await client.post(
            f"/api/provider-models/{model['id']}/verifications", json={"stream": True}
        )
        assert accepted.status_code == 202, accepted.text
        run = accepted.json()
        assert run["status"] == "queued"
        assert run["provider_name"] == "原配置"
        assert run["protocol"] == "chat_completions"
        assert original_key not in accepted.text
        assert (await client.delete(f"/api/providers/{provider['id']}")).status_code == 409

        changed = await client.patch(
            f"/api/providers/{provider['id']}",
            json={
                "name": "新配置",
                "base_url": "http://localhost:9999/v1",
                "protocol": "responses",
                "api_key": "fictional_new_key_456",
                "enabled": False,
            },
        )
        assert changed.status_code == 200, changed.text
        assert (
            await client.post(
                f"/api/provider-models/{model['id']}/verifications", json={"stream": True}
            )
        ).status_code == 409
        assert (
            await client.patch(
                f"/api/provider-models/{model['id']}",
                json={"model_id": "new-model", "temperature": 0.8},
            )
        ).status_code == 422
        assert (
            await client.patch(f"/api/provider-models/{model['id']}", json={"temperature": 0.8})
        ).status_code == 200

        await settings_service.execute_verification(application, run["id"])
        assert len(observed) == 1
        snapshot, key = observed[0]
        assert key == original_key
        assert snapshot.base_url == "http://localhost:8765/v1"
        assert snapshot.model_id == "old-model"
        assert snapshot.protocol == "chat_completions"
        assert snapshot.temperature == 0.4
        assert snapshot.max_output_tokens == 64
        finished = await client.get(f"/api/runs/{run['id']}")
        assert finished.status_code == 200, finished.text
        assert finished.json()["status"] == "succeeded"
        assert finished.json()["usage"] == {
            "input_tokens": 3,
            "output_tokens": 2,
            "total_tokens": 5,
        }
        assert original_key not in finished.text
        assert "[已隐藏凭据]" in finished.json()["output_text"]
        current_provider = (await client.get(f"/api/providers/{provider['id']}")).json()
        assert current_provider["models"][0]["stream_status"] == "unknown"
        assert (await client.delete(f"/api/providers/{provider['id']}")).status_code == 204
        assert (await client.get(f"/api/runs/{run['id']}")).json()["status"] == "succeeded"
        listing = await client.get("/api/runs")
        assert listing.status_code == 200
        assert any(item["id"] == run["id"] for item in listing.json())
        assert original_key not in listing.text

    with sqlite3.connect(database) as connection:
        stored = connection.execute(
            "SELECT provider_name, model_id, credential_ref, output_text, raw_response "
            "FROM runs WHERE id = ?",
            (run["id"],),
        ).fetchone()
    assert stored is not None
    assert stored[0:2] == ("原配置", "old-model")
    assert stored[2] is not None and stored[2] != original_key
    assert original_key not in stored[3] and original_key not in stored[4]
    assert original_key not in database.read_bytes().decode("utf-8", errors="ignore")


@pytest.mark.asyncio
async def test_verification_failure_redacts_sdk_error_and_marks_current_capability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "fictional_error_key_123"

    async def fail_generation(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        raise RuntimeError(f"SDK request body echoed {secret}")

    monkeypatch.setattr(adapters, "generate_text", fail_generation)
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        provider = await create_provider(client, api_key=secret)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        accepted = await client.post(
            f"/api/provider-models/{model['id']}/verifications", json={"stream": False}
        )
        assert accepted.status_code == 202, accepted.text
        await settings_service.execute_verification(application, accepted.json()["id"])
        finished = await client.get(f"/api/runs/{accepted.json()['id']}")
        assert finished.json()["status"] == "failed"
        assert secret not in finished.text
        current = (await client.get(f"/api/providers/{provider['id']}")).json()
        assert current["models"][0]["text_status"] == "failed"
        assert current["models"][0]["stream_status"] == "unknown"
        assert current["models"][0]["text_verification"] == {
            "id": accepted.json()["id"],
            "status": "failed",
            "created_at": accepted.json()["created_at"],
            "finished_at": finished.json()["finished_at"],
            "error": "模型验证失败，请检查地址、凭据和模型参数",
        }
        assert secret not in json.dumps(current)


@pytest.mark.asyncio
async def test_model_verification_summary_tracks_current_revision_and_lifecycle(
    tmp_path: Path,
) -> None:
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        provider = await create_provider(client)
        provider_id = provider["id"]
        model = (
            await client.post(f"/api/providers/{provider_id}/models", json={"model_id": "demo"})
        ).json()
        model_id = model["id"]
        assert model["text_verification"] is None
        assert model["stream_verification"] is None

        accepted = (
            await client.post(
                f"/api/provider-models/{model_id}/verifications", json={"stream": False}
            )
        ).json()
        current = (await client.get(f"/api/providers/{provider_id}")).json()["models"][0]
        assert current["text_verification"]["id"] == accepted["id"]
        assert current["text_verification"]["status"] == "queued"
        assert current["text_verification"]["finished_at"] is None
        assert current["stream_verification"] is None

        async with application.state.session_factory() as session:
            run = await session.get(Run, accepted["id"])
            assert run is not None
            run.status = "running"
            await session.commit()
        current = (await client.get("/api/providers")).json()[0]["models"][0]
        assert current["text_verification"]["status"] == "running"

        async with application.state.session_factory() as session:
            run = await session.get(Run, accepted["id"])
            assert run is not None
            run.status = "succeeded"
            run.finished_at = settings_service.now()
            await session.commit()
        current = (await client.get(f"/api/providers/{provider_id}")).json()["models"][0]
        assert current["text_verification"]["status"] == "succeeded"
        assert current["text_verification"]["finished_at"] is not None

        patched = await client.patch(f"/api/provider-models/{model_id}", json={"temperature": 0.5})
        assert patched.json()["text_verification"] is None
        assert (await client.get(f"/api/providers/{provider_id}")).json()["models"][0][
            "text_verification"
        ] is None
        stream = (
            await client.post(
                f"/api/provider-models/{model_id}/verifications", json={"stream": True}
            )
        ).json()
        current = (await client.get(f"/api/providers/{provider_id}")).json()["models"][0]
        assert current["stream_verification"]["id"] == stream["id"]
        assert current["text_verification"] is None

        patched_provider = await client.patch(
            f"/api/providers/{provider_id}", json={"base_url": "http://localhost:9999/v1"}
        )
        assert patched_provider.json()["models"][0]["stream_verification"] is None


@pytest.mark.asyncio
async def test_verification_summary_separates_same_named_models_and_ignores_run_list_limit(
    tmp_path: Path,
) -> None:
    async with settings_client(tmp_path / "folio.db") as client:
        first = await create_provider(client, name="first")
        second = await create_provider(client, name="second")
        first_model = (
            await client.post(f"/api/providers/{first['id']}/models", json={"model_id": "shared"})
        ).json()
        second_model = (
            await client.post(f"/api/providers/{second['id']}/models", json={"model_id": "shared"})
        ).json()
        target = (
            await client.post(
                f"/api/provider-models/{first_model['id']}/verifications", json={"stream": False}
            )
        ).json()
        for _ in range(51):
            response = await client.post(
                f"/api/provider-models/{second_model['id']}/verifications",
                json={"stream": False},
            )
            assert response.status_code == 202, response.text
        assert target["id"] not in {run["id"] for run in (await client.get("/api/runs")).json()}
        first_page = (await client.get("/api/runs", params={"limit": 10, "offset": 0})).json()
        second_page = (await client.get("/api/runs", params={"limit": 10, "offset": 10})).json()
        last_page = (await client.get("/api/runs", params={"limit": 10, "offset": 50})).json()
        assert len(first_page) == len(second_page) == 10
        assert len(last_page) == 2
        assert len({run["id"] for run in first_page + second_page + last_page}) == 22
        assert target["id"] in {run["id"] for run in last_page}
        assert (await client.get("/api/runs", params={"limit": 51})).status_code == 422
        assert (await client.get("/api/runs", params={"offset": -1})).status_code == 422
        providers = (await client.get("/api/providers")).json()
        by_id = {provider["id"]: provider["models"][0] for provider in providers}
        assert by_id[first["id"]]["text_verification"]["id"] == target["id"]
        assert by_id[second["id"]]["text_verification"]["id"] != target["id"]


@pytest.mark.asyncio
async def test_older_completion_cannot_overwrite_newer_capability_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("older failed")
        return adapters.GenerateResult(text="ok", completed=True, usage=None, raw_response=None)

    monkeypatch.setattr(adapters, "generate_text", generate)
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        url = f"/api/provider-models/{model['id']}/verifications"
        older = (await client.post(url, json={"stream": False})).json()
        newer = (await client.post(url, json={"stream": False})).json()
        stream = (await client.post(url, json={"stream": True})).json()
        await settings_service.execute_verification(application, newer["id"])
        await settings_service.execute_verification(application, older["id"])
        await settings_service.execute_verification(application, stream["id"])
        current = (await client.get(f"/api/providers/{provider['id']}")).json()["models"][0]
        assert (await client.get(f"/api/runs/{older['id']}")).json()["status"] == "failed"
        assert current["text_status"] == "succeeded"
        assert current["text_verification"]["id"] == newer["id"]
        assert current["stream_status"] == "succeeded"
        assert current["stream_verification"]["id"] == stream["id"]


@pytest.mark.asyncio
async def test_restart_interrupts_queued_and_running_runs_without_replay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = False

    async def unexpected_generation(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal called
        called = True
        raise AssertionError("interrupted validation must not replay")

    monkeypatch.setattr(adapters, "generate_text", unexpected_generation)
    database = tmp_path / "folio.db"
    async with settings_app_client(database) as (client, application):
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        accepted = await client.post(
            f"/api/provider-models/{model['id']}/verifications", json={"stream": False}
        )
        assert accepted.status_code == 202, accepted.text
        queued_id = accepted.json()["id"]
        second = await client.post(
            f"/api/provider-models/{model['id']}/verifications", json={"stream": True}
        )
        assert second.status_code == 202, second.text
        running_id = second.json()["id"]
        async with application.state.session_factory() as session:
            row = await session.get(Run, running_id)
            assert row is not None
            row.status = "running"
            await session.commit()
    async with settings_client(database) as client:
        for run_id in (queued_id, running_id):
            interrupted = (await client.get(f"/api/runs/{run_id}")).json()
            assert interrupted["status"] == "interrupted"
            assert interrupted["finished_at"] is not None
        current = (await client.get(f"/api/providers/{provider['id']}")).json()["models"][0]
        assert current["text_verification"]["id"] == queued_id
        assert current["text_verification"]["status"] == "interrupted"
        assert current["stream_verification"]["id"] == running_id
        assert current["stream_verification"]["status"] == "interrupted"
        assert not called


@pytest.mark.asyncio
async def test_verification_limits_concurrent_calls_to_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    active = 0
    maximum = 0
    started_two = asyncio.Event()
    release = asyncio.Event()

    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        if active == 2:
            started_two.set()
        try:
            await release.wait()
            return adapters.GenerateResult(text="ok", completed=True, usage=None, raw_response=None)
        finally:
            active -= 1

    monkeypatch.setattr(adapters, "generate_text", generate)
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        runs: list[str] = []
        for _ in range(3):
            accepted = await client.post(
                f"/api/provider-models/{model['id']}/verifications", json={"stream": False}
            )
            assert accepted.status_code == 202, accepted.text
            runs.append(accepted.json()["id"])
        tasks = [
            asyncio.create_task(settings_service.execute_verification(application, run))
            for run in runs
        ]
        await asyncio.wait_for(started_two.wait(), timeout=2)
        assert maximum == 2
        assert active == 2
        release.set()
        await asyncio.gather(*tasks)
        assert maximum == 2
        for run in runs:
            assert (await client.get(f"/api/runs/{run}")).json()["status"] == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize("text,completed", [("", True), ("partial", False)])
async def test_empty_or_incomplete_output_is_failed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    text: str,
    completed: bool,
) -> None:
    async def generate(
        _snapshot: adapters.CallSnapshot,
        _key: str | None,
        _progress: Callable[[str], Awaitable[None]],
    ) -> adapters.GenerateResult:
        return adapters.GenerateResult(
            text=text, completed=completed, usage=None, raw_response=None
        )

    monkeypatch.setattr(adapters, "generate_text", generate)
    async with settings_app_client(tmp_path / "folio.db") as (client, application):
        provider = await create_provider(client)
        model = (
            await client.post(f"/api/providers/{provider['id']}/models", json={"model_id": "demo"})
        ).json()
        accepted = await client.post(
            f"/api/provider-models/{model['id']}/verifications", json={"stream": True}
        )
        assert accepted.status_code == 202, accepted.text
        await settings_service.execute_verification(application, accepted.json()["id"])
        result = (await client.get(f"/api/runs/{accepted.json()['id']}")).json()
        assert result["status"] == "failed"
        assert result["usage"] is None
        assert result["finished_at"] is not None
        current = (await client.get(f"/api/providers/{provider['id']}")).json()
        assert current["models"][0]["stream_status"] == "failed"
