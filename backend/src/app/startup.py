"""Database-independent startup routes and delegation to a ready application."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from secrets import compare_digest
from typing import cast

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import Receive, Scope, Send

from app.resources import RESOURCE_ROOT
from app.services.startup import StartupSelection, StartupService, StartupState

router = APIRouter(prefix="/_startup", tags=["startup"])


def _service(request: Request) -> StartupService:
    return cast(StartupService, request.app.state.startup)


def _authorize(request: Request, service: StartupService) -> None:
    token = request.headers.get("x-folio-startup-token", "")
    origin = request.headers.get("origin")
    expected_origin = f"{request.url.scheme}://{request.url.netloc}"
    if origin != expected_origin or not compare_digest(token.encode(), service.token.encode()):
        raise HTTPException(status_code=403, detail="请从本机启动页面提交操作。")


@router.get("/state", response_model=StartupState)
async def startup_state(request: Request) -> StartupState:
    return _service(request).state()


@router.post("/select", response_model=StartupState)
async def startup_select(request: Request, selection: StartupSelection) -> StartupState:
    service = _service(request)
    _authorize(request, service)
    try:
        return await service.select(selection)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/retry", response_model=StartupState)
async def startup_retry(request: Request) -> StartupState:
    service = _service(request)
    _authorize(request, service)
    try:
        return await service.retry()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/retry-current", response_model=StartupState)
async def startup_retry_current(request: Request) -> StartupState:
    service = _service(request)
    _authorize(request, service)
    try:
        return await service.retry_current()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


class StartupApplication:
    """Bind once; route normal requests only after real ASGI startup succeeds."""

    def __init__(self, service: StartupService, page: Path | None = None) -> None:
        self.service = service

        @asynccontextmanager
        async def lifespan(_application: FastAPI) -> AsyncGenerator[None]:
            try:
                await service.initialize()
                yield
            finally:
                await service.close()

        application = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
        application.state.startup = service
        application.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
        application.include_router(router)

        @application.api_route(
            "/api",
            methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            include_in_schema=False,
        )
        @application.api_route(
            "/api/{path:path}",
            methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            include_in_schema=False,
        )
        async def unavailable_api(path: str = "") -> None:
            raise HTTPException(status_code=503, detail="请先完成数据位置设置或恢复。")

        startup_page = page or RESOURCE_ROOT / "backend/static/startup/index.html"

        @application.get("/{path:path}", include_in_schema=False)
        async def setup_page(path: str) -> HTMLResponse:
            html = startup_page.read_text(encoding="utf-8").replace(
                "__FOLIO_STARTUP_NONCE__", service.token
            )
            return HTMLResponse(
                html,
                headers={
                    "Cache-Control": "no-store",
                    "Content-Security-Policy": (
                        "default-src 'none'; connect-src 'self'; "
                        f"style-src 'nonce-{service.token}'; script-src 'nonce-{service.token}'; "
                        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
                    ),
                    "X-Content-Type-Options": "nosniff",
                },
            )

        self._setup = application

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        application = self.service.application
        if (
            scope["type"] != "lifespan"
            and not scope.get("path", "").startswith("/_startup")
            and application is not None
        ):
            await application(scope, receive, send)
        else:
            await self._setup(scope, receive, send)
