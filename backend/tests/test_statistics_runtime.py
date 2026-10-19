"""Bounded, instance-owned statistics work survives individual waiter cancellation."""

import asyncio
import threading

import pytest
from fastapi import HTTPException

from app.services.statistics_runtime import StatisticsRuntime


@pytest.mark.asyncio
async def test_shared_work_survives_cancelled_waiter_and_closes_after_thread() -> None:
    runtime = StatisticsRuntime(concurrency=1, max_pending=2)
    started, release = threading.Event(), threading.Event()
    calls = 0

    def work() -> bytes:
        nonlocal calls
        calls += 1
        started.set()
        assert release.wait(5)
        return b"result"

    async def compute() -> bytes:
        return await asyncio.to_thread(work)

    first = asyncio.create_task(runtime.get(("one",), compute))
    assert await asyncio.to_thread(started.wait, 5)
    second = asyncio.create_task(runtime.get(("one",), compute))
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    closing = asyncio.create_task(runtime.close())
    try:
        await asyncio.sleep(0)
        assert not closing.done()
        assert calls == 1
    finally:
        release.set()
    assert await second == b"result"
    await closing
    with pytest.raises(HTTPException) as closed:
        await runtime.get(("one",), compute)
    assert closed.value.status_code == 503


@pytest.mark.asyncio
async def test_different_keys_obey_computation_and_pending_limits() -> None:
    runtime = StatisticsRuntime(concurrency=1, max_pending=2)
    started, release = asyncio.Event(), asyncio.Event()
    active = 0
    peak = 0

    async def compute() -> bytes:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        started.set()
        await release.wait()
        active -= 1
        return b"value"

    first = asyncio.create_task(runtime.get(("a",), compute))
    await started.wait()
    second = asyncio.create_task(runtime.get(("b",), compute))
    await asyncio.sleep(0)
    try:
        with pytest.raises(HTTPException) as full:
            await runtime.get(("c",), compute)
        assert full.value.status_code == 503
        assert peak == 1
    finally:
        release.set()
    assert await asyncio.gather(first, second) == [b"value", b"value"]
    assert peak == 1
    await runtime.close()


@pytest.mark.asyncio
async def test_lru_bytes_limits_oversized_results_and_instances() -> None:
    runtime = StatisticsRuntime(max_entries=2, max_bytes=5)
    calls = 0

    async def compute() -> bytes:
        nonlocal calls
        calls += 1
        return b"aa"

    await runtime.get(("a",), compute)
    await runtime.get(("b",), compute)
    await runtime.get(("a",), compute)  # Refresh a; c evicts b.
    await runtime.get(("c",), compute)
    await runtime.get(("a",), compute)
    assert calls == 3
    await runtime.get(("b",), compute)
    assert calls == 4

    async def oversized() -> bytes:
        nonlocal calls
        calls += 1
        return b"123456"

    await runtime.get(("large",), oversized)
    await runtime.get(("large",), oversized)
    assert calls == 6
    other = StatisticsRuntime(max_entries=3, max_bytes=3)
    await other.get(("a",), compute)
    await other.get(("b",), compute)  # Byte limit evicts a despite free entry slots.
    await other.get(("a",), compute)
    assert calls == 9
    await runtime.close()
    await other.close()


@pytest.mark.asyncio
async def test_failed_computation_is_not_cached_and_same_key_can_retry() -> None:
    runtime = StatisticsRuntime()
    calls = 0

    async def compute() -> bytes:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("retry")
        return b"ok"

    with pytest.raises(ValueError, match="retry"):
        await runtime.get(("key",), compute)
    assert await runtime.get(("key",), compute) == b"ok"
    assert await runtime.get(("key",), compute) == b"ok"
    assert calls == 2
    await runtime.close()


@pytest.mark.asyncio
async def test_cancelled_shutdown_still_drains_shared_thread_work() -> None:
    runtime = StatisticsRuntime()
    started, release = threading.Event(), threading.Event()

    def work() -> bytes:
        started.set()
        assert release.wait(5)
        return b"done"

    async def compute() -> bytes:
        return await asyncio.to_thread(work)

    pending = asyncio.create_task(runtime.get(("key",), compute))
    assert await asyncio.to_thread(started.wait, 5)
    closing = asyncio.create_task(runtime.close())
    await asyncio.sleep(0)
    closing.cancel()
    try:
        await asyncio.sleep(0)
        assert not closing.done()
        assert not pending.done()
    finally:
        release.set()
    assert await pending == b"done"
    with pytest.raises(asyncio.CancelledError):
        await closing
