"""Exercise the reader's public HTTP contract without contacting a real collection."""

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from support_settings import settings_app_client

from app.api import anki as routes


@pytest.mark.asyncio
async def test_catalog_mapping_export_and_connection_scope(tmp_path: Path) -> None:
    calls: list[str] = []
    remote_model = {
        "id": "17",
        "name": "Recognition",
        "kind": "normal",
        "fields": [{"name": "Front"}, {"name": "Back"}],
        "templates": [{"name": "Read", "questionHtml": "{{Front}}", "answerHtml": "{{Back}}"}],
        "css": "",
    }

    def reply(request: httpx.Request) -> httpx.Response:
        data: dict[str, Any] = json.loads(request.content)
        method = data["method"]
        calls.append(method)
        if request.url.host == "edited.example":
            assert "authorization" not in request.headers
            return httpx.Response(401, text="sensitive upstream diagnostic")
        assert request.headers["authorization"] == "Bearer testing-secret"
        if method == "notes.create":
            assert data["params"]["fields"] == {"Front": "灰汁", "Back": "浮沫 &lt;释义&gt;"}
        results: dict[str, object] = {
            "collection.get": {"profile": "Reading", "session": "session-a"},
            "api.describe": {
                "apiMajor": 1,
                "methods": [
                    {"name": method, "available": True, "reason": None}
                    for method in (
                        "collection.get",
                        "decks.list",
                        "noteTypes.list",
                        "noteTypes.get",
                        "notes.validate",
                        "notes.create",
                    )
                ],
            },
            "decks.list": [{"id": "1", "name": "My Deck", "kind": "normal"}],
            "noteTypes.list": [remote_model],
            "noteTypes.get": remote_model,
            "notes.validate": {"valid": True, "issues": []},
            "notes.create": {"noteId": "81", "cardIds": ["82"]},
        }
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": data["id"], "result": results[method]}
        )

    async def transport() -> AsyncIterator[httpx.AsyncClient]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(reply)) as client:
            yield client

    database = tmp_path / "fixture.db"
    async with settings_app_client(database) as (client, application):
        application.dependency_overrides[routes.anki_http_client] = transport
        bundle = (await client.get("/api/anki/builtins")).json()
        assert [p["name"] for p in bundle["export_presets"]] == ["词义回忆", "例句理解"]
        assert not calls
        saved_url = "http://saved.example:8765"
        target = {"endpoint": saved_url, "profile": "Reading"}
        response = await client.put(
            "/api/settings/anki/connection", json={"url": saved_url, "api_key": "testing-secret"}
        )
        assert response.status_code == 200
        check = await client.post("/api/anki/probe", json={"url": "http://edited.example"})
        assert check.status_code == 403
        assert check.json()["code"] == "authentication" and "sensitive" not in check.text
        assert (await client.post("/api/anki/probe")).json() == {**target, "protocol": "v1"}
        catalog = (await client.get("/api/anki/catalog")).json()
        assert catalog["decks"] == [{"id": "1", "name": "My Deck"}]
        assert catalog["note_types"] == [{"id": "17", "name": "Recognition"}]
        fields = await client.post(
            "/api/anki/note-type-fields", json={**target, "note_type_id": "17"}
        )
        assert fields.json()["fields"] == ["Front", "Back"]
        assert fields.json()["card_templates"] == ["Read"]
        before = len(calls)
        guard = await client.post(
            "/api/anki/note-type-fields",
            json={**target, "endpoint": "http://old", "note_type_id": "17"},
        )
        assert guard.status_code == 409 and len(calls) == before
        result = await client.post(
            "/api/anki/export",
            json={
                **target,
                "deck": "My Deck",
                "deck_id": "1",
                "note_type": "Recognition",
                "note_type_id": "17",
                "fields": [
                    {"id": "word", "type": "text", "target_field": "Front", "value": "灰汁"},
                    {
                        "id": "meaning",
                        "type": "text",
                        "target_field": "Back",
                        "value": "浮沫 <释义>",
                    },
                ],
            },
        )
        assert result.status_code == 200 and result.json()["status"] == "created", result.text
        assert result.json()["card_ids"] == ["82"] and calls.count("notes.create") == 1
    assert "浮沫".encode() not in database.read_bytes()


@pytest.mark.asyncio
async def test_chunked_oversize_export_is_rejected_before_json_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(routes, "MAX_EXPORT_REQUEST_BYTES", 100)

    async def chunks() -> AsyncIterator[bytes]:
        yield b'{"secret":"'
        yield b"private-draft" * 12

    async with settings_app_client(tmp_path / "bounded.db") as (client, _):
        result = await client.post(
            "/api/anki/export", content=chunks(), headers={"Content-Type": "application/json"}
        )
        assert result.status_code == 413 and "private-draft" not in result.text
