"""ASGI entry point and optional built frontend hosting."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.api.health import router as health_router
from app.api.settings import router as settings_router
from app.api.sources import router as sources_router
from app.config import REPO_ROOT, load_settings
from app.db import create_engine
from app.services.settings import interrupt_unfinished


def create_app(frontend_dir: Path | None = None, database_path: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
        path = database_path if database_path is not None else load_settings().database.path
        engine = create_engine(path)
        application.state.session_factory = async_sessionmaker(engine, expire_on_commit=False)
        application.state.database_path = path
        application.state.verification_semaphore = asyncio.Semaphore(2)
        application.state.verification_tasks = set[asyncio.Task[None]]()
        async with application.state.session_factory() as session:
            await interrupt_unfinished(session)
        try:
            yield
        finally:
            for task in application.state.verification_tasks:
                task.cancel()
            if application.state.verification_tasks:
                await asyncio.gather(*application.state.verification_tasks, return_exceptions=True)
            await engine.dispose()

    application = FastAPI(
        title="Folio-J API",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    application.state.verification_worker_enabled = True

    @application.exception_handler(RequestValidationError)
    async def safe_validation_error(
        _request: Request, _exc: RequestValidationError
    ) -> JSONResponse:
        # Pydantic's default error payload includes raw input, including rejected credentials.
        return JSONResponse(
            status_code=422,
            content={
                "detail": [
                    {
                        "loc": ["body"],
                        "msg": "请求字段无效，请检查格式与长度",
                        "type": "value_error",
                    }
                ]
            },
        )

    application.include_router(health_router)
    application.include_router(sources_router)
    application.include_router(settings_router)
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
