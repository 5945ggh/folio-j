"""Keep startup failures recoverable without opening a second local server."""

from __future__ import annotations

import asyncio
import os
import secrets
import sys
from collections.abc import Callable, Generator
from contextlib import AsyncExitStack, contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from time import monotonic
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel, Field, field_validator

from app.config import (
    DatabaseLocationError,
    DatabasePathError,
    Settings,
    SettingsAccessError,
    SettingsFormatError,
    database_exists,
    selection_record_paths,
)
from app.services import data_location


class StartupSelection(BaseModel):
    directory: str = Field(min_length=1, max_length=32768)
    mode: Literal["new", "existing"]

    @field_validator("directory")
    @classmethod
    def normalize_directory(cls, value: str) -> str:
        path = value.strip()
        if len(path) >= 2 and path.startswith('"') and path.endswith('"'):
            path = path[1:-1]
        if not path:
            raise ValueError("请填写数据目录或数据库文件的完整路径。")
        return path


class StartupStage(BaseModel):
    name: str
    target: str
    elapsed_ms: int


class StartupState(BaseModel):
    ready: bool
    recovery: bool
    busy: bool
    stage: StartupStage | None
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


@dataclass
class _ActiveStage:
    name: str
    target: Path
    started: float
    failure_message: str | None = None

    def snapshot(self) -> StartupStage:
        return StartupStage(
            name=self.name,
            target=str(self.target),
            elapsed_ms=int((monotonic() - self.started) * 1000),
        )


class _StartupFailure(Exception):
    """A stage failure with a message safe for the terminal and browser."""


class ApplicationStartupError(RuntimeError):
    """An actionable error from the application lifespan, safe to display."""


def _exception_details(error: BaseException) -> str:
    parts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        codes: list[str] = []
        for name in ("winerror", "errno", "sqlite_errorcode"):
            code = getattr(current, name, None)
            if isinstance(code, int):
                codes.append(f"{name}={code}")
        details = f" ({', '.join(codes)})" if codes else ""
        parts.append(f"{type(current).__name__}{details}")
        current = current.__cause__ or (
            None if current.__suppress_context__ else current.__context__
        )
    return " → ".join(parts)


def _safe_reason(error: Exception) -> str:
    if isinstance(
        error,
        (
            ApplicationStartupError,
            data_location.DataLocationError,
            DatabaseLocationError,
            DatabasePathError,
            SettingsAccessError,
            SettingsFormatError,
        ),
    ):
        return str(error)
    if isinstance(error, PermissionError):
        return "访问被拒绝。请检查数据目录和文件的访问权限，或核对安全软件是否拦截。"
    return "请检查目标路径是否可访问，然后重试。详细阶段和错误类型也可在启动终端查看。"


class StartupService:
    """Own selection, migration and the active application's complete lifespan."""

    def __init__(
        self,
        status: data_location.LocationStatus,
        migrate: Callable[[Path, bool], None],
        create_application: Callable[[Path], FastAPI],
        *,
        load_location: Callable[[], data_location.LocationStatus] | None = None,
        choose_data: bool = False,
    ) -> None:
        self.status = status
        self.token = secrets.token_urlsafe(32)
        self.application: FastAPI | None = None
        self._migrate = migrate
        self._create_application = create_application
        self._load_location = load_location
        self._choose_data = choose_data
        self._initializing = load_location is not None
        self._stage: _ActiveStage | None = None
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
            busy=self._initializing or self._stage is not None,
            stage=self._stage.snapshot() if self._stage is not None else None,
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
        try:
            async with self._lock:
                if self._load_location is not None:
                    await self._inspect_location(self._load_location)
                if not self._choose_data:
                    await self._activate_configured()
        finally:
            self._initializing = False

    @contextmanager
    def _measure(self, name: str, target: Path) -> Generator[_ActiveStage, None, None]:
        stage = _ActiveStage(name, target, monotonic())
        self._stage = stage
        print(f"启动阶段开始：{name}；目标 {str(target)!r}", file=sys.stderr, flush=True)
        try:
            yield stage
        except Exception as exc:
            snapshot = stage.snapshot()
            details = _exception_details(exc)
            reason = stage.failure_message or _safe_reason(exc)
            error = (
                f"{name}失败（{snapshot.elapsed_ms} ms）\n目标：{snapshot.target}\n"
                f"异常：{details}\n{reason}"
            )
            # The raw traceback and arbitrary exception messages may contain user data.
            safe_reason = "".join(
                char if char.isprintable() else repr(char)[1:-1] for char in reason
            )
            print(
                f"启动阶段失败：{name}（{snapshot.elapsed_ms} ms）；目标 {snapshot.target!r}\n"
                f"异常：{details}\n{safe_reason}",
                file=sys.stderr,
                flush=True,
            )
            raise _StartupFailure(error) from exc
        else:
            snapshot = stage.snapshot()
            print(
                f"启动阶段完成：{name}（{snapshot.elapsed_ms} ms）；目标 {snapshot.target!r}",
                file=sys.stderr,
                flush=True,
            )
        finally:
            self._stage = None

    def _ensure_idle(self) -> None:
        if self._initializing or self._lock.locked():
            raise ValueError("已有启动操作正在进行，请等待当前阶段完成")

    async def _inspect_location(self, load: Callable[[], data_location.LocationStatus]) -> None:
        override = os.environ.get("FOLIO_J_DATABASE_PATH")
        target = self._configured_path or (
            Path(override) if override else selection_record_paths()[0]
        )
        try:
            with self._measure("检查原配置的数据位置", target) as stage:
                status = await asyncio.to_thread(load)
                self.status = status
                self._selected_path = status.selected_path
                self._configured_path = status.selected_path
                self._error = status.error
                self._recovery = status.recovery
                self._warning = status.warning
                if status.selected_path is not None:
                    stage.target = status.selected_path
                if status.failure is not None:
                    stage.failure_message = status.error
                    raise status.failure
        except _StartupFailure as exc:
            self._error = str(exc)
            self._recovery = True

    async def _activate_configured(self) -> None:
        settings = self.status.settings
        if self.status.needs_selection or self._error or settings is None:
            return
        existed = self.status.database_existed
        if existed is None:
            try:
                with self._measure("核对数据库文件", settings.database.path):
                    existed = self.status.source in (
                        "remembered",
                        "legacy",
                    ) or await asyncio.to_thread(settings.database.path.is_file)
            except _StartupFailure as exc:
                self._error = str(exc)
                self._recovery = True
                return
        self._candidate = _StartupCandidate(settings, remember=False, database_existed=existed)
        await self._activate(self._candidate)

    async def select(self, selection: StartupSelection) -> StartupState:
        self._ensure_idle()
        async with self._lock:
            if self.application is not None:
                raise ValueError("应用已启动，如需更换数据目录，请先停止服务")
            try:
                directory = Path(selection.directory)
                with self._measure("检查所选数据位置", directory) as stage:
                    resolution = await asyncio.to_thread(
                        data_location.prepare_selection_resolution,
                        directory,
                        use_existing=selection.mode == "existing",
                    )
                    settings = resolution.settings
                    self._warning = resolution.warning
                    stage.target = settings.database.path
            except _StartupFailure as exc:
                self._error = str(exc)
                return self.state()
            self._candidate = _StartupCandidate(
                settings, remember=True, database_existed=selection.mode == "existing"
            )
            await self._activate(self._candidate)
            return self.state()

    async def retry(self) -> StartupState:
        self._ensure_idle()
        async with self._lock:
            if self.application is not None:
                raise ValueError("应用已启动")
            await self._inspect_location(data_location.location_status)
            await self._activate_configured()
            return self.state()

    async def retry_current(self) -> StartupState:
        self._ensure_idle()
        async with self._lock:
            if self.application is not None:
                raise ValueError("应用已启动")
            candidate = self._candidate
            if candidate is None:
                raise ValueError("请先选择数据目录")
            path = candidate.settings.database.path
            self._selected_path = path
            try:
                with self._measure("重新检查所选数据位置", path):
                    if candidate.database_existed and not await asyncio.to_thread(
                        database_exists, path
                    ):
                        raise data_location.DataLocationError(
                            "之前选择的数据库文件已不存在，请重新连接原位置或选择其他已有数据。"
                        )
                    settings = await asyncio.to_thread(
                        data_location.validate_retry_selection, candidate.settings
                    )
            except _StartupFailure as exc:
                self._error = str(exc)
                self._recovery = True
                return self.state()
            await self._activate(replace(candidate, settings=settings))
            return self.state()

    async def _activate(self, candidate: _StartupCandidate) -> None:
        path = candidate.settings.database.path
        self._selected_path = path
        resources = AsyncExitStack()
        try:
            with self._measure("迁移学习数据库", path):
                await asyncio.to_thread(self._migrate, path, candidate.database_existed)
            self._candidate = replace(candidate, database_existed=True)
            with self._measure("初始化学习应用", path):
                application = await asyncio.to_thread(self._create_application, path)
                await resources.enter_async_context(
                    application.router.lifespan_context(application)
                )
            if candidate.remember:
                try:
                    with self._measure("保存数据位置记录", selection_record_paths()[0]):
                        await asyncio.to_thread(data_location.remember_selection, path)
                except _StartupFailure as exc:
                    if not isinstance(exc.__cause__, (data_location.DataLocationError, OSError)):
                        raise
                    warning = f"{exc}\n本次可以继续使用。下次启动时可能需要重新选择数据目录。"
                    self._warning = f"{self._warning}\n{warning}" if self._warning else warning
        except _StartupFailure as exc:
            self._error = str(exc)
            try:
                with self._measure("清理本次启动资源", path):
                    await resources.aclose()
            except _StartupFailure as cleanup_error:
                self._error += f"\n{cleanup_error}"
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
