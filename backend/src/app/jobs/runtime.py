"""One-process supervisor for durable chat jobs."""

import asyncio
import json
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_models import ChatMessage, ChatThread, Job
from app.ids import new_ulid
from app.llm import adapters
from app.models import Segment, Source
from app.services.settings import now, read_credential, redact_credential, safe_verification_error
from app.settings_models import Run

if TYPE_CHECKING:
    from fastapi import FastAPI

CALL_SECONDS = 60
ANALYSIS_CALL_SECONDS = 180
OUTPUT_CHAR_LIMIT = 200_000
PROGRESS_SECONDS = 0.25
STOP_GRACE_SECONDS = 2.0
SCAN_SECONDS = 0.25
ACTIVE = ("queued", "running", "stopping")


def tool_definitions() -> list[dict[str, Any]]:
    path = Path(__file__).resolve().parents[3] / "prompts" / "chat" / "tools_v4.json"
    data: dict[str, Any] = json.loads(path.read_text())
    return data["tools"]


def _release(thread: ChatThread, job: Job) -> None:
    if thread.active_job_id == job.id:
        thread.active_job_id = None
        thread.revision += 1
        thread.updated_at = now()


async def _parents_valid(session: AsyncSession, job: Job, thread: ChatThread) -> bool:
    segment = await session.get(Segment, thread.segment_id)
    source = await session.get(Source, segment.source_id) if segment is not None else None
    return bool(
        job.deleted_at is None
        and thread.deleted_at is None
        and segment is not None
        and segment.deleted_at is None
        and source is not None
        and source.deleted_at is None
        and thread.active_job_id == job.id
    )


async def _assistant(session: AsyncSession, job_id: str) -> ChatMessage | None:
    return await session.scalar(
        select(ChatMessage).where(ChatMessage.job_id == job_id, ChatMessage.role == "assistant")
    )


async def _claim(
    application: "FastAPI", job_id: str
) -> tuple[str, str | None, adapters.CallSnapshot] | None:
    async with application.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "queued":
            return None
        thread = await session.get(ChatThread, job.thread_id)
        if thread is None or not await _parents_valid(session, job, thread):
            return None
        assistant = await _assistant(session, job_id)
        if assistant is None:
            return None
        try:
            key = read_credential(application.state.database_path, job.credential_ref)
        except (OSError, UnicodeError):
            job.status = "failed"
            job.error_code = "credential_unavailable"
            job.error = "凭据不可用，请检查模型接入配置"
            job.finished_at = now()
            job.version += 1
            assistant.status = "failed"
            assistant.updated_at = now()
            _release(thread, job)
            await session.commit()
            return None
        model: dict[str, Any] = job.model_snapshot
        inputs: dict[str, Any] = job.input_snapshot
        token = new_ulid()
        started = now()
        state = dict(job.execution_state or {})
        messages = list(state.get("protocol_messages") or inputs["messages"])
        if job.kind == "generate_analysis":
            messages.append({"role": "user", "content": inputs["writer_text"]})
        run = Run(
            id=new_ulid(),
            purpose="analysis" if job.kind == "generate_analysis" else "chat",
            job_id=job.id,
            messages=messages,
            deleted_at=None,
            provider_id=model["provider_id"],
            provider_name=model["provider_name"],
            provider_revision=model["provider_revision"],
            provider_model_id=model["provider_model_id"],
            model_revision=model["model_revision"],
            model_id=model["model_id"],
            protocol=model["protocol"],
            stream=model["stream"],
            status="running",
            output_text="",
            error=None,
            usage=None,
            prompt_version=inputs["prompt_version"]
            + (f"+writer_{inputs['writer_version']}" if job.kind == "generate_analysis" else ""),
            prompt_text="",
            base_url=model["base_url"],
            credential_ref=job.credential_ref,
            temperature=model["temperature"],
            max_output_tokens=model["max_output_tokens"],
            reasoning_effort=model["reasoning_effort"],
            raw_response=None,
            created_at=started,
            started_at=started,
            finished_at=None,
        )
        session.add(run)
        job.status = "running"
        job.execution_token = token
        job.started_at = started
        job.version += 1
        assistant.status = "streaming"
        assistant.updated_at = started
        await session.commit()
        snapshot = adapters.CallSnapshot(
            base_url=model["base_url"],
            model_id=model["model_id"],
            protocol=model["protocol"],
            stream=model["stream"],
            prompt="",
            temperature=model["temperature"],
            max_output_tokens=model["max_output_tokens"],
            reasoning_effort=model["reasoning_effort"],
            messages=messages,
            tools=inputs["tools"] if job.kind == "generate_analysis" else None,
            tool_choice="none" if job.kind == "generate_analysis" else None,
            timeout_seconds=ANALYSIS_CALL_SECONDS,
        )
        return token, key, snapshot


async def _write_progress(application: "FastAPI", job_id: str, token: str, value: str) -> bool:
    async with application.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return False
        thread = await session.get(ChatThread, job.thread_id)
        if thread is None or not await _parents_valid(session, job, thread):
            return False
        run = await session.scalar(select(Run).where(Run.job_id == job_id))
        assistant = await _assistant(session, job_id)
        if run is None or run.status != "running" or assistant is None:
            return False
        run.output_text = value
        assistant.content = value
        assistant.updated_at = now()
        job.version += 1
        await session.commit()
        return True


async def _finish(
    application: "FastAPI",
    job_id: str,
    token: str,
    *,
    result: adapters.GenerateResult | None,
    error_code: str | None,
    error: str | None,
    partial: str,
    key: str | None,
) -> None:
    async with application.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return
        thread = await session.get(ChatThread, job.thread_id)
        if thread is None or not await _parents_valid(session, job, thread):
            return
        run = await session.scalar(select(Run).where(Run.job_id == job_id))
        assistant = await _assistant(session, job_id)
        if run is None or run.status != "running" or assistant is None:
            return
        final_text = redact_credential(result.text, key) if result is not None else partial
        final_text = final_text or partial
        complete = (
            result is not None and result.completed and bool(final_text.strip()) and not error_code
        )
        status = "succeeded" if complete else "failed"
        if not complete and error_code is None:
            error_code, error = "incomplete_output", "模型未返回完整的可见文本"
        if complete and job.kind == "generate_analysis":
            from app.services.analyses import create_analysis

            detail = await create_analysis(
                session,
                segment_id=thread.segment_id,
                source_md=final_text,
                operation_key=f"job:{job.id}:create",
                origin="agent",
                run_id=run.id,
            )
            state = dict(job.execution_state or {})
            state["artifacts"] = [{"analysis_id": detail.id, "revision_id": detail.revision_id}]
            state["active_step"] = "saved"
            job.execution_state = state
            final_text = "讲解已保存，可在左侧阅读。"
        job.status = run.status = status
        job.error_code, job.error = error_code, error
        run.error = error
        run.output_text = result.text if result is not None else partial
        assistant.content = final_text
        run.usage = result.usage if result is not None else None
        run.raw_response = (
            redact_credential(result.raw_response, key) if result is not None else None
        )
        assistant.status = "complete" if complete else "failed"
        finished = now()
        assistant.updated_at = run.finished_at = job.finished_at = finished
        job.execution_token = None
        job.version += 1
        _release(thread, job)
        await session.commit()


async def _status(application: "FastAPI", job_id: str) -> str | None:
    async with application.state.session_factory() as session:
        job = await session.get(Job, job_id)
        return job.status if job is not None else None


async def _call_authorized(application: "FastAPI", job_id: str, token: str) -> bool:
    """Recheck the persisted claim while stop and deletion cannot commit."""
    async with application.state.session_factory() as session:
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return False
        thread = await session.get(ChatThread, job.thread_id)
        if thread is None or not await _parents_valid(session, job, thread):
            return False
        return True


async def call_authorized(application: "FastAPI", job_id: str, token: str) -> bool:
    return await _call_authorized(application, job_id, token)


async def _finalize_stop(application: "FastAPI", job_id: str) -> None:
    async with application.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "stopping":
            return
        thread = await session.get(ChatThread, job.thread_id)
        if thread is None or thread.active_job_id != job_id:
            return
        runs = (await session.scalars(select(Run).where(Run.job_id == job_id))).all()
        assistant = await _assistant(session, job_id)
        finished = now()
        job.status = "interrupted"
        job.error_code = "user_stopped"
        job.error = "已停止本轮回答"
        job.finished_at = finished
        job.version += 1
        for run in runs:
            if run.status == "running":
                run.status, run.error, run.finished_at = "interrupted", job.error, finished
        if assistant is not None:
            assistant.status, assistant.updated_at = "interrupted", finished
        _release(thread, job)
        await session.commit()


async def finalize_stop(application: "FastAPI", job_id: str) -> None:
    await _finalize_stop(application, job_id)


async def execute_job(application: "FastAPI", job_id: str) -> None:
    """Claim exactly one persisted job; tests may invoke this without the scanner."""
    async with application.state.verification_semaphore:
        claim = await _claim(application, job_id)
        if claim is None:
            return
        token, key, snapshot = claim
        async with application.state.session_factory() as session:
            current = await session.get(Job, job_id)
            is_chat = current is not None and current.kind == "chat_reply"
        if is_chat:
            from app.jobs.agent import execute_agent_job

            await execute_agent_job(application, job_id, token, key, snapshot)
            return
        from app.jobs.agent import execute_quick_job

        await execute_quick_job(application, job_id, token, key, snapshot)
        return
        partial = ""
        last_write = 0.0
        loop = asyncio.get_running_loop()

        async def progress(value: str) -> None:
            nonlocal partial, last_write
            safe = redact_credential(value, key) or ""
            partial = safe[:OUTPUT_CHAR_LIMIT]
            if len(safe) > OUTPUT_CHAR_LIMIT:
                raise OutputLimitError()
            current = loop.time()
            if current - last_write >= PROGRESS_SECONDS:
                await _write_progress(application, job_id, token, safe)
                last_write = current

        # Stop/delete hold this same lock around their durable commit. An accepted
        # stop therefore either wins before the SDK entry or observes an entered call.
        async with application.state.chat_dispatch_lock:
            if not await _call_authorized(application, job_id, token):
                authorized = False
                call: asyncio.Task[adapters.GenerateResult] | None = None
            else:
                authorized = True
                entered = asyncio.Event()

                async def invoke() -> adapters.GenerateResult:
                    entered.set()
                    return await adapters.generate_text(snapshot, key, progress)

                call = asyncio.create_task(invoke())
                await entered.wait()
        if not authorized or call is None:
            await _finalize_stop(application, job_id)
            return
        result: adapters.GenerateResult | None = None
        error_code: str | None = None
        error: str | None = None
        stop_started: float | None = None
        async with application.state.session_factory() as session:
            job = await session.get(Job, job_id)
            call_seconds = (
                ANALYSIS_CALL_SECONDS
                if job is not None and job.kind == "generate_analysis"
                else CALL_SECONDS
            )
        deadline = loop.time() + call_seconds
        cancel_sent = False
        finalized = False
        try:
            while not call.done():
                await asyncio.wait({call}, timeout=0.05)
                status = await _status(application, job_id)
                if status == "stopping":
                    if stop_started is None:
                        stop_started = loop.time()
                    if not cancel_sent:
                        call.cancel()
                        cancel_sent = True
                    if loop.time() - stop_started >= STOP_GRACE_SECONDS:
                        await _finalize_stop(application, job_id)
                        finalized = True
                elif status == "running" and loop.time() >= deadline and not finalized:
                    if not cancel_sent:
                        call.cancel()
                        cancel_sent = True
                    await _finish(
                        application,
                        job_id,
                        token,
                        result=None,
                        error_code="timeout",
                        error="模型调用超时（60 秒）",
                        partial=partial,
                        key=key,
                    )
                    finalized = True
                elif status != "running":
                    if not cancel_sent:
                        call.cancel()
                        cancel_sent = True
            if stop_started is not None or await _status(application, job_id) == "stopping":
                await _finalize_stop(application, job_id)
                finalized = True
            try:
                result = call.result()
                if len(result.text) > OUTPUT_CHAR_LIMIT:
                    raise OutputLimitError()
            except asyncio.CancelledError:
                error_code, error = "user_stopped", "已停止本轮回答"
            except OutputLimitError:
                result = None
                error_code, error = "output_limit", "回答超过本地长度上限"
            except TimeoutError:
                error_code, error = "timeout", "模型调用超时（60 秒）"
            except Exception as exc:
                error_code, error = "provider_error", safe_verification_error(exc)
            if finalized:
                return
            if stop_started is not None or await _status(application, job_id) == "stopping":
                await _finalize_stop(application, job_id)
            else:
                await _finish(
                    application,
                    job_id,
                    token,
                    result=result,
                    error_code=error_code,
                    error=error,
                    partial=partial,
                    key=key,
                )
        except asyncio.CancelledError:
            call.cancel()
            with suppress(BaseException):
                await call
            raise


class OutputLimitError(Exception):
    """Local visible-output budget was exceeded."""


async def recover_chat_jobs(session: AsyncSession) -> None:
    """Interrupt every preexisting unfinished job after the process lock is held."""
    await session.execute(text("BEGIN IMMEDIATE"))
    jobs = (await session.scalars(select(Job).where(Job.status.in_(ACTIVE)))).all()
    finished = now()
    for job in jobs:
        job.status = "interrupted"
        job.error_code = "process_interrupted"
        job.error = "应用重启，本轮回答已中断"
        job.execution_token = None
        job.finished_at = finished
        job.version += 1
        thread = await session.get(ChatThread, job.thread_id)
        if thread is not None:
            _release(thread, job)
        assistant = await _assistant(session, job.id)
        if assistant is not None:
            assistant.status, assistant.updated_at = "interrupted", finished
        runs = (await session.scalars(select(Run).where(Run.job_id == job.id))).all()
        for run in runs:
            if run.status in ("queued", "running"):
                run.status, run.error, run.finished_at = "interrupted", job.error, finished
    await session.commit()


def wake_chat_worker(application: "FastAPI") -> None:
    event: asyncio.Event | None = getattr(application.state, "chat_worker_event", None)
    if event is not None:
        event.set()


def request_chat_cancel(application: "FastAPI", _job_id: str) -> None:
    """Stop is persisted by the service; wake the supervisor to observe it."""
    wake_chat_worker(application)


async def _scan(application: "FastAPI") -> None:
    async with application.state.session_factory() as session:
        queued = (
            await session.scalars(
                select(Job.id)
                .where(Job.status == "queued", Job.deleted_at.is_(None))
                .order_by(Job.created_at, Job.id)
            )
        ).all()
        stopping = (await session.scalars(select(Job.id).where(Job.status == "stopping"))).all()
    tasks: set[asyncio.Task[None]] = application.state.chat_tasks
    ids: set[str] = application.state.chat_task_ids
    for job_id in queued:
        if job_id in ids:
            continue
        ids.add(job_id)
        task = asyncio.create_task(execute_job(application, job_id))
        tasks.add(task)

        def done(completed: asyncio.Task[None], identity: str = job_id) -> None:
            ids.discard(identity)
            tasks.discard(completed)

        task.add_done_callback(done)
    for job_id in stopping:
        if job_id not in ids:
            await _finalize_stop(application, job_id)


async def _supervise(application: "FastAPI") -> None:
    event: asyncio.Event = application.state.chat_worker_event
    while True:
        await _scan(application)
        event.clear()
        try:
            await asyncio.wait_for(event.wait(), timeout=SCAN_SECONDS)
        except TimeoutError:
            pass


def start_chat_worker(application: "FastAPI") -> asyncio.Task[None]:
    application.state.chat_worker_event = asyncio.Event()
    application.state.chat_tasks = set()
    application.state.chat_task_ids = set()
    return asyncio.create_task(_supervise(application))
