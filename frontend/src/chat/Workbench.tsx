import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { analysisKeys, getAnalysis } from "../analysis/api";
import { Markdown } from "../analysis/Markdown";
import { queries, RequestError, type Segment } from "../content";
import { InlineError } from "../Shared";
import { getProviders, getSettings, settingsKeys } from "../settings/api";
import {
	chatKeys,
	createThread,
	decideJob,
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
import { describeReview } from "./review";
import {
	type Draft,
	draftAfterAcceptance,
	submissionMayHaveSucceeded,
	threadChanged,
	usableThread,
} from "./state";

type Pending = { input: JobInput; uncertain: boolean };
const emptyDraft: Draft = { question: "", additional: "" };
const terminal = new Set<Job["status"]>(["succeeded", "failed", "interrupted"]);
const generationQuestion = "请为当前片段生成总体讲解。";

function jobLabel(job: Job): string {
	switch (job.status) {
		case "queued":
			return "排队中";
		case "running":
			return job.kind === "generate_analysis" ? "生成讲解中" : "回答中";
		case "waiting_review":
			return "等待审核";
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
	onOpenArtifact,
}: {
	message: Message;
	activeJob?: Job;
	onRetry: (draft: Draft) => void;
	onOpenArtifact: (analysisId: string, revisionId: string) => void;
}) {
	const savedJob = useQuery({
		queryKey: chatKeys.job(message.job_id),
		queryFn: () => getJob(message.job_id),
		enabled:
			message.role === "assistant" &&
			!["pending", "streaming"].includes(message.status) &&
			activeJob?.assistant_message.id !== message.id,
		staleTime: 30_000,
	});
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
				current.role === "assistant" ? (
					<div className="chat-message-content chat-markdown">
						<Markdown text={current.content} />
					</div>
				) : (
					<p className="chat-message-content">{current.content}</p>
				)
			) : current.role === "assistant" ? (
				<p className="chat-placeholder">
					{activeJob?.kind === "generate_analysis"
						? "正在生成讲解…"
						: "等待回答…"}
				</p>
			) : null}
			{current.role === "assistant" &&
				(activeJob?.assistant_message.id === current.id
					? activeJob
					: savedJob.data
				)?.artifacts?.map((artifact) =>
					artifact.analysis_id && artifact.revision_id ? (
						<button
							key={`${artifact.analysis_id}-${artifact.revision_id}`}
							type="button"
							className="chat-artifact-button"
							title={`讲解 ${artifact.analysis_id} · 修订 ${artifact.revision_id}`}
							onClick={() =>
								onOpenArtifact(artifact.analysis_id, artifact.revision_id)
							}
						>
							查看已保存讲解 · 修订 {artifact.revision_id.slice(-6)} →
						</button>
					) : null,
				)}
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
	quickGenerateToken,
	onGenerationAccepted,
	onOpenArtifact,
}: {
	segment: Segment;
	threadId: string;
	draft: Draft;
	setDraft: (draft: Draft | ((current: Draft) => Draft)) => void;
	pending: Pending | null;
	setPending: (pending: Pending | null) => void;
	quickGenerateToken: string | null;
	onGenerationAccepted: (job: Job) => void;
	onOpenArtifact: (analysisId: string, revisionId: string) => void;
}) {
	const client = useQueryClient();
	const thread = useQuery({
		queryKey: chatKeys.thread(threadId),
		queryFn: async () => {
			const fresh = await getThread(threadId);
			const previous = client.getQueryData<Thread>(chatKeys.thread(threadId));
			return previous && previous.revision > fresh.revision ? previous : fresh;
		},
		select: (item) => {
			if (item.segment_id !== segment.id)
				throw new Error("这条讨论不属于当前片段，请返回对话列表选择。");
			return item;
		},
		refetchInterval: 2000,
	});
	const history = useInfiniteQuery({
		queryKey: chatKeys.messages(threadId),
		enabled: thread.isSuccess,
		queryFn: ({ pageParam }) => listMessages(threadId, pageParam),
		initialPageParam: 0,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	useEffect(() => {
		if (history.hasNextPage && !history.isFetchingNextPage)
			void history.fetchNextPage();
	}, [history.hasNextPage, history.isFetchingNextPage, history.fetchNextPage]);
	const [recentJobId, setRecentJobId] = useState<string | null>(null);
	const jobId = thread.data?.active_job_id ?? recentJobId;
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
	const proposal = active.data?.review_proposal;
	const reviewAnalysisId =
		typeof proposal?.analysis_id === "string" ? proposal.analysis_id : "";
	const reviewRevisionId =
		typeof proposal?.base_revision_id === "string"
			? proposal.base_revision_id
			: "";
	const reviewBase = useQuery({
		queryKey: analysisKeys.detail(reviewAnalysisId, reviewRevisionId),
		queryFn: () => getAnalysis(reviewAnalysisId, reviewRevisionId),
		enabled:
			active.data?.status === "waiting_review" &&
			Boolean(reviewAnalysisId && reviewRevisionId),
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
	const quickHandled = useRef<string | null>(null);
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
		Boolean(thread.data?.active_job_id) ||
		Boolean(active.data && !terminal.has(active.data.status)) ||
		Boolean(pending) ||
		sending;
	const messages = history.data?.pages.flatMap((page) => page.items) ?? [];
	const visibleMessages =
		active.data &&
		!messages.some((m) => m.id === active.data.assistant_message.id)
			? [...messages, active.data.assistant_message].sort(
					(a, b) => a.ordinal - b.ordinal,
				)
			: messages;
	const review = describeReview(proposal, reviewBase.data);

	useEffect(() => {
		if (!pendingCheck.data || !pending?.uncertain) return;
		client.setQueryData(
			chatKeys.job(pendingCheck.data.id),
			(old: Job | undefined) =>
				old && old.version > pendingCheck.data.version
					? old
					: pendingCheck.data,
		);
		setRecentJobId(pendingCheck.data.id);
		setPending(null);
		if (pending.input.action === "generate_analysis")
			onGenerationAccepted(pendingCheck.data);
		else setDraft((current) => draftAfterAcceptance(current, pending.input));
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
		onGenerationAccepted,
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
		void client.invalidateQueries({ queryKey: analysisKeys.list(segment.id) });
		void client.invalidateQueries({ queryKey: ["analysis"] });
		const artifact = job.artifacts?.[0];
		if (
			artifact?.analysis_id &&
			artifact.revision_id &&
			job.kind !== "generate_analysis"
		) {
			// Quick generation is opened by the reader, which tracks intervening navigation.
			onOpenArtifact(artifact.analysis_id, artifact.revision_id);
		}
	}, [active.data, client, threadId, segment.id, onOpenArtifact]);

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
	const [reviewInstructions, setReviewInstructions] = useState("");
	const decision = useMutation({
		mutationFn: (choice: "approve" | "reject") =>
			decideJob(active.data?.id ?? "", {
				expected_version: active.data?.version ?? 0,
				decision: choice,
				additional_instructions: reviewInstructions,
			}),
		onSuccess: (updated) => {
			client.setQueryData(chatKeys.job(updated.id), updated);
			setReviewInstructions("");
			void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
		},
		onError: () =>
			void client.invalidateQueries({
				queryKey: chatKeys.job(active.data?.id ?? ""),
			}),
	});

	const send = useCallback(
		async (input: JobInput) => {
			if (sending) return;
			setSending(true);
			setSendError(null);
			try {
				const accepted = await submitJob(threadId, input);
				client.setQueryData(
					chatKeys.job(accepted.id),
					(old: Job | undefined) =>
						old && old.version > accepted.version ? old : accepted,
				);
				setRecentJobId(accepted.id);
				setPending(null);
				if (input.action === "generate_analysis")
					onGenerationAccepted(accepted);
				else setDraft((current) => draftAfterAcceptance(current, input));
				void client.invalidateQueries({ queryKey: chatKeys.thread(threadId) });
				void client.invalidateQueries({
					queryKey: chatKeys.messages(threadId),
				});
				void client.invalidateQueries({
					queryKey: chatKeys.threads(segment.id),
				});
				void client.invalidateQueries({
					queryKey: queries.segment(segment.id),
				});
			} catch (error) {
				const uncertain = submissionMayHaveSucceeded(error);
				if (uncertain) setPending({ input, uncertain: true });
				else {
					setPending(null);
					void client.invalidateQueries({
						queryKey: chatKeys.thread(threadId),
					});
					void client.invalidateQueries({
						queryKey: queries.segment(segment.id),
					});
				}
				setSendError(error instanceof Error ? error : new Error("提交失败"));
			} finally {
				setSending(false);
			}
		},
		[
			sending,
			threadId,
			client,
			setPending,
			setDraft,
			segment.id,
			onGenerationAccepted,
		],
	);

	const makeInput = useCallback(
		(current: Thread, action: JobInput["action"] = "chat"): JobInput => {
			return {
				action,
				request_id: crypto.randomUUID(),
				expected_thread_revision: current.revision,
				expected_segment_revision: segment.revision,
				question:
					action === "generate_analysis" ? generationQuestion : draft.question,
				additional_instructions:
					action === "generate_analysis" ? "" : draft.additional,
				stream,
				...(style === "none"
					? { style_id: null }
					: style
						? { style_id: style }
						: {}),
			};
		},
		[segment.revision, draft.question, draft.additional, stream, style],
	);
	useEffect(() => {
		if (
			!quickGenerateToken ||
			quickHandled.current === quickGenerateToken ||
			!thread.data ||
			!usableThread(thread.data, segment.id, thread.isSuccess) ||
			!providers.isSuccess ||
			!settings.isSuccess ||
			!history.isSuccess
		)
			return;
		quickHandled.current = quickGenerateToken;
		if (busy) {
			setSendError(new Error("当前对话正在进行中，请等待或停止本轮后重试。"));
			return;
		}
		if (!usable) {
			setSendError(
				new Error("请先为当前对话选择可用模型，再点击生成总体讲解。"),
			);
			return;
		}
		void send(makeInput(thread.data, "generate_analysis"));
	}, [
		quickGenerateToken,
		thread.data,
		thread.isSuccess,
		segment.id,
		providers.isSuccess,
		settings.isSuccess,
		history.isSuccess,
		busy,
		usable,
		send,
		makeInput,
	]);

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
			<details className="chat-config">
				<summary>
					<span>
						模型：
						{chosen
							? `${chosen.provider.name} / ${chosen.model.model_id}`
							: thread.data.selected_model_id
								? "原模型已不可用"
								: "未选择"}
					</span>
					<span>设置</span>
				</summary>
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
				<p className="chat-permission-note">
					讲解修改在审核模式下先展示具体方案；生成新讲解会按请求自动保存。
				</p>
			</details>
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
						onOpenArtifact={onOpenArtifact}
					/>
				))}
				{active.data?.status === "waiting_review" && (
					<section className="chat-review-card" aria-label="待审核讲解修改">
						<h3>{review?.title ?? "审核讲解修改"}</h3>
						<p>
							{proposal?.title ?? "当前讲解"} · 目标：
							{review?.target ?? "待核对"} · 基础修订{" "}
							<span title={reviewRevisionId}>{reviewRevisionId.slice(-6)}</span>
						</p>
						{reviewBase.isError && <InlineError error={reviewBase.error} />}
						{review && (
							<>
								<strong>修改前</strong>
								<pre>{review.before}</pre>
								<strong>拟修改为</strong>
								<pre>{review.after}</pre>
							</>
						)}
						<label htmlFor="review-instructions">附加要求（可选）</label>
						<textarea
							id="review-instructions"
							value={reviewInstructions}
							maxLength={10000}
							onChange={(event) => setReviewInstructions(event.target.value)}
							placeholder="例如：请保留原来的例句"
						/>
						<InlineError error={decision.error} />
						<div className="actions">
							<button
								type="button"
								className="button primary"
								disabled={
									decision.isPending || !review || !reviewBase.isSuccess
								}
								onClick={() => decision.mutate("approve")}
							>
								同意修改
							</button>
							<button
								type="button"
								className="button secondary"
								disabled={decision.isPending}
								onClick={() => decision.mutate("reject")}
							>
								拒绝
							</button>
						</div>
					</section>
				)}
				{active.data?.status === "queued" && (
					<p className="chat-job-state" role="status">
						已收到请求，正在等待开始。
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
					rows={3}
					placeholder="想了解这段话的什么？"
					onChange={(event) =>
						setDraft({ ...draft, question: event.target.value })
					}
				/>
				<details className="chat-additional">
					<summary>
						本轮补充要求（可选）{draft.additional && <span>已填写</span>}
					</summary>
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
				</details>
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
				<div className="chat-composer-footer">
					<span>
						{thread.data.permission_mode === "review"
							? "审核模式"
							: "Full access"}
					</span>
					<div className="actions">
						{thread.data.active_job_id && (
							<button
								className="button secondary"
								type="button"
								disabled={stop.isPending || active.data?.status === "stopping"}
								onClick={() => stop.mutate(thread.data.active_job_id ?? "")}
							>
								{stop.isPending || active.data?.status === "stopping"
									? "停止中…"
									: "停止本轮"}
							</button>
						)}
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
					</div>
				</div>
			</div>
		</div>
	);
}

export function Workbench({
	segment,
	generateToken,
	selectedThreadId,
	onSelectThread,
	onGenerationAccepted,
	onOpenArtifact,
}: {
	segment: Segment;
	generateToken: string | null;
	selectedThreadId: string | null;
	onSelectThread: (threadId: string | null) => void;
	onGenerationAccepted: (job: Job) => void;
	onOpenArtifact: (analysisId: string, revisionId: string) => void;
}) {
	const client = useQueryClient();
	const threads = useInfiniteQuery({
		queryKey: chatKeys.threads(segment.id),
		queryFn: ({ pageParam }) => listThreads(segment.id, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	const [selected, setSelected] = useState<string | null>(selectedThreadId);
	const [view, setView] = useState<"list" | "detail">(
		selectedThreadId ? "detail" : "list",
	);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [pending, setPending] = useState<Record<string, Pending | null>>({});
	const [createKey, setCreateKey] = useState<string | null>(null);
	const [firstModelId, setFirstModelId] = useState<string | null>(null);
	const defaults = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
	});
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
	});
	const allThreads = threads.data?.pages.flatMap((page) => page.items) ?? [];
	const selectedInfo = useQuery({
		queryKey: chatKeys.thread(selected ?? ""),
		queryFn: () => getThread(selected ?? ""),
		enabled: Boolean(selected),
	});
	const selectedThread = usableThread(
		selectedInfo.data,
		segment.id,
		selectedInfo.isSuccess,
	);
	useEffect(() => {
		// Keep valid panels mounted for drafts and review instructions, but do not
		// reuse a failed or foreign target after returning to the thread list.
		if (
			!selectedThreadId &&
			(selectedInfo.isError || selectedInfo.isSuccess) &&
			!usableThread(selectedInfo.data, segment.id, true)
		)
			setSelected(null);
	}, [
		selectedThreadId,
		selectedInfo.isError,
		selectedInfo.isSuccess,
		selectedInfo.data,
		segment.id,
	]);
	useEffect(() => {
		if (selectedThreadId) setSelected(selectedThreadId);
		setView(selectedThreadId ? "detail" : "list");
	}, [selectedThreadId]);
	useEffect(() => {
		if (generateToken) setView("detail");
	}, [generateToken]);
	useEffect(() => {
		if (defaults.data && firstModelId === null)
			setFirstModelId(defaults.data.defaults.analysis_model_id ?? "");
	}, [defaults.data, firstModelId]);
	const create = useMutation({
		mutationFn: ({
			requestId,
			modelId,
		}: {
			requestId: string;
			modelId?: string;
		}) => createThread(segment.id, requestId, modelId),
		onSuccess: (item) => {
			setCreateKey(null);
			setSelected(item.id);
			onSelectThread(item.id);
			setView("detail");
			void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
		},
		onError: (error) => {
			if (!submissionMayHaveSucceeded(error)) setCreateKey(null);
		},
	});
	const availableModels =
		providers.data?.flatMap((provider) =>
			provider.enabled
				? provider.models
						.filter((model) => model.enabled)
						.map((model) => ({ provider, model }))
				: [],
		) ?? [];
	return (
		<section className="workbench" aria-label="片段讨论工作台">
			<div className="chat-list-view" hidden={view !== "list"}>
				<div className="chat-pane-header">
					<div>
						<h2>对话</h2>
						<small>当前片段</small>
					</div>
					<button
						className="chat-new-button"
						type="button"
						disabled={create.isPending}
						onClick={() => {
							const key = createKey ?? crypto.randomUUID();
							setCreateKey(key);
							create.mutate({ requestId: key });
						}}
					>
						新建对话
					</button>
				</div>
				<InlineError error={create.error} />
				<section className="chat-thread-list" aria-label="对话列表">
					{threads.isPending && <p className="loading">正在加载对话…</p>}
					{threads.isError && <InlineError error={threads.error} />}
					{allThreads.map((item) => (
						<button
							key={item.id}
							type="button"
							className="chat-thread"
							onClick={() => {
								setSelected(item.id);
								onSelectThread(item.id);
								setView("detail");
							}}
						>
							<span className="chat-thread-title">{item.display_title}</span>
							<span className="chat-thread-meta">
								<span>
									{item.active_job_id
										? "进行中"
										: pending[item.id]?.uncertain
											? "提交待核实"
											: drafts[item.id]?.question || drafts[item.id]?.additional
												? "有草稿"
												: "已保存"}
								</span>
								<time dateTime={item.updated_at}>
									{new Date(item.updated_at).toLocaleString("zh-CN", {
										month: "numeric",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
									})}
								</time>
							</span>
							<svg
								className="chat-thread-chevron"
								aria-hidden="true"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.7"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="m9 5 7 7-7 7" />
							</svg>
						</button>
					))}
					{allThreads.length === 0 && threads.isSuccess && (
						<p className="chat-list-empty">
							还没有对话。新建后可直接围绕原文提问。
						</p>
					)}
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
				</section>
			</div>
			<div className="chat-detail-view" hidden={view !== "detail"}>
				<div className="chat-pane-header chat-detail-header">
					<button
						type="button"
						className="chat-back-button"
						aria-label="返回对话列表"
						onClick={() => {
							setView("list");
							onSelectThread(null);
						}}
					>
						←
					</button>
					<div>
						<h2>{selectedThread?.display_title ?? "新对话"}</h2>
						<small>参考当前片段原文</small>
					</div>
				</div>
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
							quickGenerateToken={generateToken}
							onGenerationAccepted={onGenerationAccepted}
							onOpenArtifact={onOpenArtifact}
						/>
					) : generateToken ? (
						<div className="chat-first-generation">
							<h3>生成总体讲解</h3>
							<p>先选择本次对话使用的模型。讲解生成会沿用同一模型。</p>
							<label htmlFor="generation-model">模型</label>
							<select
								id="generation-model"
								value={firstModelId ?? ""}
								onChange={(event) => setFirstModelId(event.target.value)}
							>
								<option value="">请选择模型</option>
								{availableModels.map(({ provider, model }) => (
									<option key={model.id} value={model.id}>
										{provider.name} / {model.model_id}
									</option>
								))}
							</select>
							{defaults.isError && <InlineError error={defaults.error} />}
							{providers.isError && <InlineError error={providers.error} />}
							{threads.isError && <InlineError error={threads.error} />}
							<InlineError error={create.error} />
							<button
								type="button"
								className="button primary"
								disabled={
									!threads.isSuccess ||
									!firstModelId ||
									!availableModels.some(
										({ model }) => model.id === firstModelId,
									) ||
									create.isPending
								}
								onClick={() => {
									const key = createKey ?? crypto.randomUUID();
									setCreateKey(key);
									create.mutate({
										requestId: key,
										modelId: firstModelId || undefined,
									});
								}}
							>
								开始生成
							</button>
						</div>
					) : (
						<div className="chat-empty">尚无对话。新建对话后可直接提问。</div>
					)}
				</div>
			</div>
		</section>
	);
}
