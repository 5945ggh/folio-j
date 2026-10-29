"""Private, instance-owned reader cache; budgets count retained Python object graphs."""

import asyncio
import sys
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import fields, is_dataclass
from typing import TypeVar, cast

from fastapi import HTTPException
from pydantic import BaseModel

T = TypeVar("T")
Key = tuple[str, ...]


def retained_bytes(value: object) -> int:
    """Count owned containers, Pydantic fields and strings, deduplicating shared references.

    This is retained Python memory, not compressed/serialized length or peak process RSS.
    Cache entries are charged independently, conservatively double-counting shared objects.
    """
    seen: set[int] = set()

    def size(item: object) -> int:
        identity = id(item)
        if identity in seen:
            return 0
        seen.add(identity)
        result = sys.getsizeof(item)
        if isinstance(item, BaseModel):
            result += size(vars(item))
            result += size(item.__pydantic_fields_set__)
        elif isinstance(item, dict):
            values = cast(dict[object, object], item)
            result += sum(size(key) + size(value) for key, value in values.items())
        elif isinstance(item, (tuple, list, set, frozenset)):
            result += sum(size(value) for value in cast(tuple[object, ...], item))
        elif is_dataclass(item) and not isinstance(item, type):
            result += sum(size(getattr(item, field.name)) for field in fields(item))
            if hasattr(item, "__dict__"):
                result += size(vars(item))
        return result

    return size(value)


class ViewCache:
    """Only tasks in this instance own loaders; completed entries retain values alone."""

    def __init__(
        self,
        *,
        max_bytes: int,
        max_entries: int,
        max_pending: int,
        accounting_semaphore: asyncio.Semaphore,
    ) -> None:
        if min(max_bytes, max_entries, max_pending) < 1:
            raise ValueError("阅读缓存限额必须为正数")
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._max_pending = max_pending
        self._cache: OrderedDict[Key, tuple[object, int]] = OrderedDict()
        self._bytes = 0
        self._pending: dict[Key, asyncio.Task[object]] = {}
        self._closed = False
        self._accounting_semaphore = accounting_semaphore

    async def get(self, key: Key, load: Callable[[], Awaitable[T]]) -> T:
        if self._closed:
            raise HTTPException(503, "阅读服务正在关闭，请稍后重试")
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            return cast(T, cached[0])
        task = self._pending.get(key)
        if task is None:
            if len(self._pending) >= self._max_pending:
                raise HTTPException(503, "阅读计算繁忙，请稍后重试")
            task = asyncio.create_task(self._load(key, load))
            self._pending[key] = task
            task.add_done_callback(self._observe)
        return cast(T, await asyncio.shield(task))

    @staticmethod
    def _observe(task: asyncio.Task[object]) -> None:
        if not task.cancelled():
            task.exception()

    async def _load(self, key: Key, load: Callable[[], Awaitable[object]]) -> object:
        try:
            value = await load()
            # Accounting can itself traverse a large token tree; keep it off the loop.
            async with self._accounting_semaphore:
                weight = await asyncio.to_thread(retained_bytes, (key, value))
            if weight <= self._max_bytes and not self._closed:
                while self._cache and (
                    len(self._cache) >= self._max_entries or self._bytes + weight > self._max_bytes
                ):
                    _, (_, evicted) = self._cache.popitem(last=False)
                    self._bytes -= evicted
                self._cache[key] = (value, weight)
                self._bytes += weight
            return value
        finally:
            self._pending.pop(key, None)

    async def close(self) -> None:
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
            self._bytes = 0
