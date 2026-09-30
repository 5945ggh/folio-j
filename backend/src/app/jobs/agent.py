"""Bounded Analysis tool execution for a durable chat job."""

import asyncio
import json
import unicodedata
from contextlib import suppress
from typing import TYPE_CHECKING, Any, cast

from fastapi import HTTPException
from jinja2 import Environment
from sqlalchemy import select, text

from app.analysis_schemas import SectionOperation
from app.chat_models import ChatMessage, ChatThread, Job
from app.ids import new_ulid
from app.llm import adapters
from app.services import analyses
from app.services.normalizer import normalize
from app.services.settings import now, redact_credential, safe_verification_error
from app.settings_models import Run

if TYPE_CHECKING:
    from fastapi import FastAPI

MAX_CALLS = 8
CALL_SECONDS = 180
JOB_SECONDS = 600
OUTPUT_CHAR_LIMIT = 200_000
MAX_CONTEXT_CHARS = 200_000


class ContextLimitError(Exception):
    """The next full protocol request exceeds the local context bound."""


class OutputLimitError(Exception):
    """The local visible-output bound was exceeded."""


EDIT_NAMES = {
    "update_analysis_section": "update_section",
    "insert_analysis_sections": "insert_sections",
    "delete_analysis_section": "delete_section",
    "update_analysis_preamble": "update_preamble",
}


def _tool_output(protocol: str, call_id: str, value: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(value, ensure_ascii=False)
    if protocol == "chat_completions":
        return {"role": "tool", "tool_call_id": call_id, "content": body}
    return {"type": "function_call_output", "call_id": call_id, "output": body}


def _redact_object(value: dict[str, Any], key: str | None) -> dict[str, Any]:
    encoded = json.dumps(value, ensure_ascii=False)
    return cast(dict[str, Any], json.loads(redact_credential(encoded, key) or encoded))


async def _authorized(app: "FastAPI", job_id: str, token: str) -> bool:
    from app.jobs.runtime import call_authorized

    return await call_authorized(app, job_id, token)


async def _invoke(
    app: "FastAPI",
    job_id: str,
    token: str,
    snapshot: adapters.CallSnapshot,
    key: str | None,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    *,
    tool_choice: str = "auto",
    call_seconds: float,
) -> adapters.ToolTurn:
    if (
        len(json.dumps({"messages": messages, "tools": tools}, ensure_ascii=False))
        > MAX_CONTEXT_CHARS
    ):
        raise ContextLimitError()
    async with app.state.chat_dispatch_lock:
        if not await _authorized(app, job_id, token):
            from app.jobs.runtime import finalize_stop

            await finalize_stop(app, job_id)
            raise asyncio.CancelledError()
        entered = asyncio.Event()

        async def call() -> adapters.ToolTurn:
            entered.set()
            return await adapters.complete_with_tools(
                snapshot,
                key,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                on_progress=lambda value: _progress(app, job_id, token, value),
            )

        task = asyncio.create_task(call())
        await entered.wait()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + call_seconds
    try:
        try:
            while not task.done():
                if not await _authorized(app, job_id, token):
                    task.cancel()
                    from app.jobs.runtime import finalize_stop

                    await finalize_stop(app, job_id)
                    raise asyncio.CancelledError()
                if loop.time() >= deadline:
                    task.cancel()
                    raise TimeoutError()
                await asyncio.wait({task}, timeout=0.05)
            if not await _authorized(app, job_id, token):
                from app.jobs.runtime import finalize_stop

                await finalize_stop(app, job_id)
                raise asyncio.CancelledError()
            return task.result()
        finally:
            if not task.done():
                task.cancel()
                with suppress(BaseException):
                    await task
    except asyncio.CancelledError:
        from app.jobs.runtime import finalize_stop

        await finalize_stop(app, job_id)
        raise


async def _remaining_budget(app: "FastAPI", job_id: str) -> tuple[int, float]:
    async with app.state.session_factory() as session:
        job = await session.get(Job, job_id)
        if job is None:
            return 0, 0.0
        count = len((await session.scalars(select(Run.id).where(Run.job_id == job_id))).all())
        state: dict[str, Any] = job.execution_state or {}
        used = float(state.get("model_seconds", 0.0))
        return MAX_CALLS - count + 1, max(0.0, JOB_SECONDS - used)


async def _finish_run(
    app: "FastAPI",
    job_id: str,
    token: str,
    turn: adapters.ToolTurn,
    messages: list[dict[str, Any]],
    *,
    error: str | None = None,
    persist_messages: bool = True,
    elapsed: float = 0.0,
) -> bool:
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return False
        run = await session.scalar(
            select(Run)
            .where(Run.job_id == job_id, Run.status == "running")
            .order_by(Run.created_at.desc(), Run.id.desc())
        )
        if run is None:
            return False
        terminal_error = error or (
            "模型未返回完整的可见文本" if not turn.calls and not turn.text.strip() else None
        )
        run.status = "failed" if terminal_error else "succeeded"
        run.output_text = turn.text
        run.usage = turn.usage
        run.raw_response = turn.raw_response
        run.error = terminal_error
        run.finished_at = now()
        state = dict(job.execution_state or {})
        if persist_messages:
            state["protocol_messages"] = messages
        state["model_seconds"] = float(state.get("model_seconds", 0.0)) + elapsed
        state["active_step"] = "tool_dispatch" if turn.calls else "answering"
        job.execution_state = state
        job.version += 1
        await session.commit()
        return True


async def _next_run(
    app: "FastAPI",
    job_id: str,
    token: str,
    messages: list[dict[str, Any]],
    *,
    purpose: str = "chat",
    prompt_version: str | None = None,
) -> bool:
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return False
        model = job.model_snapshot
        created = now()
        session.add(
            Run(
                id=new_ulid(),
                purpose=purpose,
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
                prompt_version=prompt_version or job.input_snapshot["prompt_version"],
                prompt_text="",
                base_url=model["base_url"],
                credential_ref=job.credential_ref,
                temperature=model["temperature"],
                max_output_tokens=model["max_output_tokens"],
                reasoning_effort=model["reasoning_effort"],
                raw_response=None,
                created_at=created,
                started_at=created,
                finished_at=None,
            )
        )
        await session.commit()
        return True


async def _terminate(
    app: "FastAPI",
    job_id: str,
    token: str,
    *,
    result: adapters.GenerateResult | None = None,
    error_code: str | None = None,
    error: str | None = None,
    messages: list[dict[str, Any]] | None = None,
) -> None:
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return
        thread = await session.get(ChatThread, job.thread_id)
        assistant = await session.scalar(
            select(ChatMessage).where(ChatMessage.job_id == job_id, ChatMessage.role == "assistant")
        )
        if thread is None or assistant is None or thread.active_job_id != job_id:
            return
        complete = (
            result is not None
            and result.completed
            and bool(result.text.strip())
            and error_code is None
        )
        if not complete and error_code is None:
            error_code, error = "incomplete_output", "模型未返回完整的可见文本"
        status = "succeeded" if complete else "failed"
        timestamp = now()
        job.status = status
        job.error_code, job.error = error_code, error
        job.finished_at = timestamp
        job.execution_token = None
        job.version += 1
        state = dict(job.execution_state or {})
        if messages is not None:
            state["protocol_messages"] = messages
        state["active_step"] = "complete" if complete else "failed"
        job.execution_state = state
        assistant.content = result.text if complete and result is not None else assistant.content
        assistant.status = "complete" if complete else "failed"
        assistant.updated_at = timestamp
        run = await session.scalar(
            select(Run)
            .where(Run.job_id == job_id, Run.status == "running")
            .order_by(Run.created_at.desc(), Run.id.desc())
        )
        if run is not None:
            run.status = status
            run.error = error
            run.finished_at = timestamp
        thread.active_job_id = None
        thread.revision += 1
        thread.updated_at = timestamp
        await session.commit()


async def _progress(app: "FastAPI", job_id: str, token: str, text_value: str) -> None:
    if len(text_value) > OUTPUT_CHAR_LIMIT:
        raise OutputLimitError()
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return
        assistant = await session.scalar(
            select(ChatMessage).where(ChatMessage.job_id == job_id, ChatMessage.role == "assistant")
        )
        if assistant is None:
            return
        assistant.content = text_value
        assistant.updated_at = now()
        run = await session.scalar(
            select(Run)
            .where(Run.job_id == job_id, Run.status == "running")
            .order_by(Run.created_at.desc(), Run.id.desc())
        )
        if run is not None:
            run.output_text = text_value
        job.version += 1
        await session.commit()


async def _persist_messages(
    app: "FastAPI", job_id: str, token: str, messages: list[dict[str, Any]]
) -> None:
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        if job is None or job.status != "running" or job.execution_token != token:
            return
        state = dict(job.execution_state or {})
        state["protocol_messages"] = messages
        job.execution_state = state
        run = await session.scalar(
            select(Run)
            .where(Run.job_id == job_id, Run.status == "running")
            .order_by(Run.created_at.desc(), Run.id.desc())
        )
        if run is not None:
            run.messages = messages
        await session.commit()


async def _branch(
    app: "FastAPI",
    job: Job,
    token: str,
    key: str | None,
    snapshot: adapters.CallSnapshot,
    messages: list[dict[str, Any]],
    call_id: str,
    tools: list[dict[str, Any]],
    title: str | None = None,
) -> dict[str, Any]:
    """Start a real delegation, close its protocol call, then append writer suffix."""
    start = _tool_output(
        snapshot.protocol,
        call_id,
        {"status": "delegated", "message": "内部生成已开始；完成后核对保存结果"},
    )
    branch_messages = [
        *messages,
        start,
        {"role": "user", "content": job.input_snapshot["writer_text"]},
    ]
    available, remaining = await _remaining_budget(app, job.id)
    if available <= 1 or remaining <= 0:
        return {"error": "budget_exhausted"}
    if not await _next_run(
        app,
        job.id,
        token,
        branch_messages,
        purpose="analysis",
        prompt_version=(
            job.input_snapshot["prompt_version"] + f"+writer_{job.input_snapshot['writer_version']}"
        ),
    ):
        return {"error": "job_stopped"}
    began = asyncio.get_running_loop().time()
    turn = await _invoke(
        app,
        job.id,
        token,
        snapshot,
        key,
        branch_messages,
        tools,
        tool_choice="none",
        call_seconds=min(CALL_SECONDS, remaining),
    )
    elapsed = asyncio.get_running_loop().time() - began
    if (
        not turn.completed
        or turn.calls
        or not turn.text.strip()
        or len(turn.text) > OUTPUT_CHAR_LIMIT
    ):
        await _finish_run(
            app,
            job.id,
            token,
            turn,
            branch_messages,
            error="讲解生成未完整结束",
            elapsed=elapsed,
            persist_messages=False,
        )
        return {"error": "incomplete_output"}
    branch_messages.extend(turn.history_items)
    if not await _finish_run(
        app, job.id, token, turn, branch_messages, persist_messages=False, elapsed=elapsed
    ):
        return {"error": "job_stopped"}
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        current = await session.get(Job, job.id)
        thread = await session.get(ChatThread, job.thread_id)
        if (
            current is None
            or thread is None
            or current.status != "running"
            or current.execution_token != token
            or thread.active_job_id != job.id
        ):
            return {"error": "job_stopped"}
        detail = await analyses.create_analysis(
            session,
            segment_id=thread.segment_id,
            source_md=turn.text,
            operation_key=f"job:{job.id}:generate:{call_id}",
            origin="agent",
            title=title,
            run_id=(
                await session.scalar(
                    select(Run.id)
                    .where(Run.job_id == job.id, Run.purpose == "analysis")
                    .order_by(Run.created_at.desc(), Run.id.desc())
                )
            ),
        )
        state = dict(current.execution_state or {})
        artifacts = list(state.get("artifacts", []))
        artifact = {"analysis_id": detail.id, "revision_id": detail.revision_id}
        artifacts.append(artifact)
        state["artifacts"] = artifacts
        current.execution_state = state
        assistant = await session.scalar(
            select(ChatMessage).where(ChatMessage.job_id == job.id, ChatMessage.role == "assistant")
        )
        if assistant is not None:
            assistant.content = f"已保存讲解：Analysis {detail.id}，Revision {detail.revision_id}。"
            assistant.updated_at = now()
        await session.commit()
        return {"status": "saved", "title": detail.title, **artifact}


async def _read_tool(
    app: "FastAPI", segment_id: str, name: str, args: dict[str, Any]
) -> dict[str, Any]:
    async with app.state.session_factory() as session:
        if name == "list_analyses":
            limit = max(1, min(50, int(args.get("limit", 20))))
            offset = max(0, int(args.get("offset", 0)))
            items = await analyses.list_analyses(
                session, segment_id, limit=limit + 1, offset=offset
            )
            return {
                "items": [item.model_dump(mode="json") for item in items[:limit]],
                "next_offset": offset + limit if len(items) > limit else None,
            }
        detail = await analyses.get_analysis(session, args["analysis_id"], args.get("revision_id"))
        if detail.segment_id != segment_id:
            raise HTTPException(status_code=404, detail="讲解不属于当前片段")
        result = detail.model_dump(mode="json")
        selected = args.get("section_ids")
        if selected is not None:
            if not isinstance(selected, list):
                raise ValueError("section_ids须为uid数组")
            selected_values = cast(list[object], selected)
            if not all(isinstance(value, str) for value in selected_values):
                raise ValueError("section_ids须为uid数组")
            result["sections"] = [
                row for row in result["sections"] if row["uid"] in selected_values
            ]
        result.pop("source_md", None)
        return result


def _operation(name: str, args: dict[str, Any]) -> SectionOperation:
    values = {
        key: value for key, value in args.items() if key not in {"analysis_id", "base_revision_id"}
    }
    return SectionOperation.model_validate({"kind": EDIT_NAMES[name], **values})


async def _proposal(
    app: "FastAPI", segment_id: str, name: str, call_id: str, args: dict[str, Any]
) -> dict[str, Any]:
    operation = _operation(name, args)
    async with app.state.session_factory() as session:
        record = await analyses.get_analysis(session, args["analysis_id"], args["base_revision_id"])
        if record.segment_id != segment_id:
            raise HTTPException(status_code=404, detail="讲解不属于当前片段")
        detail = record.model_dump(mode="json")
    target = next((row for row in detail["sections"] if row["uid"] == operation.sid), None)
    before = target["raw"] if target is not None else ""
    if operation.kind == "insert_sections":
        insert_raw: list[str] = []
        for row in operation.sections or []:
            raw = f"## {row.title}\n"
            if row.body:
                raw += "\n" + row.body.lstrip("\r\n")
                if not raw.endswith(("\n", "\r")):
                    raw += "\n"
            insert_raw.append(raw)
        after = "".join(insert_raw)
    elif operation.kind == "delete_section":
        after = ""
    elif operation.kind == "update_preamble":
        before = next((row["raw"] for row in detail["sections"] if row["kind"] == "preamble"), "")
        after = operation.body or ""
    else:
        if target is None:
            raise HTTPException(status_code=404, detail="目标块不存在")
        index = next(
            index for index, row in enumerate(detail["sections"]) if row["uid"] == operation.sid
        )
        after = analyses.preview_section_replacement(
            normalize(detail["source_md"]).blocks[index], operation.title, operation.body
        )
        if index < len(detail["sections"]) - 1 and after and not after.endswith(("\n", "\r")):
            after += "\n"
    if operation.kind == "update_preamble" and len(detail["sections"]) > 1:
        if after and not after.endswith(("\n", "\r")):
            after += "\n"
    return {
        "tool_call_id": call_id,
        "tool_name": name,
        "analysis_id": args["analysis_id"],
        "base_revision_id": args["base_revision_id"],
        "title": detail["title"],
        "before": before,
        "after": after,
        "operation": operation.model_dump(mode="json"),
    }


async def _apply(
    app: "FastAPI", job_id: str, token: str, segment_id: str, proposal: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(proposal.get("source_run_id"), str):
        raise ValueError("审核方案缺少来源调用")
    async with app.state.session_factory() as session:
        await session.execute(text("BEGIN IMMEDIATE"))
        job = await session.get(Job, job_id)
        thread = await session.get(ChatThread, job.thread_id) if job is not None else None
        if (
            job is None
            or thread is None
            or job.status != "running"
            or job.execution_token != token
            or thread.active_job_id != job_id
        ):
            return {"error": "job_stopped"}
        detail = await analyses.apply_operation(
            session,
            segment_id=segment_id,
            analysis_id=proposal["analysis_id"],
            base_revision_id=proposal["base_revision_id"],
            operation_key=f"job:{job_id}:edit:{proposal['tool_call_id']}",
            operation=SectionOperation.model_validate(proposal["operation"]),
            run_id=proposal["source_run_id"],
        )
        state = dict(job.execution_state or {})
        artifacts = list(state.get("artifacts", []))
        artifact = {"analysis_id": detail.id, "revision_id": detail.revision_id}
        artifacts.append(artifact)
        state["artifacts"] = artifacts
        job.execution_state = state
        await session.commit()
        return {"status": "saved", "title": detail.title, **artifact}


async def execute_agent_job(
    app: "FastAPI", job_id: str, token: str, key: str | None, snapshot: adapters.CallSnapshot
) -> None:
    async with app.state.session_factory() as session:
        job = await session.get(Job, job_id)
        if job is None:
            return
        thread = await session.get(ChatThread, job.thread_id)
        if thread is None:
            return
        segment_id = thread.segment_id
        state = dict(job.execution_state or {})
        tools = list(job.input_snapshot["tools"])
        messages: list[dict[str, Any]] = list(
            state.get("protocol_messages") or snapshot.messages or []
        )
        raw_proposal = state.get("review_proposal")
        proposal = cast(dict[str, Any], raw_proposal) if isinstance(raw_proposal, dict) else None
        decision = state.get("decision")
    if isinstance(proposal, dict) and decision in {"approve", "reject"}:
        try:
            instructions = state.get("decision_instructions", "")
            if decision == "approve" and not instructions:
                output = await _apply(app, job_id, token, segment_id, proposal)
            elif decision == "approve":
                output = {"status": "revision_requested", "additional_instructions": instructions}
            else:
                output = {"status": "rejected", "additional_instructions": instructions}
        except (HTTPException, ValueError) as exc:
            output = {"error": str(exc)}
        messages.append(_tool_output(snapshot.protocol, proposal["tool_call_id"], output))
        async with app.state.session_factory() as session:
            await session.execute(text("BEGIN IMMEDIATE"))
            job = await session.get(Job, job_id)
            if job is None or job.status != "running" or job.execution_token != token:
                return
            state = dict(job.execution_state or {})
            state["review_proposal"] = None
            state["protocol_messages"] = messages
            job.execution_state = state
            await session.commit()
        await _persist_messages(app, job_id, token, messages)
    needs_run = False
    while True:
        available, remaining = await _remaining_budget(app, job_id)
        if available <= (1 if needs_run else 0) or remaining <= 0:
            await _terminate(
                app,
                job_id,
                token,
                error_code="budget_exhausted",
                error="本轮模型调用预算已用尽",
                messages=messages,
            )
            return
        if needs_run and not await _next_run(app, job_id, token, messages):
            return
        needs_run = False
        try:
            began = asyncio.get_running_loop().time()
            turn = await _invoke(
                app,
                job_id,
                token,
                snapshot,
                key,
                messages,
                tools,
                call_seconds=min(CALL_SECONDS, remaining),
            )
            elapsed = asyncio.get_running_loop().time() - began
        except asyncio.CancelledError:
            return
        except TimeoutError:
            await _terminate(
                app,
                job_id,
                token,
                error_code="timeout",
                error="模型调用超时（180 秒）",
                messages=messages,
            )
            return
        except ContextLimitError:
            await _terminate(
                app,
                job_id,
                token,
                error_code="context_limit",
                error="上下文超过本地上限",
                messages=messages,
            )
            return
        except OutputLimitError:
            await _terminate(
                app,
                job_id,
                token,
                error_code="output_limit",
                error="回答超过本地长度上限",
                messages=messages,
            )
            return
        except Exception as exc:
            await _terminate(
                app,
                job_id,
                token,
                error_code="provider_error",
                error=safe_verification_error(exc),
                messages=messages,
            )
            return
        if len(turn.text) > OUTPUT_CHAR_LIMIT:
            await _terminate(
                app,
                job_id,
                token,
                error_code="output_limit",
                error="回答超过本地长度上限",
                messages=messages,
            )
            return
        if not turn.completed:
            await _finish_run(
                app,
                job_id,
                token,
                turn,
                messages,
                error="模型输出不完整或超过长度上限",
                elapsed=elapsed,
            )
            await _terminate(
                app,
                job_id,
                token,
                error_code="incomplete_output",
                error="模型输出不完整或超过长度上限",
                messages=messages,
            )
            return
        messages.extend(turn.history_items)
        if not await _finish_run(app, job_id, token, turn, messages, elapsed=elapsed):
            return
        if not turn.calls:
            await _terminate(
                app,
                job_id,
                token,
                result=adapters.GenerateResult(
                    turn.text, bool(turn.text.strip()), turn.usage, turn.raw_response
                ),
                messages=messages,
            )
            return
        if len(turn.calls) != 1:
            for call in turn.calls:
                messages.append(
                    _tool_output(
                        snapshot.protocol,
                        call["id"],
                        {
                            "error": "parallel_tool_calls_unsupported",
                            "message": "请一次只调用一个工具，上一批均未执行",
                        },
                    )
                )
            await _persist_messages(app, job_id, token, messages)
            needs_run = True
            continue
        for call in turn.calls:
            name = call["name"]
            try:
                args = cast(object, json.loads(call["arguments"]))
                if not isinstance(args, dict):
                    raise ValueError("工具参数不是对象")
                args = cast(dict[str, Any], args)
                if name in {"list_analyses", "read_analysis"}:
                    output = await _read_tool(app, segment_id, name, args)
                elif name == "generate_analysis":
                    if set(args) - {"title"}:
                        raise ValueError("生成工具只接受title参数，不接受正文或上下文")
                    title: str | None = None
                    if "title" in args:
                        value = args["title"]
                        if not isinstance(value, str):
                            raise ValueError("讲解总标题须为字符串")
                        title = unicodedata.normalize("NFC", value.strip())
                        if not title or len(title) > 200:
                            raise ValueError("讲解总标题须非空且不超过200字符")
                    async with app.state.session_factory() as session:
                        job = await session.get(Job, job_id)
                        if job is None:
                            return
                        output = await _branch(
                            app, job, token, key, snapshot, messages, call["id"], tools, title
                        )
                elif name in EDIT_NAMES:
                    proposal = await _proposal(app, segment_id, name, call["id"], args)
                    if key and redact_credential(
                        json.dumps(proposal, ensure_ascii=False), key
                    ) != json.dumps(proposal, ensure_ascii=False):
                        raise ValueError("审核内容包含当前模型凭据")
                    async with app.state.session_factory() as session:
                        job = await session.get(Job, job_id)
                        if job is None:
                            return
                        proposal["source_run_id"] = await session.scalar(
                            select(Run.id)
                            .where(Run.job_id == job_id, Run.purpose == "chat")
                            .order_by(Run.created_at.desc(), Run.id.desc())
                        )
                        if not isinstance(proposal["source_run_id"], str):
                            raise ValueError("无法定位编辑方案的模型调用")
                        review = job.permission_mode == "review"
                    if review:
                        async with app.state.session_factory() as session:
                            await session.execute(text("BEGIN IMMEDIATE"))
                            job = await session.get(Job, job_id)
                            if (
                                job is None
                                or job.status != "running"
                                or job.execution_token != token
                            ):
                                return
                            state = dict(job.execution_state or {})
                            state["review_proposal"] = proposal
                            state["decision_request"] = None
                            state["decision"] = None
                            state["decision_instructions"] = ""
                            state["protocol_messages"] = messages
                            state["active_step"] = "waiting_review"
                            job.execution_state = state
                            job.status = "waiting_review"
                            job.execution_token = None
                            job.version += 1
                            await session.commit()
                        return
                    output = await _apply(app, job_id, token, segment_id, proposal)
                else:
                    output = {"error": "unknown_tool"}
            except TimeoutError:
                await _terminate(
                    app,
                    job_id,
                    token,
                    error_code="timeout",
                    error="讲解分支模型调用超时",
                    messages=messages,
                )
                return
            except asyncio.CancelledError:
                return
            except ContextLimitError:
                await _terminate(
                    app,
                    job_id,
                    token,
                    error_code="context_limit",
                    error="分支上下文超过本地上限",
                    messages=messages,
                )
                return
            except (ValueError, KeyError, TypeError, HTTPException) as exc:
                output = {"error": str(exc)}
            except Exception as exc:
                await _terminate(
                    app,
                    job_id,
                    token,
                    error_code="tool_error",
                    error=safe_verification_error(exc),
                    messages=messages,
                )
                return
            messages.append(
                _tool_output(snapshot.protocol, call["id"], _redact_object(output, key))
            )
        await _persist_messages(app, job_id, token, messages)
        needs_run = True


async def execute_quick_job(
    app: "FastAPI", job_id: str, token: str, key: str | None, snapshot: adapters.CallSnapshot
) -> None:
    """Generate a document directly from the accepted user turn and writer suffix."""
    from app.jobs.runtime import _finish  # pyright: ignore[reportPrivateUsage]

    messages = list(snapshot.messages or [])
    try:
        turn = await _invoke(
            app,
            job_id,
            token,
            snapshot,
            key,
            messages,
            snapshot.tools or [],
            tool_choice="none",
            call_seconds=CALL_SECONDS,
        )
    except asyncio.CancelledError:
        return
    except TimeoutError:
        await _finish(
            app,
            job_id,
            token,
            result=None,
            error_code="timeout",
            error="模型调用超时（180 秒）",
            partial="",
            key=key,
        )
        return
    except ContextLimitError:
        await _finish(
            app,
            job_id,
            token,
            result=None,
            error_code="context_limit",
            error="上下文超过本地上限",
            partial="",
            key=key,
        )
        return
    except OutputLimitError:
        await _finish(
            app,
            job_id,
            token,
            result=None,
            error_code="output_limit",
            error="讲解超过本地长度上限",
            partial="",
            key=key,
        )
        return
    except Exception as exc:
        await _finish(
            app,
            job_id,
            token,
            result=None,
            error_code="provider_error",
            error=safe_verification_error(exc),
            partial="",
            key=key,
        )
        return
    if len(turn.text) > OUTPUT_CHAR_LIMIT:
        await _finish(
            app,
            job_id,
            token,
            result=None,
            error_code="output_limit",
            error="讲解超过本地长度上限",
            partial="",
            key=key,
        )
        return
    if turn.completed and not turn.calls:
        result = adapters.GenerateResult(
            turn.text, bool(turn.text.strip()), turn.usage, turn.raw_response
        )
        try:
            await _finish(
                app, job_id, token, result=result, error_code=None, error=None, partial="", key=key
            )
            async with app.state.session_factory() as session:
                await session.execute(text("BEGIN IMMEDIATE"))
                job = await session.get(Job, job_id)
                assistant = await session.scalar(
                    select(ChatMessage).where(
                        ChatMessage.job_id == job_id, ChatMessage.role == "assistant"
                    )
                )
                if job is not None and job.status == "succeeded" and assistant is not None:
                    state = dict(job.execution_state or {})
                    artifact_fact = (
                        Environment(autoescape=False)
                        .from_string(job.input_snapshot["saved_artifact_template"])
                        .render(
                            artifacts_json=json.dumps(
                                state.get("artifacts", []), ensure_ascii=False
                            )
                        )
                        .strip()
                    )
                    state["protocol_messages"] = [
                        *job.input_snapshot["messages"],
                        {"role": "user", "content": artifact_fact},
                    ]
                    job.execution_state = state
                    await session.commit()
        except (HTTPException, ValueError) as exc:
            await _finish(
                app,
                job_id,
                token,
                result=None,
                error_code="save_failed",
                error=str(exc),
                partial="",
                key=key,
            )
    else:
        await _finish(
            app,
            job_id,
            token,
            result=None,
            error_code="incomplete_output",
            error="讲解生成未完整结束",
            partial=turn.text,
            key=key,
        )
