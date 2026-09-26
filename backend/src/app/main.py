"""ASGI entry point and optional built frontend hosting."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from app.api.health import router as health_router
from app.config import REPO_ROOT


def create_app(frontend_dir: Path | None = None) -> FastAPI:
    application = FastAPI(
        title="Folio-J API",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
    )
    application.include_router(health_router)
    built_frontend = frontend_dir if frontend_dir is not None else REPO_ROOT / "frontend" / "dist"
    api_methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

    @application.api_route("/api", methods=api_methods, include_in_schema=False)
    @application.api_route("/api/{full_path:path}", methods=api_methods, include_in_schema=False)
    def unknown_api(full_path: str = "") -> None:
        raise HTTPException(status_code=404)

    @application.get("/{full_path:path}", include_in_schema=False)
    def serve_frontend(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        root = built_frontend.resolve()
        requested = (root / full_path).resolve()
        if not requested.is_relative_to(root):
            raise HTTPException(status_code=404)
        if requested.is_file():
            return FileResponse(requested)
        if full_path.startswith("assets/") or "." in Path(full_path).name:
            raise HTTPException(status_code=404)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(status_code=404)

    return application


app = create_app()
