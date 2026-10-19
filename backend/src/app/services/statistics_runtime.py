"""Per-application bounded cache and shared local statistics computations."""

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable

from fastapi import HTTPException

MAX_CACHE_ENTRIES = 128
MAX_CACHE_BYTES = 8 * 1024 * 1024
MAX_COMPUTATIONS = 2
MAX_PENDING_COMPUTATIONS = 16

CacheKey = tuple[str, ...]


class StatisticsRuntime:
    """Cache immutable bytes; cancelled HTTP waiters never cancel a shared worker."""

    def __init__(
        self,
        *,
        max_entries: int = MAX_CACHE_ENTRIES,
        max_bytes: int = MAX_CACHE_BYTES,
        concurrency: int = MAX_COMPUTATIONS,
        max_pending: int = MAX_PENDING_COMPUTATIONS,
    ) -> None:
        if min(max_entries, max_bytes, concurrency, max_pending) < 1:
            raise ValueError("统计缓存与计算限额必须为正数")
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._max_pending = max_pending
        self._semaphore = asyncio.Semaphore(concurrency)
        self._cache: OrderedDict[CacheKey, bytes] = OrderedDict()
        self._cache_bytes = 0
        self._pending: dict[CacheKey, asyncio.Task[bytes]] = {}
        self._closed = False

    async def get(self, key: CacheKey, compute: Callable[[], Awaitable[bytes]]) -> bytes:
        if self._closed:
            raise HTTPException(503, "统计服务正在关闭，请稍后重试")
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            return cached
        task = self._pending.get(key)
        if task is None:
            if len(self._pending) >= self._max_pending:
                raise HTTPException(503, "统计计算繁忙，请稍后重试")
            task = asyncio.create_task(self._compute(key, compute))
            self._pending[key] = task
            # A disconnected sole waiter must not leave an unobserved exception.
            task.add_done_callback(self._observe)
        return await asyncio.shield(task)

    @staticmethod
    def _observe(task: asyncio.Task[bytes]) -> None:
        if not task.cancelled():
            task.exception()

    async def _compute(self, key: CacheKey, compute: Callable[[], Awaitable[bytes]]) -> bytes:
        try:
            async with self._semaphore:
                result = await compute()
            if len(result) <= self._max_bytes:
                while self._cache and (
                    len(self._cache) >= self._max_entries
                    or self._cache_bytes + len(result) > self._max_bytes
                ):
                    _, evicted = self._cache.popitem(last=False)
                    self._cache_bytes -= len(evicted)
                self._cache[key] = result
                self._cache_bytes += len(result)
            return result
        finally:
            self._pending.pop(key, None)

    async def close(self) -> None:
        """Drain workers before disposing the database; do not cancel running threads."""
        self._closed = True
        try:
            if self._pending:
                draining = asyncio.gather(*tuple(self._pending.values()), return_exceptions=True)
                try:
                    await asyncio.shield(draining)
                except asyncio.CancelledError:
                    await draining
                    raise
        finally:
            self._cache.clear()
            self._cache_bytes = 0
