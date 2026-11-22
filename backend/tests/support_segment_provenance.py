import hashlib
from typing import Any
from uuid import uuid4

from httpx import AsyncClient, Response
from support_api import seed_chat

from app.epub_schemas import ChapterPart, CompiledBook, CompiledChapter, CompiledResource

TEXTS = {"r1": "前か", "r2": "\u3099𠮷後", "r3": "別章"}


def compiled_provenance(_data: bytes) -> CompiledBook:
    resources = [
        CompiledResource(
            id=resource_id,
            href=f"{resource_id}.xhtml",
            title=resource_id,
            text=text,
            css="",
            html_attributes={},
            body_attributes={},
            text_sha256=hashlib.sha256(text.encode()).hexdigest(),
        )
        for resource_id, text in TEXTS.items()
    ]

    def part(resource_id: str, spine_index: int) -> ChapterPart:
        return ChapterPart(
            resource_id=resource_id,
            spine_index=spine_index,
            start=0,
            end=len(TEXTS[resource_id]),
            html=f"<p>{TEXTS[resource_id]}</p>",
            leaf_start=0,
            leaf_end=1,
        )

    return CompiledBook(
        contract="test-v1",
        title="引用検証",
        warnings=[],
        product_sha256="a" * 64,
        resources=[resources[0], resources[1], resources[0], resources[2]],
        chapters=[
            CompiledChapter(
                id="c1",
                title="同じ章",
                level=0,
                parts=[part("r1", 0), part("r2", 1), part("r1", 2)],
            ),
            CompiledChapter(id="c2", title="別章", level=0, parts=[part("r3", 3)]),
        ],
    )


async def setup_material(client: AsyncClient) -> tuple[str, dict[str, Any]]:
    source_response = await client.post("/api/sources", json={"title": "出典"})
    assert source_response.status_code == 201, source_response.text
    source_id: str = source_response.json()["id"]
    return source_id, await upload(client, source_id)


async def upload(client: AsyncClient, source_id: str) -> dict[str, Any]:
    result = await client.post(
        f"/api/sources/{source_id}/materials",
        content=b"immutable EPUB",
        headers={"content-type": "application/epub+zip"},
    )
    assert result.status_code == 200, result.text
    return result.json()["material"]


def span(resource_id: str, spine_index: int, start: int, end: int) -> dict[str, Any]:
    text = TEXTS[resource_id]
    return {
        "resource_id": resource_id,
        "spine_index": spine_index,
        "start": start,
        "end": end,
        "exact": text[start:end],
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
    }


def provenance(material: dict[str, Any], *ranges: dict[str, Any]) -> dict[str, Any]:
    return {
        "contract_version": "1",
        "material_id": material["id"],
        "version_id": material["version_id"],
        "ranges": list(ranges) or [span("r1", 0, 1, 2), span("r2", 1, 0, 2)],
    }


async def create_segment(
    client: AsyncClient,
    source_id: str,
    reference: dict[str, Any],
    **fields: Any,
) -> Response:
    return await client.post(
        f"/api/sources/{source_id}/segments",
        json={"request_id": str(uuid4()), "material_provenance": reference, **fields},
    )


async def material_chat(client: AsyncClient) -> dict[str, Any]:
    seed = await seed_chat(client)
    material = await upload(client, seed["source"]["id"])
    created = await create_segment(
        client,
        seed["source"]["id"],
        provenance(material),
        source_ref="用户填写的出处补充",
        note="不提供给模型的片段管理备注",
    )
    assert created.status_code == 201, created.text
    segment = created.json()
    response = await client.post(
        f"/api/segments/{segment['id']}/threads", json={"request_id": str(uuid4())}
    )
    assert response.status_code == 201, response.text
    return {**seed, "segment": segment, "thread": response.json(), "material": material}
