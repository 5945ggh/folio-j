import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { queries, RequestError, type Segment } from "../content";
import { InlineError } from "../Shared";
import { getProviders, getSettings, settingsKeys } from "../settings/api";
import {
	chatKeys,
	createThread,
	getJob,
	getJobByRequest,
	getThread,
	type Job,
	type JobInput,
	listMessages,
	listThreads,
	type Message,
	patchThread,
	stopJob,
	submitJob,
	type Thread,
} from "./api";

import {
	type Draft,
	draftAfterAcceptance,
	submissionMayHaveSucceeded,
	threadChanged,
} from "./state";

type Pending = { input: JobInput; uncertain: boolean };
const emptyDraft: Draft = { question: "", additional: "" };
const terminal = new Set<Job["status"]>(["succeeded", "failed", "interrupted"]);

function jobLabel(job: Job): string {
	switch (job.status) {
		case "queued":
			return "排队中";
		case "running":
			return "回答中";
		case "stopping":
			return "正在停止";
		case "succeeded":
			return "已完成";
		case "failed":
			return "失败";
		case "interrupted":
			return "已中断";
	}
}

function FailedJob({
	jobId,
	onRetry,
}: {
	jobId: string;
	onRetry: (draft: Draft) => void;
}) {
	const job = useQuery({
		queryKey: chatKeys.job(jobId),
		queryFn: () => getJob(jobId),
	});
	return (
		<div className="chat-failure-detail">
			{job.data?.error && <p role="alert">{job.data.error}</p>}
			{job.isError && <InlineError error={job.error} />}
			{job.data && (
				<button
					className="button secondary"
					type="button"
					onClick={() =>
						onRetry({
							question: job.data.question,
							additional: job.data.additional_instructions,
						})
					}
				>
					把原问题放回输入框
				</button>
			)}
		</div>
	);
}

function MessageItem({
	message,
	activeJob,
	onRetry,
}: {
	message: Message;
	activeJob?: Job;
	onRetry: (draft: Draft) => void;
}) {
	const current =
		activeJob?.assistant_message.id === message.id
			? activeJob.assistant_message
			: message;
	return (
		<article className={`chat-message ${current.role}`}>
			<div className="chat-message-heading">
				<strong>{current.role === "user" ? "你" : "助手"}</strong>
				{current.role === "assistant" && current.status !== "complete" && (
					<span>
						{activeJob && activeJob.assistant_message.id === current.id
							? jobLabel(activeJob)
							: current.status === "failed"
								? "失败"
								: current.status === "interrupted"
									? "已中断"
									: "回答中"}
					</span>
				)}
			</div>
			{current.content ? (
				<p className="chat-message-content">{current.content}</p>
			) : current.role === "assistant" ? (
				<p className="chat-placeholder">等待回答…</p>
			) : null}
			{current.role === "assistant" &&
				(current.status === "failed" || current.status === "interrupted") && (
					<FailedJob jobId={current.job_id} onRetry={onRetry} />
				)}
		</article>
	);
}

function ThreadPanel({
	segment,
	threadId,
	draft,
	setDraft,
	pending,
	setPending,
}: {
	segment: Segment;
	threadId: string;
	draft: Draft;
	setDraft: (draft: Draft | ((current: Draft) => Draft)) => void;
	pending: Pending | null;
	setPending: (pending: Pending | null) => void;
}) {
	const client = useQueryClient();
	const thread = useQuery({
		queryKey: chatKeys.thread(threadId),
		queryFn: async () => {
			const fresh = await getThread(threadId);
			const previous = client.getQueryData<Thread>(chatKeys.thread(threadId));
			return previous && previous.revision > fresh.revision ? previous : fresh;
		},
		refetchInterval: 2000,
	});
	const history = useInfiniteQuery({
		queryKey: chatKeys.messages(threadId),
		queryFn: ({ pageParam }) => listMessages(threadId, pageParam),
		initialPageParam: 0,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	useEffect(() => {
		if (history.hasNextPage && !history.isFetchingNextPage)
			void history.fetchNextPage();
	}, [history.hasNextPage, history.isFetchingNextPage, history.fetchNextPage]);
	const jobId = thread.data?.active_job_id;
	const active = useQuery({
		queryKey: chatKeys.job(jobId ?? ""),
		queryFn: async () => {
			const fresh = await getJob(jobId ?? "");
			const previous = client.getQueryData<Job>(chatKeys.job(jobId ?? ""));
			return previous && previous.version > fresh.version ? previous : fresh;
		},
		enabled: Boolean(jobId),
		refetchInterval: (query) =>
			query.state.data && terminal.has(query.state.data.status) ? false : 1000,
	});
	const pendingCheck = useQuery({
		queryKey: chatKeys.request(threadId, pending?.input.request_id ?? ""),
		queryFn: () => getJobByRequest(threadId, pending?.input.request_id ?? ""),
		enabled: Boolean(pending?.uncertain),
		retry: false,
		refetchInterval: pending?.uncertain ? 1000 : false,
	});
	const settings = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
	});
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
	});
	const [style, setStyle] = useState("");
	const [stream, setStream] = useState(true);
	const [sendError, setSendError] = useState<Error | null>(null);
	const [sending, setSending] = useState(false);
	const seenTerminal = useRef<string | null>(null);
	const seenThread = useRef<Pick<Thread, "revision" | "active_job_id"> | null>(
		null,
	);
	const models =
		providers.data?.flatMap((provider) =>
			provider.models.map((model) => ({ provider, model })),
		) ?? [];
	const chosen = models.find(
		({ model }) => model.id === thread.data?.selected_model_id,
	);
	const usable = chosen?.provider.enabled && chosen.model.enabled;
	const busy =
		Boolean(thread.data?.active_job_id) || Boolean(pending) || sending;
	const messages = history.data?.pages.flatMap((page) => page.items) ?? [];
	const visibleMessages =
		active.data &&
		!messages.some((m) => m.id === active.data.assistant_message.id)
			? [...messages, active.data.assistant_message].sort(
					(a, b) => a.ordinal - b.ordinal,
				)
			: messages;

	useEffect(() => {
		if (!pendingCheck.data || !pending?.uncertain) return;
		client.setQueryData(
			chatKeys.job(pendingCheck.data.id),
			(old: Job | undefined) =>
				old && old.version > pendingCheck.data.version
					? old
					: pendingCheck.data,
		);
		setPending(null);
		setDraft((current) => draftAfterAcceptance(current, pending.input));
		setSendError(null);
		void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
		void client.invalidateQueries({ queryKey: chatKeys.messages(threadId) });
		void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
	}, [
		pendingCheck.data,
		pending?.uncertain,
		pending?.input,
		client,
		threadId,
		segment.id,
		setPending,
		setDraft,
	]);
	useEffect(() => {
		if (!thread.data) return;
		if (threadChanged(seenThread.current, thread.data)) {
			void client.invalidateQueries({ queryKey: chatKeys.messages(threadId) });
			void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
			void client.invalidateQueries({ queryKey: queries.segment(segment.id) });
		}
		seenThread.current = {
			revision: thread.data.revision,
			active_job_id: thread.data.active_job_id,
		};
	}, [thread.data, client, threadId, segment.id]);
	useEffect(() => {
		const job = active.data;
		if (!job || !terminal.has(job.status) || seenTerminal.current === job.id)
			return;
		seenTerminal.current = job.id;
		void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
		void client.invalidateQueries({ queryKey: chatKeys.messages(threadId) });
		void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
		void client.invalidateQueries({ queryKey: queries.segment(segment.id) });
	}, [active.data, client, threadId, segment.id]);

	const patch = useMutation({
		mutationFn: (input: Parameters<typeof patchThread>[1]) =>
			patchThread(threadId, input),
		onSuccess: (updated) =>
			client.setQueryData(chatKeys.thread(threadId), updated),
		onError: () =>
			void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) }),
	});
	const stop = useMutation({
		mutationFn: (id: string) => stopJob(id),
		onSuccess: (updated) => {
			client.setQueryData(chatKeys.job(updated.id), (old: Job | undefined) =>
				old && old.version > updated.version ? old : updated,
			);
			void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
		},
	});

	async function send(input: JobInput) {
		if (sending) return;
		setSending(true);
		setSendError(null);
		try {
			const accepted = await submitJob(threadId, input);
			client.setQueryData(chatKeys.job(accepted.id), (old: Job | undefined) =>
				old && old.version > accepted.version ? old : accepted,
			);
			setPending(null);
			setDraft((current) => draftAfterAcceptance(current, input));
			void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
			void client.invalidateQueries({ queryKey: chatKeys.messages(threadId) });
			void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
			void client.invalidateQueries({ queryKey: queries.segment(segment.id) });
		} catch (error) {
			const uncertain = submissionMayHaveSucceeded(error);
			if (uncertain) setPending({ input, uncertain: true });
			else {
				setPending(null);
				void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
				void client.invalidateQueries({
					queryKey: queries.segment(segment.id),
				});
			}
			setSendError(error instanceof Error ? error : new Error("提交失败"));
		} finally {
			setSending(false);
		}
	}

	function makeInput(current: Thread): JobInput {
		return {
			request_id: crypto.randomUUID(),
			expected_thread_revision: current.revision,
			expected_segment_revision: segment.revision,
			question: draft.question,
			additional_instructions: draft.additional,
			stream,
			...(style === "none"
				? { style_id: null }
				: style
					? { style_id: style }
					: {}),
		};
	}

	if (thread.isPending) return <p className="loading">正在加载讨论…</p>;
	if (thread.isError)
		return (
			<div className="state-card">
				<InlineError error={thread.error} />
				<button
					className="button secondary"
					type="button"
					onClick={() => void thread.refetch()}
				>
					重试
				</button>
			</div>
		);

	return (
		<div className="chat-panel">
			<div className="chat-controls">
				<label>
					模型
					<select
						value={thread.data.selected_model_id ?? ""}
						disabled={busy || patch.isPending}
						onChange={(event) =>
							patch.mutate({
								expected_revision: thread.data.revision,
								model_id: event.target.value || null,
							})
						}
					>
						<option value="">请选择模型</option>
						{thread.data.selected_model_id && !chosen && (
							<option value={thread.data.selected_model_id}>
								原模型已不可用
							</option>
						)}
						{models
							.filter(
								({ provider, model }) => provider.enabled && model.enabled,
							)
							.map(({ provider, model }) => (
								<option key={model.id} value={model.id}>
									{provider.name} / {model.model_id}
								</option>
							))}
					</select>
				</label>
				<label>
					讲解预设
					<select
						value={style}
						disabled={busy}
						onChange={(event) => setStyle(event.target.value)}
					>
						<option value="">
							使用当前默认{settings.data?.defaults.style_id ? "" : "（无）"}
						</option>
						<option value="none">本轮不使用</option>
						{settings.data?.styles.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
				</label>
				<label>
					权限
					<select
						value={thread.data.permission_mode}
						disabled={busy || patch.isPending}
						onChange={(event) =>
							patch.mutate({
								expected_revision: thread.data.revision,
								permission_mode: event.target
									.value as Thread["permission_mode"],
							})
						}
					>
						<option value="review">审核模式</option>
						<option value="full_access">Full access</option>
					</select>
				</label>
				<label className="chat-stream-choice">
					<input
						type="checkbox"
						checked={stream}
						disabled={busy}
						onChange={(event) => setStream(event.target.checked)}
					/>{" "}
					后台流式生成
				</label>
			</div>
			{!usable && providers.isSuccess && (
				<p className="chat-notice" role="alert">
					当前线程的模型未选或已停用。请选择可用模型后发送；系统不会自动替换原选择。
				</p>
			)}
			{chosen &&
				usable &&
				(stream ? chosen.model.stream_status : chosen.model.text_status) !==
					"succeeded" && (
					<p className="chat-notice">
						该模型的{stream ? "流式" : "普通文本"}验证状态为
						{(stream
							? chosen.model.stream_status
							: chosen.model.text_status) === "failed"
							? "失败"
							: "未知"}
						，仍可尝试本次问答。
					</p>
				)}
			<p className="chat-permission-note">
				此阶段仅进行文本问答，不调用写入工具；权限选择保存在本线程。
			</p>
			<InlineError error={patch.error} />
			<section className="chat-history" aria-label="讨论历史">
				{history.isPending && <p className="loading">正在加载历史…</p>}
				{history.isError && <InlineError error={history.error} />}
				{history.isFetchingNextPage && (
					<p className="loading">正在加载更早的消息…</p>
				)}
				{visibleMessages.length === 0 && !history.isPending && (
					<p className="chat-empty">
						围绕这段原文提出第一个问题，讨论会保存在本线程。
					</p>
				)}
				{active.data &&
					!messages.some(
						(message) => message.id === active.data.user_message_id,
					) && (
						<article className="chat-message user">
							<div className="chat-message-heading">
								<strong>你</strong>
							</div>
							<p className="chat-message-content">{active.data.question}</p>
						</article>
					)}
				{visibleMessages.map((message) => (
					<MessageItem
						key={message.id}
						message={message}
						activeJob={active.data}
						onRetry={setDraft}
					/>
				))}
				{active.data?.status === "queued" && (
					<p className="chat-job-state" role="status">
						已保存问题，等待模型调用名额。
					</p>
				)}
				{active.data?.status === "stopping" && (
					<p className="chat-job-state" role="status">
						正在停止本轮…
					</p>
				)}
				{active.isError && <InlineError error={active.error} />}
			</section>
			<div className="chat-composer">
				<label htmlFor="chat-question">问题</label>
				<textarea
					id="chat-question"
					value={draft.question}
					maxLength={10000}
					rows={4}
					placeholder="想了解这段话的什么？"
					onChange={(event) =>
						setDraft({ ...draft, question: event.target.value })
					}
				/>
				<label htmlFor="chat-additional">本轮补充要求（可选）</label>
				<textarea
					id="chat-additional"
					value={draft.additional}
					maxLength={10000}
					rows={2}
					placeholder="例如：重点说明语气与使用场景"
					onChange={(event) =>
						setDraft({ ...draft, additional: event.target.value })
					}
				/>
				{pending?.uncertain && (
					<div className="chat-uncertain" role="status">
						<strong>正在核实提交</strong>
						<p>
							提交结果尚不确定。查询不会再次调用模型；重试会继续核实同一次提交。
						</p>
						<div className="actions">
							<button
								className="button secondary"
								type="button"
								onClick={() => void pendingCheck.refetch()}
							>
								查询结果
							</button>
							<button
								className="button secondary"
								type="button"
								disabled={sending}
								onClick={() => void send(pending.input)}
							>
								同请求重试提交
							</button>
						</div>
						{pendingCheck.isError &&
							!(
								pendingCheck.error instanceof RequestError &&
								pendingCheck.error.status === 404
							) && <InlineError error={pendingCheck.error} />}
					</div>
				)}
				<InlineError error={sendError} />
				<InlineError error={stop.error} />
				<div className="actions">
					<button
						className="button primary"
						type="button"
						disabled={
							busy ||
							!draft.question.trim() ||
							!usable ||
							!history.isSuccess ||
							!settings.isSuccess ||
							!providers.isSuccess
						}
						onClick={() => void send(makeInput(thread.data))}
					>
						{sending ? "提交中…" : "发送问题"}
					</button>
					{jobId && (
						<button
							className="button secondary"
							type="button"
							disabled={stop.isPending || active.data?.status === "stopping"}
							onClick={() => stop.mutate(jobId)}
						>
							{stop.isPending || active.data?.status === "stopping"
								? "停止中…"
								: "停止本轮"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export function Workbench({ segment }: { segment: Segment }) {
	const client = useQueryClient();
	const threads = useInfiniteQuery({
		queryKey: chatKeys.threads(segment.id),
		queryFn: ({ pageParam }) => listThreads(segment.id, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	const [selected, setSelected] = useState<string | null>(null);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [pending, setPending] = useState<Record<string, Pending | null>>({});
	const [createKey, setCreateKey] = useState<string | null>(null);
	const allThreads = threads.data?.pages.flatMap((page) => page.items) ?? [];
	useEffect(() => {
		if (!selected && allThreads[0]) setSelected(allThreads[0].id);
	}, [selected, allThreads]);
	const create = useMutation({
		mutationFn: (requestId: string) => createThread(segment.id, requestId),
		onSuccess: (item) => {
			setCreateKey(null);
			setSelected(item.id);
			void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
		},
	});
	return (
		<section className="workbench" aria-label="片段讨论工作台">
			<div className="section-heading">
				<div>
					<p className="eyebrow">WORKBENCH</p>
					<h2>讨论工作台</h2>
				</div>
				<button
					className="button secondary"
					type="button"
					disabled={create.isPending}
					onClick={() => {
						const key = createKey ?? crypto.randomUUID();
						setCreateKey(key);
						create.mutate(key);
					}}
				>
					新建对话
				</button>
			</div>
			<InlineError error={create.error} />
			<div className="workbench-grid">
				<aside className="chat-threads" aria-label="对话列表">
					{threads.isPending && <p className="loading">正在加载对话…</p>}
					{threads.isError && <InlineError error={threads.error} />}
					{allThreads.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`chat-thread ${selected === item.id ? "selected" : ""}`}
							onClick={() => setSelected(item.id)}
						>
							<span>{item.display_title}</span>
							<small>
								{new Date(item.updated_at).toLocaleDateString("zh-CN")}
								{item.active_job_id ? " · 进行中" : ""}
							</small>
						</button>
					))}
					{threads.hasNextPage && (
						<button
							className="button secondary"
							type="button"
							disabled={threads.isFetchingNextPage}
							onClick={() => void threads.fetchNextPage()}
						>
							{threads.isFetchingNextPage ? "加载中…" : "加载更多对话"}
						</button>
					)}
				</aside>
				<div className="chat-main">
					{selected ? (
						<ThreadPanel
							key={selected}
							segment={segment}
							threadId={selected}
							draft={drafts[selected] ?? emptyDraft}
							setDraft={(next) =>
								setDrafts((old) => ({
									...old,
									[selected]:
										typeof next === "function"
											? next(old[selected] ?? emptyDraft)
											: next,
								}))
							}
							pending={pending[selected] ?? null}
							setPending={(item) =>
								setPending((old) => ({ ...old, [selected]: item }))
							}
						/>
					) : (
						<div className="chat-empty">尚无对话。新建对话后可直接提问。</div>
					)}
				</div>
			</div>
		</section>
	);
}
