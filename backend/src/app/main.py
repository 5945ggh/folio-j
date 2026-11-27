"""ASGI entry point and optional built frontend hosting."""

import asyncio
from collections.abc import AsyncGenerator
from contextlib import AsyncExitStack, ExitStack, asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.api.analyses import router as analyses_router
from app.api.anki import router as anki_router
from app.api.anki_settings import router as anki_settings_router
from app.api.bookmarks import router as bookmarks_router
from app.api.dictionary import router as dictionary_router
from app.api.health import router as health_router
from app.api.materials import router as materials_router
from app.api.settings import router as settings_router
from app.api.sources import router as sources_router
from app.config import load_settings
from app.db import create_engine
from app.jobs.runtime import recover_chat_jobs, start_chat_worker
from app.jobs.supervision import BackgroundWorker, workers
from app.platform_io import FileLockError, exclusive_file_lock, make_private_directory
from app.resources import RESOURCE_ROOT
from app.services import translations
from app.services.analyses import AnalysisWriteError
from app.services.anki_connect import AnkiConnectError, connection_error_message
from app.services.chat import ChatError
from app.services.dictionary_store import DictionaryStore
from app.services.reader_views import ReaderViews
from app.services.settings import interrupt_unfinished
from app.services.startup import ApplicationStartupError
from app.services.statistics_runtime import StatisticsRuntime


def _open_worker_database(
    database_path: Path | None, require_existing: bool, resources: ExitStack
) -> Path:
    path = (database_path if database_path is not None else load_settings().database.path).resolve()
    if not require_existing:
        make_private_directory(path.parent, parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".worker.lock")
    try:
        resources.enter_context(exclusive_file_lock(lock_path))
    except FileLockError as exc:
        if isinstance(exc.__cause__, BlockingIOError):
            hint = "请关闭正在使用该文件的其他 Folio-J 实例后重试。"
        elif isinstance(exc.__cause__, PermissionError):
            hint = "访问被拒绝。请检查数据目录权限，或核对安全软件是否拦截。"
        else:
            hint = "请检查数据目录和锁文件是否可访问。"
        raise ApplicationStartupError(f"无法锁定数据库文件：{path}。{hint}") from exc
    return path


@asynccontextmanager
async def _worker_database(
    database_path: Path | None, require_existing: bool
) -> AsyncGenerator[Path, None]:
    lock = ExitStack()
    acquisition = asyncio.create_task(
        asyncio.to_thread(_open_worker_database, database_path, require_existing, lock)
    )
    try:
        try:
            path = await asyncio.shield(acquisition)
        except asyncio.CancelledError:
            # The blocking file open can finish after cancellation. Let it register
            # the handle before closing the stack.
            with suppress(Exception):
                await acquisition
            raise
        yield path
    finally:
        await asyncio.to_thread(lock.close)


def create_app(
    frontend_dir: Path | None = None,
    database_path: Path | None = None,
    *,
    require_existing: bool = False,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
        async with (
            _worker_database(database_path, require_existing) as path,
            AsyncExitStack() as resources,
        ):
            engine = create_engine(path, require_existing=require_existing)
            resources.push_async_callback(engine.dispose)
            application.state.session_factory = async_sessionmaker(engine, expire_on_commit=False)
            reader_views = ReaderViews(application.state.session_factory)
            application.state.reader_views = reader_views
            statistics_runtime = StatisticsRuntime()
            application.state.statistics_runtime = statistics_runtime
            resources.push_async_callback(statistics_runtime.close)
            resources.push_async_callback(reader_views.close)
            application.state.database_path = path
            application.state.dictionary_store = DictionaryStore(
                path.with_name(path.name + ".dictionary.sqlite3")
            )
            application.state.verification_semaphore = asyncio.Semaphore(2)
            application.state.chat_dispatch_lock = asyncio.Lock()
            application.state.translation_semaphore = asyncio.Semaphore(1)
            background = workers(application)

            async def close_background() -> None:
                results = await asyncio.gather(
                    *(executor.close() for executor in background.values()), return_exceptions=True
                )
                for result in results:
                    if isinstance(result, BaseException):
                        raise result

            resources.push_async_callback(close_background)
            for name, executor in background.items():
                executor.activate(
                    enabled=(
                        application.state.verification_worker_enabled
                        if name == "verification"
                        else application.state.chat_worker_enabled
                    )
                )
            async with application.state.session_factory() as session:
                await recover_chat_jobs(session)
                await interrupt_unfinished(session)
                await translations.recover(session)
            if application.state.chat_worker_enabled:
                start_chat_worker(application)
                translations.start_worker(application)
            yield

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

    @application.exception_handler(AnkiConnectError)
    async def anki_error(_request: Request, exc: AnkiConnectError) -> JSONResponse:
        status = {
            "unreachable": 503,
            "authentication": 403,
            "no_collection": 409,
            "stale_session": 409,
            "target_missing": 404,
            "conflict": 409,
        }.get(exc.code, 502)
        return JSONResponse(
            status_code=status, content={"code": exc.code, "detail": connection_error_message(exc)}
        )

    application.include_router(anki_settings_router)
    application.include_router(anki_router)
    application.include_router(health_router)
    application.include_router(dictionary_router)
    from app.api.catalog import router as catalog_router

    application.include_router(catalog_router)
    application.include_router(materials_router)
    application.include_router(bookmarks_router)
    application.include_router(analyses_router)
    application.include_router(sources_router)
    application.include_router(settings_router)
    from app.api.translations import router as translations_router

    application.include_router(translations_router)
    from app.api.chat import router as chat_router

    application.include_router(chat_router)
    built_frontend = (
        frontend_dir if frontend_dir is not None else RESOURCE_ROOT / "frontend" / "dist"
    )
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
        index = root / "index.html"
        if requested != index:
            if requested.is_file():
                return FileResponse(requested)
            if full_path.startswith("assets/") or "." in Path(full_path).name:
                raise HTTPException(status_code=404)
        if index.is_file():
            # The same URL must show the recovery page if the next launch loses its library.
            return FileResponse(index, headers={"Cache-Control": "no-store"})
        raise HTTPException(status_code=404)

    return application


app = create_app()
