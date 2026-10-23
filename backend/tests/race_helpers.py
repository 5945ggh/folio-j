"""Reclaim deliberately paused requests; callers bound the complete race with a timeout."""

import asyncio
from collections.abc import AsyncGenerator, Coroutine
from contextlib import asynccontextmanager
from typing import Any, TypeVar

T = TypeVar("T")


@asynccontextmanager
async def paused_task(
    operation: Coroutine[Any, Any, T],
    entered: asyncio.Event,
    release: asyncio.Event,
) -> AsyncGenerator[asyncio.Task[T], None]:
    pending = asyncio.create_task(operation)
    checkpoint = asyncio.create_task(entered.wait())
    try:
        done, _ = await asyncio.wait({pending, checkpoint}, return_when=asyncio.FIRST_COMPLETED)
        if pending in done:
            await pending  # Preserve an error raised before the checkpoint.
            raise AssertionError("Request completed before reaching the race checkpoint")
        yield pending
        release.set()
        await pending
    finally:
        release.set()
        for task in (pending, checkpoint):
            if not task.done():
                task.cancel()
        await asyncio.gather(pending, checkpoint, return_exceptions=True)
