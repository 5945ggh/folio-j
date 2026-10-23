"""Offline catalog pagination, explicit usage and deleted-source gates."""

from pathlib import Path

import pytest
from test_materials import compiled
from test_source_segment import api_client


@pytest.mark.asyncio
async def test_catalog_usage_and_visibility(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "catalog.db") as client:
        source = (await client.post("/api/sources", json={"title": "本棚"})).json()["id"]
        for i in range(53):
            result = await client.post(
                f"/api/sources/{source}/materials",
                content=f"book{i}".encode(),
                headers={"content-type": "application/epub+zip"},
            )
            assert result.status_code == 200
        first = (await client.get("/api/materials", params={"page_size": 50})).json()
        assert first["total"] == 53 and len(first["items"]) == 50
        second = (await client.get("/api/materials", params={"page": 2})).json()
        assert len(second["items"]) == 3
        assert not {i["id"] for i in first["items"]} & {i["id"] for i in second["items"]}
        url = "/api/materials/" + first["items"][0]["id"]
        assert (await client.get(url)).status_code == 200
        assert (await client.get(url + "/usage")).json()["revision"] == 0
        opened = await client.post(
            url + "/opened", json={"action_id": "session-a", "expected_revision": 0}
        )
        assert opened.status_code == 200 and opened.json()["status"] == "in_progress"
        completed = await client.put(
            url + "/usage", json={"status": "completed", "expected_revision": 1}
        )
        assert completed.status_code == 200
        repeat = await client.post(
            url + "/opened", json={"action_id": "session-a", "expected_revision": 0}
        )
        assert repeat.status_code == 200 and repeat.json()["status"] == "completed"
        assert (
            await client.post(url + "/opened", json={"action_id": "late", "expected_revision": 0})
        ).status_code == 409
        reread = await client.post(
            url + "/opened", json={"action_id": "session-b", "expected_revision": 2}
        )
        assert reread.json()["status"] == "completed"
        assert (
            await client.post(
                url + "/opened", json={"action_id": "session-a", "expected_revision": 0}
            )
        ).status_code == 409
        assert (await client.get("/api/materials", params={"q": "%"})).json()["total"] == 0
        assert (await client.get("/api/catalog/sources")).json()["items"][0]["material_count"] == 53
        assert (await client.delete("/api/sources/" + source)).status_code == 204
        assert (await client.get("/api/materials")).json()["total"] == 0
        for path in ("/usage", "/cover"):
            assert (await client.get(url + path)).status_code == 404
        assert (
            await client.post(url + "/opened", json={"action_id": "new", "expected_revision": 3})
        ).status_code == 404


@pytest.mark.asyncio
async def test_usage_parallel_open_and_manual_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    async with api_client(tmp_path / "race.db") as client:
        source = (await client.post("/api/sources", json={"title": "竞争"})).json()["id"]
        item = (
            await client.post(
                f"/api/sources/{source}/materials",
                content=b"book",
                headers={"content-type": "application/epub+zip"},
            )
        ).json()["material"]
        url = "/api/materials/" + item["id"]
        responses = await asyncio.gather(
            *[
                client.post(url + "/opened", json={"action_id": "same", "expected_revision": 0})
                for _ in range(4)
            ]
        )
        assert all(r.status_code == 200 for r in responses)
        assert (await client.get(url + "/usage")).json()["revision"] == 1
        race = await asyncio.gather(
            client.post(url + "/opened", json={"action_id": "next", "expected_revision": 1}),
            client.put(url + "/usage", json={"status": "completed", "expected_revision": 1}),
        )
        assert sorted(r.status_code for r in race) == [200, 409]
        usage = (await client.get(url + "/usage")).json()
        completed = await client.put(
            url + "/usage", json={"status": "completed", "expected_revision": usage["revision"]}
        )
        assert completed.status_code == 200
        assert (
            await client.post(url + "/opened", json={"action_id": "late", "expected_revision": 1})
        ).status_code == 409
        assert (await client.get(url + "/usage")).json()["status"] == "completed"


@pytest.mark.asyncio
async def test_catalog_sort_filters_and_aggregates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, datetime

    from sqlalchemy import update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.analysis_models import Analysis
    from app.db import create_engine
    from app.ids import new_ulid
    from app.material_models import Material, MaterialUsage

    monkeypatch.setattr("app.services.materials.compile_epub_bytes", compiled)
    database = tmp_path / "sort.db"
    async with api_client(database) as client:
        source = (await client.post("/api/sources", json={"title": "検索 Source"})).json()["id"]
        other = (await client.post("/api/sources", json={"title": "別"})).json()["id"]
        titles = ["日文", "中文", "a", "A", "Book 2", "Book 10", "%_literal"]
        ids: list[str] = []
        for i, _title in enumerate(titles):
            result = await client.post(
                f"/api/sources/{source}/materials",
                content=str(i).encode(),
                headers={"content-type": "application/epub+zip"},
            )
            ids.append(result.json()["material"]["id"])
        engine = create_engine(database)
        try:
            async with async_sessionmaker(engine)() as session:
                for mid, title in zip(ids, titles, strict=True):
                    await session.execute(
                        update(Material).where(Material.id == mid).values(title=title)
                    )
                await session.commit()
            asc = (await client.get("/api/materials")).json()
            assert [m["title"] for m in asc["items"]] == sorted(titles)
            desc = (await client.get("/api/materials", params={"order": "desc"})).json()
            assert [m["title"] for m in desc["items"]] == sorted(titles, reverse=True)
            assert (await client.get("/api/materials", params={"q": "%_"})).json()["total"] == 1
            assert (
                await client.get(
                    "/api/materials",
                    params={"q": "検索", "source_id": source, "status": "not_started"},
                )
            ).json()["total"] == 7
            assert (await client.get("/api/materials", params={"source_id": other})).json()[
                "total"
            ] == 0
            await client.post(
                f"/api/materials/{ids[2]}/opened", json={"action_id": "a", "expected_revision": 0}
            )
            await client.post(
                f"/api/materials/{ids[0]}/opened", json={"action_id": "b", "expected_revision": 0}
            )
            await client.post(
                f"/api/materials/{ids[1]}/opened", json={"action_id": "c", "expected_revision": 0}
            )
            async with async_sessionmaker(engine)() as session:
                for mid, opened_at in (
                    (ids[2], datetime(2020, 1, 2, tzinfo=UTC)),
                    (ids[0], datetime(2020, 1, 1, tzinfo=UTC)),
                    (ids[1], datetime(2020, 1, 1, tzinfo=UTC)),
                ):
                    await session.execute(
                        update(MaterialUsage)
                        .where(MaterialUsage.material_id == mid)
                        .values(last_opened_at=opened_at)
                    )
                await session.commit()
            tied = sorted(ids[:2])
            for order, expected in (
                ("asc", [*tied, ids[2]]),
                ("desc", [ids[2], *tied]),
            ):
                recent = (
                    await client.get(
                        "/api/materials", params={"sort": "last_opened_at", "order": order}
                    )
                ).json()["items"]
                assert [m["id"] for m in recent] == [*expected, *sorted(ids[3:])]
                assert all(m["last_opened_at"] is not None for m in recent[:3])
                assert all(m["last_opened_at"] is None for m in recent[3:])
            segment = (
                await client.post(
                    f"/api/sources/{source}/segments",
                    json={"text": "原文合成", "source_ref": "検索出典"},
                )
            ).json()["id"]
            now = datetime.now(UTC)
            aid, rid = new_ulid(), new_ulid()
            async with async_sessionmaker(engine)() as session:
                session.add(
                    Analysis(
                        id=aid,
                        segment_id=segment,
                        operation_key="fixture",
                        title="講解",
                        excerpt="正文摘录",
                        current_revision_id=rid,
                        created_at=now,
                        updated_at=now,
                    )
                )
                await session.commit()
            analysis = (
                await client.get(f"/api/sources/{source}/catalog/analyses", params={"q": "正文"})
            ).json()
            assert analysis["total"] == 1
            assert analysis["items"][0]["current_revision_id"] == rid
            assert analysis["items"][0]["segment_id"] == segment
            assert analysis["items"][0]["segment_excerpt"] == "原文合成"
            segment_page = (
                await client.get(f"/api/sources/{source}/catalog/segments", params={"q": "出典"})
            ).json()
            assert segment_page["total"] == 1
            counts = (await client.get("/api/catalog/sources", params={"q": "検索"})).json()[
                "items"
            ][0]
            assert (
                counts["material_count"],
                counts["segment_count"],
                counts["analysis_count"],
            ) == (7, 1, 1)
            assert (await client.delete("/api/segments/" + segment)).status_code == 204
            assert (await client.get(f"/api/sources/{source}/catalog/analyses")).json()[
                "total"
            ] == 0
            assert (await client.get("/api/catalog/sources", params={"q": "検索"})).json()["items"][
                0
            ]["analysis_count"] == 0
            for params in [
                {"page": 0},
                {"page_size": 101},
                {"sort": "bogus"},
                {"type": "video"},
                {"status": "read"},
            ]:
                assert (await client.get("/api/materials", params=params)).status_code == 422
        finally:
            await engine.dispose()
