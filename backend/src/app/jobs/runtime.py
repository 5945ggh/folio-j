"""One-process supervisor for durable chat jobs."""

import asyncio
import json
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_models import ChatMessage, ChatThread, Job
from app.ids import new_ulid
from app.jobs.supervision import worker
from app.llm import adapters
from app.models import Segment, Source
from app.services.settings import now, read_credential
from app.settings_models import Run

if TYPE_CHECKING:
    from fastapi import FastAPI

CALL_SECONDS = 180
SCAN_SECONDS = 0.25
ACTIVE = ("queued", "running", "stopping")


def tool_definitions() -> list[dict[str, Any]]:
    path = Path(__file__).resolve().parents[3] / "prompts" / "chat" / "tools_v5.json"
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
        if job.kind == "generate_analysis":
            finished = now()
            job.status = "interrupted"
            job.error_code = "legacy_job_unsupported"
            job.error = "旧版专用生成任务已停用，请重新发起普通对话"
            job.execution_token = None
            job.finished_at = finished
            job.version += 1
            assistant.status, assistant.updated_at = "interrupted", finished
            _release(thread, job)
            await session.commit()
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
        run = Run(
            id=new_ulid(),
            purpose="chat",
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
            prompt_version=inputs["prompt_version"],
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
        state["active_step"] = (
            "applying_review"
            if state.get("review_proposal") and state.get("decision") == "approve"
            else "model_call"
        )
        job.execution_state = state
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
            tools=inputs["tools"],
            timeout_seconds=CALL_SECONDS,
        )
        return token, key, snapshot


async def execution_authorized(session: AsyncSession, job_id: str, token: str) -> bool:
    """Check the claim and live parents without loading persisted JSON snapshots."""
    return (
        await session.scalar(
            select(Job.id)
            .join(ChatThread, ChatThread.id == Job.thread_id)
            .join(Segment, Segment.id == ChatThread.segment_id)
            .join(Source, Source.id == Segment.source_id)
            .where(
                Job.id == job_id,
                Job.status == "running",
                Job.execution_token == token,
                Job.deleted_at.is_(None),
                ChatThread.active_job_id == job_id,
                ChatThread.deleted_at.is_(None),
                Segment.deleted_at.is_(None),
                Source.deleted_at.is_(None),
            )
        )
    ) is not None


async def _call_authorized(application: "FastAPI", job_id: str, token: str) -> bool:
    """Recheck the persisted claim before dispatch or progress persistence."""
    async with application.state.session_factory() as session:
        return await execution_authorized(session, job_id, token)


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
        from app.jobs.agent import execute_agent_job

        await execute_agent_job(application, job_id, token, key, snapshot)


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
    worker(application, "chat").wake()


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
    background = worker(application, "chat")
    for job_id in queued:
        background.submit(
            job_id,
            partial(execute_job, application, job_id),
            partial(fail_job, application, job_id),
        )
    for job_id in stopping:
        if job_id not in background.tasks:
            await _finalize_stop(application, job_id)


async def fail_job(application: "FastAPI", job_id: str) -> None:
    """Release an unexpectedly exited job without replaying calls or saved artifacts."""
    async with application.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status not in ACTIVE:
            return
        stopped = job.status == "stopping"
        finished = now()
        job.status = "interrupted" if stopped else "failed"
        job.error_code = "user_stopped" if stopped else "worker_failed"
        job.error = "已停止本轮回答" if stopped else "后台执行异常，本轮已停止；已保存成果保留"
        job.execution_token = None
        job.finished_at = finished
        job.version += 1
        thread = await session.get(ChatThread, job.thread_id)
        if thread is not None:
            _release(thread, job)
        assistant = await _assistant(session, job.id)
        if assistant is not None:
            assistant.status, assistant.updated_at = job.status, finished
        runs = (await session.scalars(select(Run).where(Run.job_id == job.id))).all()
        for run in runs:
            if run.status in ("queued", "running"):
                run.status, run.error, run.finished_at = job.status, job.error, finished
        await session.commit()


def start_chat_worker(application: "FastAPI") -> asyncio.Task[None]:
    return worker(application, "chat").start(partial(_scan, application), interval=SCAN_SECONDS)
