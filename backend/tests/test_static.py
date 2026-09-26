from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest.mark.asyncio
async def test_spa_fallback_and_404_boundaries(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<main>App</main>", encoding="utf-8")
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("console.log('ready')", encoding="utf-8")

    async with AsyncClient(
        transport=ASGITransport(app=create_app(frontend_dir=tmp_path)), base_url="http://test"
    ) as client:
        assert (await client.get("/")).text == "<main>App</main>"
        assert (await client.get("/segments/example")).text == "<main>App</main>"
        assert (await client.get("/assets/app.js")).text == "console.log('ready')"
        assert (await client.get("/assets/missing.js")).status_code == 404
        assert (await client.get("/assets/missing")).status_code == 404
        assert (await client.get("/api/unknown")).status_code == 404
        assert (await client.post("/api/unknown")).status_code == 404
        assert (await client.get("/api")).status_code == 404


@pytest.mark.asyncio
async def test_missing_frontend_is_404(tmp_path: Path) -> None:
    async with AsyncClient(
        transport=ASGITransport(app=create_app(frontend_dir=tmp_path)), base_url="http://test"
    ) as client:
        assert (await client.get("/")).status_code == 404
