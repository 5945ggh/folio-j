"""Observe local workers and retry coordination without replaying external work."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, cast

if TYPE_CHECKING:
    from fastapi import FastAPI

Action = Callable[[], Awaitable[None]]
WorkerName = Literal["chat", "translation", "verification"]
WorkerStatus = Literal["healthy", "retrying", "stopped", "disabled"]
RETRY_SECONDS = 0.25
MAX_RETRY_SECONDS = 5.0
LOGGER = logging.getLogger(__name__)


class BackgroundWorker:
    """Own task observation, scan retries, recovery retries and shutdown for one worker."""

    def __init__(self, name: WorkerName) -> None:
        self.name = name
        self.enabled = True
        self.started = False
        self.event = asyncio.Event()
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.supervisor: asyncio.Task[None] | None = None
        self.failures = 0
        self.last_error: str | None = None
        self.last_failure_at: datetime | None = None
        self._errors: set[str] = set()

    @property
    def status(self) -> WorkerStatus:
        if not self.enabled:
            return "disabled"
        if not self.started or (self.supervisor is not None and self.supervisor.done()):
            return "stopped"
        return "retrying" if self._errors else "healthy"

    def activate(self, *, enabled: bool) -> None:
        self.enabled = enabled
        self.started = enabled

    def wake(self) -> None:
        self.event.set()

    def cancel(self, identity: str) -> None:
        task = self.tasks.get(identity)
        if task is not None:
            task.cancel()

    def _failed(self, scope: str, error: BaseException) -> None:
        self._errors.add(scope)
        self.failures += 1
        self.last_error = type(error).__name__
        self.last_failure_at = datetime.now(UTC)
        # Exception text/tracebacks may contain provider credentials or learning content.
        LOGGER.error("Background worker %s %s failed (%s)", self.name, scope, self.last_error)

    def start(self, scan: Action, *, interval: float) -> asyncio.Task[None]:
        self.activate(enabled=True)
        self.supervisor = asyncio.create_task(self._supervise(scan, interval))
        return self.supervisor

    async def _supervise(self, scan: Action, interval: float) -> None:
        delay = RETRY_SECONDS
        try:
            while True:
                self.event.clear()
                try:
                    await scan()
                except Exception as error:
                    self._failed("scan", error)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, MAX_RETRY_SECONDS)
                    continue
                self._errors.discard("scan")
                delay = RETRY_SECONDS
                try:
                    await asyncio.wait_for(self.event.wait(), timeout=interval)
                except TimeoutError:
                    pass
        finally:
            self.started = False

    def submit(self, identity: str, execute: Action, recover: Action) -> asyncio.Task[None]:
        existing = self.tasks.get(identity)
        if existing is not None:
            return existing
        task = asyncio.create_task(self._execute(identity, execute, recover))
        self.tasks[identity] = task

        def done(completed: asyncio.Task[None]) -> None:
            self.tasks.pop(identity, None)
            if completed.cancelled():
                self._errors.discard(identity)
            else:
                error = completed.exception()
                if error is not None:
                    self._failed(identity, error)

        task.add_done_callback(done)
        return task

    async def _execute(self, identity: str, execute: Action, recover: Action) -> None:
        try:
            await execute()
        except Exception as error:
            self._failed(identity, error)
            delay = RETRY_SECONDS
            while True:
                try:
                    # Only local terminal-state repair is retried; never execute again.
                    await recover()
                except Exception as recovery_error:
                    self._failed(identity, recovery_error)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, MAX_RETRY_SECONDS)
                else:
                    self._errors.discard(identity)
                    return

    async def close(self) -> None:
        if self.supervisor is not None:
            self.supervisor.cancel()
            await asyncio.gather(self.supervisor, return_exceptions=True)
        tasks = tuple(self.tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.started = False


def workers(application: "FastAPI") -> dict[WorkerName, BackgroundWorker]:
    return cast(dict[WorkerName, BackgroundWorker], application.state.background_workers)


def worker(application: "FastAPI", name: WorkerName) -> BackgroundWorker:
    return workers(application)[name]
