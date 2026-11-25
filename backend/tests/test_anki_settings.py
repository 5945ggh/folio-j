"""Offline CRUD, secret scoping and failed writes with an isolated SQLite database."""

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from support_api import api_client

from app.anki_settings_schemas import AnkiConfigurationInput, AnkiConnectionInput
from app.db import create_engine
from app.services import anki_settings
from app.services.settings import credential_dir, read_credential, save_credential

CONNECTION = "/api/settings/anki/connection"
CONFIGURATIONS = "/api/settings/anki/configurations"
LOOPBACK = "http://127.0.0.1:8765"
ALTERNATE = "http://127.0.0.1:9876"


@pytest.mark.asyncio
async def test_connection_secret_stays_private_and_follows_exact_saved_address(
    tmp_path: Path,
) -> None:
    database = tmp_path / "anki.db"
    provider_ref = save_credential(database, "fictional-provider-key")
    async with api_client(database) as client:
        assert (await client.get(CONNECTION)).json() == {
            "url": LOOPBACK,
            "has_api_key": False,
            "revision": 0,
        }
        saved = await client.put(
            CONNECTION, json={"url": LOOPBACK, "api_key": "fictional-anki-key"}
        )
        assert saved.status_code == 200, saved.text
        assert saved.json() == {"url": LOOPBACK, "has_api_key": True, "revision": 1}
        assert "fictional-anki-key" not in saved.text
        assert (await client.put(CONNECTION, json={"url": LOOPBACK + "/"})).json() == saved.json()
        invalid = await client.put(
            CONNECTION, json={"url": LOOPBACK, "api_key": "fictional-anki\nkey", "extra": True}
        )
        assert invalid.status_code == 422
        assert "fictional-anki" not in invalid.text

    engine = create_engine(database)
    factory = async_sessionmaker(engine)
    try:
        async with factory() as session:
            saved_target = await anki_settings.resolve_connection_target(session, database)
            assert (saved_target.url, saved_target.api_key) == (LOOPBACK, "fictional-anki-key")
            assert "fictional-anki-key" not in repr(saved_target)
            for edits, key in (
                ({"url": ALTERNATE}, None),
                ({"url": ALTERNATE, "api_key": "fictional-probe-only"}, "fictional-probe-only"),
                ({"url": LOOPBACK, "api_key": None}, None),
                ({"url": LOOPBACK, "api_key": " "}, None),
                ({"url": LOOPBACK}, "fictional-anki-key"),
            ):
                current = await anki_settings.resolve_connection_target(
                    session, database, AnkiConnectionInput.model_validate(edits)
                )
                assert current.url == edits["url"]
                assert current.api_key == key
            assert (
                await anki_settings.resolve_connection_target(session, database)
            ) == saved_target
    finally:
        await engine.dispose()

    async with api_client(database) as client:
        assert (await client.get(CONNECTION)).json() == saved.json()
        switched = await client.put(CONNECTION, json={"url": ALTERNATE})
        assert switched.json() == {"url": ALTERNATE, "has_api_key": False, "revision": 2}
        await client.put(CONNECTION, json={"url": ALTERNATE, "api_key": "fictional-next-key"})
        cleared = await client.put(CONNECTION, json={"url": ALTERNATE, "api_key": None})
        assert cleared.json() == {"url": ALTERNATE, "has_api_key": False, "revision": 4}
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT * FROM anki_connection_settings").fetchall() == [
            (1, ALTERNATE, None, 4)
        ]
        assert "fictional-anki-key" not in "\n".join(connection.iterdump())
    assert read_credential(database, provider_ref) == "fictional-provider-key"


@pytest.mark.asyncio
async def test_concurrent_connection_writes_keep_key_with_its_endpoint(tmp_path: Path) -> None:
    database = tmp_path / "concurrent.db"
    async with api_client(database) as client:
        keyed, moved = await asyncio.gather(
            client.put(CONNECTION, json={"url": LOOPBACK, "api_key": "fictional-anki-key"}),
            client.put(CONNECTION, json={"url": ALTERNATE}),
        )
        assert keyed.status_code == moved.status_code == 200
        assert keyed.json()["has_api_key"] is True
        assert moved.json()["has_api_key"] is False
        latest = max((keyed.json(), moved.json()), key=lambda response: int(response["revision"]))
        assert (await client.get(CONNECTION)).json() == latest
    engine = create_engine(database)
    try:
        async with AsyncSession(engine) as session:
            target = await anki_settings.resolve_connection_target(session, database)
            assert target.url == latest["url"]
            assert target.api_key == ("fictional-anki-key" if target.url == LOOPBACK else None)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_failed_write_keeps_saved_secret_and_rolls_back_new_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "failed.db"
    async with api_client(database) as client:
        saved = await client.put(CONNECTION, json={"url": LOOPBACK, "api_key": "fictional-saved"})
        assert saved.status_code == 200
    directory = credential_dir(database)
    before = set(directory.iterdir())

    async def fail_flush(*_args: object, **_kwargs: object) -> None:
        raise OSError("synthetic SQLite write failure")

    engine = create_engine(database)
    factory = async_sessionmaker(engine)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(AsyncSession, "flush", fail_flush)
            async with factory() as session:
                with pytest.raises(OSError, match="synthetic SQLite write failure"):
                    await anki_settings.save_connection_settings(
                        session,
                        database,
                        AnkiConnectionInput.model_validate(
                            {"url": ALTERNATE, "api_key": "fictional-unsaved"}
                        ),
                    )
        assert set(directory.iterdir()) == before
        async with factory() as session:
            target = await anki_settings.resolve_connection_target(session, database)
            assert (target.url, target.api_key, target.revision) == (LOOPBACK, "fictional-saved", 1)
        (reference,) = before
        reference.unlink()
        async with factory() as session:
            with pytest.raises(HTTPException, match="无法读取 Anki API 密钥") as error:
                await anki_settings.resolve_connection_target(session, database)
            assert error.value.status_code == 503
    finally:
        await engine.dispose()


@pytest.mark.parametrize(
    "url",
    [
        "file:///tmp/anki",
        "http://user:secret@localhost",
        "http://localhost?",
        "http://localhost#",
        "http://localhost:70000",
        "http://localhost:a",
        "http://localhost:\\@other",
        "http://[::1]other:8765",
        "http://[v1.fe80]",
        "http://☃.test",
        "http://xn--n3h.test",
        "http://@localhost",
        "http://local^host",
        "http://%31%32%37.0.0.1:8765",
        "http://localhost\n:8765",
    ],
)
def test_invalid_connection_urls_are_rejected(url: str) -> None:
    with pytest.raises(ValidationError):
        AnkiConnectionInput(url=url)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (" HTTP://[::1]:8765/ ", "http://[::1]:8765"),
        ("https://中国.test:443/anki/", "https://xn--fiqs8s.test/anki"),
        ("http://EXAMPLE.test:8765/old/../新/", "http://example.test:8765/%E6%96%B0"),
    ],
)
def test_connection_scope_uses_the_http_transport_url(value: str, expected: str) -> None:
    parsed = AnkiConnectionInput(url=value)
    assert parsed.url == expected
    assert AnkiConnectionInput(url=parsed.url).url == expected


@pytest.mark.asyncio
async def test_invalid_transport_urls_cannot_be_saved_or_probed(tmp_path: Path) -> None:
    database = tmp_path / "bad-transport.db"
    async with api_client(database) as client:
        for url in ("http://☃.test", "http://[v1.fe80]", "http://xn--n3h.test"):
            data = {"url": url, "api_key": "fictional-unsaved"}
            assert (await client.put(CONNECTION, json=data)).status_code == 422
            assert (await client.post("/api/anki/probe", json=data)).status_code == 422
        assert not credential_dir(database).exists()

        # A database returned from an earlier development build can still open settings.
        with sqlite3.connect(database) as connection:
            connection.execute(
                "INSERT INTO anki_connection_settings VALUES (1, ?, NULL, 1)", ("http://☃.test",)
            )
        saved = await client.post("/api/anki/probe")
        assert saved.status_code == 422
        assert saved.json()["detail"] == "已保存的 AnkiConnect 地址无效，请重新填写"
        assert (await client.get(CONNECTION)).json()["url"] == "http://☃.test"
        assert (await client.put(CONNECTION, json={"url": LOOPBACK})).status_code == 200


def field(field_id: str, label: str, target: str | None = None, **edits: Any) -> dict[str, Any]:
    return {"id": field_id, "label": label, "type": "text", "target_field": target, **edits}


@pytest.mark.asyncio
async def test_personal_configs_can_be_saved_offline_and_preserve_ids_and_order(
    tmp_path: Path,
) -> None:
    database = tmp_path / "profiles.db"
    fields = [
        field("selection", "词条", "Word", source="selection", required=True),
        field("meaning", "说明", multiline=True, presentation="summary"),
        field("photo", "图片", "Image", type="image", presentation="more"),
    ]
    async with api_client(database) as client:
        assert (await client.get(CONFIGURATIONS)).json() == []
        creation = await client.post(CONFIGURATIONS, json={"name": "未完成", "fields": fields})
        assert creation.status_code == 201, creation.text
        created = creation.json()
        assert created["deck"] is None and created["note_type"] is None
        assert [item["id"] for item in created["fields"]] == ["selection", "meaning", "photo"]
        path = f"{CONFIGURATIONS}/{created['id']}"
        scope = {"url": LOOPBACK, "profile": "独立测试集合"}
        payload = {
            "name": "修订版",
            "deck": {"name": "日语::阅读", "id": "9007199254740993", "scope": scope},
            "note_type": {"kind": "external", "name": "个人笔记", "id": "12", "scope": scope},
            "fields": [fields[2], fields[0], {**fields[1], "label": "本句义"}],
        }
        saved = await client.put(path, json=payload)
        assert saved.status_code == 200, saved.text
        assert saved.json()["fields"][2]["id"] == "meaning"
        assert saved.json()["fields"][2]["label"] == "本句义"
        assert saved.json()["deck"] == payload["deck"]
        assert saved.json()["note_type"] == payload["note_type"]
        invalid = await client.put(path, json={**payload, "draft": "rejected-draft-body"})
        assert invalid.status_code == 422
        assert "rejected-draft-body" not in invalid.text
    async with api_client(database) as client:
        assert (await client.get(path)).json() == saved.json()
        assert (await client.get(CONFIGURATIONS)).json() == [saved.json()]
        missing_preset = await client.delete(f"{CONFIGURATIONS}/export.vocabulary")
        assert missing_preset.status_code == 404
        assert (await client.delete(path)).status_code == 204
        assert (await client.get(path)).status_code == 404
        assert (await client.get(CONFIGURATIONS)).json() == []


@pytest.mark.parametrize(
    "fields",
    [
        [field("a", "词条"), field("a", "例句")],
        [field("a", "Word"), field("b", " word ")],
        [field("a", "词条", "Word"), field("b", "例句", "Word")],
        [field("a", "必填", required=True)],
        [field("a", "空映射", "  ")],
        [field("a", "空白\n名称")],
        [field("a", "媒体", type="audio", source="selection")],
        [field("a", "媒体", type="video", multiline=True)],
        [field("a", "媒体", type="image", file="rejected-file")],
        [field("a", "词条", value="rejected-draft-body")],
        [field("a", "词条", required="false")],
    ],
)
def test_config_rejects_ambiguous_fields_and_draft_content(fields: list[dict[str, Any]]) -> None:
    with pytest.raises(ValidationError):
        AnkiConfigurationInput.model_validate({"name": "配置", "fields": fields})
