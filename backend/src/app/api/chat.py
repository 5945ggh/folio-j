"""Thin routes for persisted segment conversations."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_schemas import (
    ExplanationPromptResponse,
    JobCreate,
    JobDecision,
    JobResponse,
    MessagePage,
    ThreadCreate,
    ThreadPage,
    ThreadPatch,
    ThreadResponse,
)
from app.db import get_session
from app.services import chat as service

router = APIRouter(prefix="/api")
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get(
    "/chat/explanation-prompt",
    response_model=ExplanationPromptResponse,
    operation_id="getExplanationPrompt",
)
def explanation_prompt() -> ExplanationPromptResponse:
    return service.explanation_prompt()


@router.get("/segments/{segment_id}/threads", response_model=ThreadPage, operation_id="listThreads")
async def list_threads(
    segment_id: str,
    session: Session,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: str | None = None,
) -> ThreadPage:
    return await service.list_threads(session, segment_id, limit, cursor)


@router.post(
    "/segments/{segment_id}/threads",
    response_model=ThreadResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="createThread",
)
async def create_thread(segment_id: str, data: ThreadCreate, session: Session) -> ThreadResponse:
    return await service.create_thread(session, segment_id, data)


@router.get("/threads/{thread_id}", response_model=ThreadResponse, operation_id="getThread")
async def get_thread(thread_id: str, session: Session) -> ThreadResponse:
    return await service.get_thread(session, thread_id)


@router.patch("/threads/{thread_id}", response_model=ThreadResponse, operation_id="patchThread")
async def patch_thread(thread_id: str, data: ThreadPatch, session: Session) -> ThreadResponse:
    return await service.patch_thread(session, thread_id, data)


@router.get(
    "/threads/{thread_id}/messages", response_model=MessagePage, operation_id="listMessages"
)
async def list_messages(
    thread_id: str,
    session: Session,
    after_ordinal: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    direction: Literal["forward", "backward"] = "forward",
    before_ordinal: Annotated[int | None, Query(ge=1)] = None,
) -> MessagePage:
    return await service.list_messages(
        session, thread_id, after_ordinal, limit, direction, before_ordinal
    )


@router.post(
    "/threads/{thread_id}/jobs",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="acceptChatJob",
)
async def accept_job(
    thread_id: str, data: JobCreate, session: Session, request: Request
) -> JobResponse:
    response = await service.accept_job(session, thread_id, data, request.app.state.database_path)
    from app.jobs.runtime import wake_chat_worker

    wake_chat_worker(request.app)
    return response


@router.get(
    "/threads/{thread_id}/jobs/by-request/{request_id}",
    response_model=JobResponse,
    operation_id="getChatJobByRequest",
)
async def get_job_by_request(thread_id: str, request_id: str, session: Session) -> JobResponse:
    return await service.get_job_by_request(session, thread_id, request_id)


@router.get("/jobs/{job_id}", response_model=JobResponse, operation_id="getChatJob")
async def get_job(job_id: str, session: Session) -> JobResponse:
    return await service.get_job(session, job_id)


@router.post("/jobs/{job_id}/stop", response_model=JobResponse, operation_id="stopChatJob")
async def stop_job(job_id: str, session: Session, request: Request) -> JobResponse:
    response = await service.stop_job(session, job_id, request.app.state.chat_dispatch_lock)
    if response.status == "stopping":
        from app.jobs.runtime import request_chat_cancel

        request_chat_cancel(request.app, job_id)
    return response


@router.post("/jobs/{job_id}/decision", response_model=JobResponse, operation_id="decideChatJob")
async def decide_job(
    job_id: str, data: JobDecision, session: Session, request: Request
) -> JobResponse:
    response = await service.decide_job(session, job_id, data)
    if response.status == "queued":
        from app.jobs.runtime import wake_chat_worker

        wake_chat_worker(request.app)
    return response
