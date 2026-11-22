import base64
import io
import zipfile

from httpx import AsyncClient

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def cover_book(
    *,
    href: str = "cover.png",
    data: bytes = PNG,
    media_type: str = "image/png",
    epub2: bool = False,
    extra: dict[str, bytes] | None = None,
) -> bytes:
    memory = io.BytesIO()
    metadata = '<meta name="cover" content="cover" />' if epub2 else ""
    properties = "" if epub2 else ' properties="cover-image"'
    package = (
        f"<package><metadata>{metadata}</metadata><manifest>"
        f'<item id="cover" href="{href}" media-type="{media_type}"{properties}/>'
        "</manifest></package>"
    )
    files = {
        "META-INF/container.xml": (
            b'<container><rootfiles><rootfile full-path="book/package.opf"/>'
            b"</rootfiles></container>"
        ),
        "book/package.opf": package.encode(),
        "book/cover.png": data,
        **(extra or {}),
    }
    with zipfile.ZipFile(memory, "w") as archive:
        for path, value in files.items():
            archive.writestr(path, value)
    return memory.getvalue()


def jpeg_fixture() -> bytes:
    """Original synthetic baseline JPEG marker stream, with one bounded scan."""
    return bytes.fromhex(
        "ffd8ffc00011080001000103011100021100031100ffda000c03010002000300003f001122ffd9"
    )


async def import_book(client: AsyncClient, raw: bytes = b"book") -> tuple[str, str]:
    source = (await client.post("/api/sources", json={"title": "来源"})).json()["id"]
    response = await client.post(
        f"/api/sources/{source}/materials",
        content=raw,
        headers={"content-type": "application/epub+zip"},
    )
    assert response.status_code == 200
    return source, "/api/materials/" + response.json()["material"]["id"]


def cover_input(image: bytes = PNG, media_type: str = "image/png") -> dict[str, str]:
    return {"media_type": media_type, "data_base64": base64.b64encode(image).decode()}
