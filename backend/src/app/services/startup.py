"""Keep startup failures recoverable without opening a second local server."""

from __future__ import annotations

import asyncio
import secrets
import sys
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.config import Settings, database_exists, resolve_settings
from app.services import data_location


class StartupSelection(BaseModel):
    directory: str = Field(min_length=1, max_length=32768)
    mode: Literal["new", "existing"]


class StartupState(BaseModel):
    ready: bool
    recovery: bool
    selected_path: str | None
    configured_path: str | None
    default_directory: str
    retry_current_path: str | None
    error: str | None
    warning: str | None


@dataclass(frozen=True)
class _StartupCandidate:
    settings: Settings
    remember: bool
    database_existed: bool


class StartupService:
    """Own selection, migration and the active application's complete lifespan."""

    def __init__(
        self,
        status: data_location.LocationStatus,
        migrate: Callable[[Path], None],
        create_application: Callable[[Path], FastAPI],
    ) -> None:
        self.status = status
        self.token = secrets.token_urlsafe(32)
        self.application: FastAPI | None = None
        self._migrate = migrate
        self._create_application = create_application
        self._resources = AsyncExitStack()
        self._lock = asyncio.Lock()
        self._error = status.error
        self._selected_path = status.selected_path
        self._configured_path = status.selected_path
        self._recovery = status.recovery
        self._warning = status.warning
        self._candidate: _StartupCandidate | None = None

    def state(self) -> StartupState:
        return StartupState(
            ready=self.application is not None,
            recovery=self._recovery,
            selected_path=str(self._selected_path) if self._selected_path is not None else None,
            configured_path=(
                str(self._configured_path) if self._configured_path is not None else None
            ),
            default_directory=str(self.status.default_path.parent),
            retry_current_path=(
                str(self._candidate.settings.database.path)
                if self._candidate is not None and self.application is None
                else None
            ),
            error=self._error,
            warning=self._warning,
        )

    async def initialize(self) -> None:
        if not self.status.needs_selection and self.status.settings is not None:
            async with self._lock:
                self._configured_candidate(self.status.settings)
                await self._activate(self.status.settings, remember=False)

    async def select(self, selection: StartupSelection) -> StartupState:
        async with self._lock:
            if self.application is not None:
                raise ValueError("应用已启动；如需更换数据位置，请先停止服务。")
            try:
                settings = await asyncio.to_thread(
                    data_location.prepare_selection,
                    Path(selection.directory),
                    use_existing=selection.mode == "existing",
                )
                self._warning = resolve_settings(selected_path=settings.database.path).warning
            except (ValueError, OSError) as exc:
                self._error = str(exc)
                return self.state()
            self._candidate = _StartupCandidate(
                settings, remember=True, database_existed=selection.mode == "existing"
            )
            await self._activate(settings, remember=True)
            return self.state()

    async def retry(self) -> StartupState:
        async with self._lock:
            if self.application is not None:
                raise ValueError("应用已启动。")
            self.status = await asyncio.to_thread(data_location.location_status)
            self._selected_path = self.status.selected_path
            self._configured_path = self.status.selected_path
            self._error = self.status.error
            self._recovery = self.status.recovery
            self._warning = self.status.warning
            if not self.status.needs_selection and self.status.settings is not None:
                self._configured_candidate(self.status.settings)
                await self._activate(self.status.settings, remember=False)
            return self.state()

    def _configured_candidate(self, settings: Settings) -> None:
        self._candidate = _StartupCandidate(
            settings,
            remember=False,
            database_existed=(
                self.status.source in ("remembered", "legacy") or settings.database.path.is_file()
            ),
        )

    async def retry_current(self) -> StartupState:
        async with self._lock:
            if self.application is not None:
                raise ValueError("应用已启动。")
            candidate = self._candidate
            if candidate is None:
                raise ValueError("本次启动尚无已确认的数据位置，请先选择。")
            self._selected_path = candidate.settings.database.path
            try:
                if candidate.database_existed and not await asyncio.to_thread(
                    database_exists, candidate.settings.database.path
                ):
                    raise ValueError("先前选择的学习库已不存在，请重新连接原位置或选择已有学习库。")
                settings = await asyncio.to_thread(
                    data_location.validate_retry_selection, candidate.settings
                )
            except (ValueError, OSError) as exc:
                self._error = str(exc)
                self._recovery = True
                return self.state()
            await self._activate(settings, remember=candidate.remember)
            return self.state()

    async def _activate(self, settings: Settings, *, remember: bool) -> None:
        self._selected_path = settings.database.path
        resources = AsyncExitStack()
        try:
            await asyncio.to_thread(self._migrate, settings.database.path)
            application = self._create_application(settings.database.path)
            await resources.enter_async_context(application.router.lifespan_context(application))
            if remember:
                await asyncio.to_thread(data_location.remember_selection, settings.database.path)
        except Exception as exc:
            self._error = str(exc) or type(exc).__name__
            try:
                await resources.aclose()
            except Exception as cleanup_error:
                self._error += f"；关闭启动资源时出错：{cleanup_error}"
            self._recovery = True
        except BaseException:
            await resources.aclose()
            raise
        else:
            self._resources = resources
            self.application = application
            self._error = None
            self._recovery = False
            if self._warning is not None:
                print(f"启动提示：{self._warning}", file=sys.stderr, flush=True)

    async def close(self) -> None:
        async with self._lock:
            self.application = None
            await self._resources.aclose()
