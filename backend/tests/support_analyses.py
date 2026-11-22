from typing import Any
from uuid import uuid4

from httpx import AsyncClient


async def seed_segment(client: AsyncClient) -> tuple[str, dict[str, Any]]:
    source = (await client.post("/api/sources", json={"title": "手动资料"})).json()["id"]
    segment = (
        await client.post(f"/api/sources/{source}/segments", json={"text": "日本語を学ぶ。"})
    ).json()
    return source, segment


def create_payload(segment: dict[str, Any], source_md: str = "## 文法\n\n説明\n") -> dict[str, Any]:
    return {
        "request_id": str(uuid4()),
        "expected_text_sha256": segment["text_sha256"],
        "source_md": source_md,
    }


def revision_payload(
    segment: dict[str, Any], document: dict[str, Any], source_md: str
) -> dict[str, Any]:
    return {**create_payload(segment, source_md), "base_revision_id": document["revision_id"]}
