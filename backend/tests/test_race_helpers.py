import asyncio

import pytest
from race_helpers import paused_task


@pytest.mark.asyncio
async def test_early_request_failure_is_reported_without_waiting_for_checkpoint() -> None:
    async def fail() -> None:
        raise ValueError("request failed before transaction")

    release = asyncio.Event()
    with pytest.raises(ValueError, match="before transaction"):
        async with asyncio.timeout(5), paused_task(fail(), asyncio.Event(), release):
            pytest.fail("The race checkpoint was never entered")
    assert release.is_set()


@pytest.mark.asyncio
async def test_missing_checkpoint_times_out_and_reclaims_pending_request() -> None:
    finished = asyncio.Event()

    async def stall() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            finished.set()

    release = asyncio.Event()
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(0.05), paused_task(stall(), asyncio.Event(), release):
            pytest.fail("The race checkpoint was never entered")
    assert release.is_set() and finished.is_set()
