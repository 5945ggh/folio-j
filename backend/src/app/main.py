"""ASGI entry point and optional built frontend hosting."""

import asyncio
import fcntl
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.api.analyses import router as analyses_router
from app.api.health import router as health_router
from app.api.materials import router as materials_router
from app.api.settings import router as settings_router
from app.api.sources import router as sources_router
from app.config import REPO_ROOT, load_settings
from app.db import create_engine
from app.jobs.runtime import recover_chat_jobs, start_chat_worker
from app.jobs.supervision import BackgroundWorker, workers
from app.services import translations
from app.services.analyses import AnalysisWriteError
from app.services.chat import ChatError
from app.services.settings import interrupt_unfinished
from app.services.statistics_runtime import StatisticsRuntime


def create_app(frontend_dir: Path | None = None, database_path: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
        path = (
            database_path if database_path is not None else load_settings().database.path
        ).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.with_name(path.name + ".worker.lock")
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(lock_fd)
            raise RuntimeError(f"数据库已有后台执行进程：{path}") from exc
        engine = create_engine(path)
        application.state.session_factory = async_sessionmaker(engine, expire_on_commit=False)
        statistics_runtime = StatisticsRuntime()
        application.state.statistics_runtime = statistics_runtime
        application.state.database_path = path
        application.state.verification_semaphore = asyncio.Semaphore(2)
        application.state.chat_dispatch_lock = asyncio.Lock()
        application.state.translation_semaphore = asyncio.Semaphore(1)
        background = workers(application)
        for name, executor in background.items():
            executor.activate(
                enabled=(
                    application.state.verification_worker_enabled
                    if name == "verification"
                    else application.state.chat_worker_enabled
                )
            )
        try:
            async with application.state.session_factory() as session:
                await recover_chat_jobs(session)
                await interrupt_unfinished(session)
                await translations.recover(session)
            if application.state.chat_worker_enabled:
                start_chat_worker(application)
                translations.start_worker(application)
            yield
        finally:
            await asyncio.gather(*(executor.close() for executor in background.values()))
            try:
                await statistics_runtime.close()
            finally:
                await engine.dispose()
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)

    application = FastAPI(
        title="Folio-J API",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    application.state.verification_worker_enabled = True
    application.state.chat_worker_enabled = True
    application.state.background_workers = {
        "chat": BackgroundWorker("chat"),
        "translation": BackgroundWorker("translation"),
        "verification": BackgroundWorker("verification"),
    }

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

    @application.exception_handler(ChatError)
    async def chat_error(_request: Request, exc: ChatError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code},
        )

    @application.exception_handler(AnalysisWriteError)
    async def analysis_write_error(_request: Request, exc: AnalysisWriteError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail, "code": exc.code},
        )

    application.include_router(health_router)
    from app.api.catalog import router as catalog_router

    application.include_router(catalog_router)
    application.include_router(materials_router)
    application.include_router(analyses_router)
    application.include_router(sources_router)
    application.include_router(settings_router)
    from app.api.translations import router as translations_router

    application.include_router(translations_router)
    from app.api.chat import router as chat_router

    application.include_router(chat_router)
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
