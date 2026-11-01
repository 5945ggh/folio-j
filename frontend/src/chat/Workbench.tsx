import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { analysisKeys, getAnalysis } from "../analysis/api";
import { Markdown } from "../analysis/Markdown";
import { queries, RequestError, type Segment } from "../content";
import { NativeSelect } from "../NativeSelect";
import { InlineError } from "../Shared";
import { getProviders, getSettings, settingsKeys } from "../settings/api";
import {
	chatKeys,
	createThread,
	decideJob,
	getExplanationPrompt,
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
	DiscussionCoordinator,
	type Draft,
	freshestJob,
	isTerminalJob,
	MAX_QUESTION_CHARS,
	type PendingSubmission,
	submissionMayHaveSucceeded,
	threadChanged,
	usableThread,
} from "./discussion";
import { type ExplanationProgress, ExplanationRequests } from "./explanation";
import type { ReplyOperation } from "./progress";
import { ReplyProgress } from "./ReplyProgress";
import { describeReview } from "./review";

type Pending = PendingSubmission;
type ExplanationInput = {
	token: string;
	modelId: string;
	segmentRevision: number;
};
type ExplanationAttempt = {
	input: ExplanationInput;
	error: Error | null;
	pending: boolean;
	progress?: ExplanationProgress;
};
const emptyDraft: Draft = { question: "" };

function ChatIcon({ name }: { name: "back" | "send" | "copy" }) {
	return (
		<svg
			aria-hidden="true"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{name === "back" ? (
				<path d="m14 5-7 7 7 7M7 12h12" />
			) : name === "send" ? (
				<path d="M12 19V5m-6 6 6-6 6 6" />
			) : (
				<>
					<rect x="8" y="8" width="12" height="13" rx="2" />
					<path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
				</>
			)}
		</svg>
	);
}

function ComposerSetting({
	label,
	panelLabel,
	value,
	title,
	children,
}: {
	label: string;
	panelLabel: string;
	value: string;
	title?: string;
	children: ReactNode;
}) {
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="chat-setting-button"
				aria-label={label}
				aria-haspopup="dialog"
				title={title ?? label}
				popoverTarget={id}
			>
				<span>{value}</span>
				<span aria-hidden="true">⌄</span>
			</button>
			<div
				ref={panel}
				id={id}
				popover="auto"
				role="dialog"
				aria-label={panelLabel}
				className="chat-setting-popover popover-motion"
				onToggle={(event) => {
					if (event.newState !== "open" || !panel.current) return;
					const bounds = trigger.current?.getBoundingClientRect();
					if (!bounds) return;
					const menu = panel.current;
					menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 8))}px`;
					menu.style.top = `${Math.max(8, bounds.top - menu.offsetHeight - 8)}px`;
					const selected = menu.querySelector<HTMLElement>(
						'input[type="radio"]:checked:not(:disabled)',
					);
					const first = menu.querySelector<HTMLElement>(
						"input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
					);
					(selected ?? first)?.focus();
				}}
			>
				{children}
			</div>
		</>
	);
}

function DiscussionReference({ segment }: { segment: Segment }) {
	return (
		<details className="chat-reference">
			<summary>参考原文与前后文</summary>
			<div className="chat-reference-body">
				<p className="chat-reference-note">
					以下是当前保存的片段资料，新任务采用这些内容；历史任务仍以当时的输入快照为准。
				</p>
				{segment.context_before.trim() && (
					<section>
						<h3 className="chat-reference-label">前文</h3>
						<p className="chat-reference-text" lang="ja">
							{segment.context_before}
						</p>
					</section>
				)}
				<section className="chat-reference-target">
					<h3 className="chat-reference-label">目标原文</h3>
					<p className="chat-reference-text" lang="ja">
						{segment.text}
					</p>
				</section>
				{segment.context_after.trim() && (
					<section>
						<h3 className="chat-reference-label">后文</h3>
						<p className="chat-reference-text" lang="ja">
							{segment.context_after}
						</p>
					</section>
				)}
			</div>
		</details>
	);
}

function FailedJob({
	summary,
	onRetry,
}: {
	summary?: Message["job_summary"];
	onRetry: (draft: Draft) => void;
}) {
	return (
		<div className="chat-failure-detail">
			{summary?.error && <p role="alert">{summary.error}</p>}
			{summary?.retry && (
				<button
					className="button secondary"
					type="button"
					onClick={() => {
						if (!summary.retry) return;
						onRetry({ question: summary.retry.question });
					}}
				>
					把原问题放回输入框
				</button>
			)}
		</div>
	);
}

const MessageItem = memo(function MessageItem({
	message,
	activeJob,
	updateFailed,
	operation,
	onRetry,
	onOpenArtifact,
}: {
	message: Message;
	activeJob?: Job;
	updateFailed?: boolean;
	operation?: ReplyOperation;
	onRetry: (draft: Draft) => void;
	onOpenArtifact: (analysisId: string, revisionId: string, job?: Job) => void;
}) {
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const current =
		activeJob?.assistant_message.id === message.id
			? activeJob.assistant_message
			: message;
	const summary =
		activeJob?.assistant_message.id === message.id
			? {
					artifacts: activeJob.artifacts,
					error: activeJob.error,
					retry: {
						question: activeJob.question,
					},
				}
			: message.job_summary;
	return (
		<article
			className={`chat-message ${current.role}`}
			aria-label={current.role === "user" ? "你的消息" : "助手消息"}
		>
			{current.role === "assistant" &&
				(activeJob ? (
					<ReplyProgress
						job={activeJob}
						updateFailed={updateFailed}
						operation={operation}
					/>
				) : current.status !== "complete" ? (
					<p className="chat-reply-progress">
						{current.status === "failed"
							? "本轮失败"
							: current.status === "interrupted"
								? "本轮已中断"
								: "正在读取本轮状态"}
					</p>
				) : null)}
			{current.content ? (
				current.role === "assistant" ? (
					<div className="chat-message-content chat-markdown">
						<Markdown text={current.content} />
					</div>
				) : (
					<p className="chat-message-content">{current.content}</p>
				)
			) : null}
			{current.role === "assistant" && current.content && (
				<div className="chat-message-actions">
					<button
						type="button"
						className="chat-copy-button"
						aria-label={
							copyState === "copied" ? "已复制助手消息" : "复制助手消息"
						}
						title={copyState === "copied" ? "已复制" : "复制回复"}
						onClick={() => {
							void Promise.resolve()
								.then(() => navigator.clipboard.writeText(current.content))
								.then(
									() => setCopyState("copied"),
									() => setCopyState("failed"),
								);
						}}
					>
						<ChatIcon name="copy" />
						<span>{copyState === "copied" ? "已复制" : "复制"}</span>
					</button>
					<span
						role="status"
						className={copyState === "failed" ? "chat-copy-error" : "sr-only"}
					>
						{copyState === "failed"
							? "复制失败，请选择回复文字复制。"
							: copyState === "copied"
								? "回复已复制"
								: ""}
					</span>
				</div>
			)}
			{current.role === "assistant" &&
				summary?.artifacts?.map((artifact) =>
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
					<FailedJob summary={summary} onRetry={onRetry} />
				)}
		</article>
	);
});

function ThreadPanel({
	segment,
	threadId,
	draft,
	setDraft,
	pending,
	setPending,
	initialJobId,
	initialError,
	onClearInitialError,
	onSubmissionStarted,
	onJobAccepted,
	onOpenArtifact,
}: {
	segment: Segment;
	threadId: string;
	draft: Draft;
	setDraft: (draft: Draft | ((current: Draft) => Draft)) => void;
	pending: Pending | null;
	setPending: (pending: Pending | null) => void;
	initialJobId: string | null;
	initialError: Error | null;
	onClearInitialError: (threadId: string) => void;
	onSubmissionStarted: (requestId: string) => void;
	onJobAccepted: (job: Job) => void;
	onOpenArtifact: (analysisId: string, revisionId: string, job?: Job) => void;
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
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	const [recentJobId, setRecentJobId] = useState<string | null>(null);
	const jobId = thread.data?.active_job_id ?? recentJobId ?? initialJobId;
	const active = useQuery({
		queryKey: chatKeys.job(jobId ?? ""),
		queryFn: async () => {
			const fresh = await getJob(jobId ?? "");
			const previous = client.getQueryData<Job>(chatKeys.job(jobId ?? ""));
			return freshestJob(previous, fresh);
		},
		enabled: Boolean(jobId),
		refetchInterval: (query) =>
			query.state.data && isTerminalJob(query.state.data) ? false : 1000,
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
		queryFn: async () => {
			if (!pending) throw new Error("没有待核实的提交。");
			return (await coordinator.current?.verify(threadId, pending))?.job;
		},
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
	const [stream, setStream] = useState(true);
	const [sendError, setSendError] = useState<Error | null>(initialError);
	const [sending, setSending] = useState(false);
	const coordinator = useRef<DiscussionCoordinator | null>(null);
	if (!coordinator.current)
		coordinator.current = new DiscussionCoordinator(client, {
			submit: submitJob,
			findByRequest: getJobByRequest,
		});
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
		Boolean(active.data && !isTerminalJob(active.data)) ||
		Boolean(pending) ||
		sending;
	const sendDisabled =
		busy ||
		!draft.question.trim() ||
		!usable ||
		!history.isSuccess ||
		!settings.isSuccess ||
		!providers.isSuccess;
	const messages = [...(history.data?.pages ?? [])]
		.reverse()
		.flatMap((page) => page.items);
	const visibleMessages = [...messages];
	if (active.data) {
		const job = active.data;
		if (!messages.some((message) => message.id === job.user_message_id)) {
			visibleMessages.push({
				...job.assistant_message,
				id: job.user_message_id,
				ordinal: job.assistant_message.ordinal - 1,
				role: "user",
				status: "complete",
				content: job.question,
				job_summary: null,
			});
		}
		if (!messages.some((message) => message.id === job.assistant_message.id))
			visibleMessages.push(job.assistant_message);
		visibleMessages.sort((a, b) => a.ordinal - b.ordinal);
	}
	const review = describeReview(proposal, reviewBase.data);
	const acceptSubmission = useCallback(
		(accepted: Job, input: JobInput) =>
			coordinator.current?.acceptSubmission(accepted, {
				threadId,
				segmentId: segment.id,
				input,
				setRecentJobId,
				setPending,
				setDraft: (update) => setDraft(update),
				setError: setSendError,
				onJobAccepted,
			}),
		[threadId, segment.id, setPending, setDraft, onJobAccepted],
	);

	useEffect(() => {
		if (!pendingCheck.data || !pending?.uncertain) return;
		acceptSubmission(pendingCheck.data, pending.input);
	}, [pendingCheck.data, pending?.uncertain, pending?.input, acceptSubmission]);
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
	const applyJobUpdate = useCallback(
		(job: Job) =>
			coordinator.current?.observeJob(job, {
				threadId,
				segmentId: segment.id,
				onArtifact: onOpenArtifact,
			}),
		[threadId, segment.id, onOpenArtifact],
	);
	useEffect(() => {
		const job = active.data;
		if (job) applyJobUpdate(job);
	}, [active.data, applyJobUpdate]);

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
			applyJobUpdate(updated);
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
			applyJobUpdate(updated);
			void client.invalidateQueries({ queryKey: ["catalog"] });
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
			onSubmissionStarted(input.request_id);
			onClearInitialError(threadId);
			setSending(true);
			setSendError(null);
			const result = await coordinator.current?.submit(threadId, input);
			try {
				if (!result?.job) throw result?.error ?? new Error("提交失败");
				const accepted = result.job;
				acceptSubmission(accepted, input);
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
			setPending,
			onSubmissionStarted,
			onClearInitialError,
			acceptSubmission,
			client.invalidateQueries,
			segment.id,
		],
	);

	const makeInput = useCallback(
		(current: Thread, question = draft.question): JobInput => ({
			request_id: crypto.randomUUID(),
			expected_thread_revision: current.revision,
			expected_segment_revision: segment.revision,
			question,
			stream,
		}),
		[segment.revision, draft.question, stream],
	);
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
			<DiscussionReference segment={segment} />
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
			<InlineError error={providers.error} />
			<InlineError error={settings.error} />
			<section className="chat-history" aria-label="讨论历史">
				{history.isPending && <p className="loading">正在加载历史…</p>}
				{history.isError && <InlineError error={history.error} />}
				{history.hasNextPage && (
					<button
						type="button"
						className="button secondary"
						disabled={history.isFetchingNextPage}
						onClick={() => void history.fetchNextPage()}
					>
						{history.isFetchingNextPage ? "正在加载…" : "加载更早消息"}
					</button>
				)}
				{visibleMessages.length === 0 && !history.isPending && (
					<p className="chat-empty">
						围绕这段原文提出第一个问题，讨论会保存在本线程。
					</p>
				)}
				{visibleMessages.map((message) => (
					<MessageItem
						key={message.id}
						message={message}
						activeJob={
							active.data?.assistant_message.id === message.id
								? active.data
								: undefined
						}
						updateFailed={active.isError}
						operation={
							active.data?.assistant_message.id === message.id
								? decision.isPending
									? "decision"
									: stop.isPending
										? "stop"
										: undefined
								: undefined
						}
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
				{active.isError && <InlineError error={active.error} />}
			</section>
			<div className="chat-composer">
				<label className="sr-only" htmlFor="chat-question">
					问题
				</label>
				<textarea
					id="chat-question"
					value={draft.question}
					maxLength={MAX_QUESTION_CHARS}
					rows={3}
					placeholder="想了解这段话的什么？"
					title="Enter 发送，Shift+Enter 换行"
					onChange={(event) => setDraft({ question: event.target.value })}
					onKeyDown={(event) => {
						if (
							event.key !== "Enter" ||
							event.shiftKey ||
							event.ctrlKey ||
							event.altKey ||
							event.metaKey ||
							event.nativeEvent.isComposing ||
							event.nativeEvent.keyCode === 229
						)
							return;
						event.preventDefault();
						if (!sendDisabled && !event.repeat)
							void send(makeInput(thread.data));
					}}
				/>

				{sending && !pending?.uncertain && (
					<p className="chat-reply-progress" role="status">
						正在提交本轮请求…
					</p>
				)}
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
				<div
					className={`chat-composer-tools${thread.data.active_job_id ? " has-stop" : ""}`}
				>
					<section className="chat-config" aria-label="本轮设置">
						<ComposerSetting
							label="选择模型"
							panelLabel="模型设置"
							value={
								chosen
									? chosen.model.model_id
									: thread.data.selected_model_id
										? "模型不可用"
										: "选择模型"
							}
							title={
								chosen
									? `${chosen.provider.name} / ${chosen.model.model_id}`
									: "选择模型"
							}
						>
							<fieldset className="chat-choice-list" aria-label="可选模型">
								{models
									.filter(
										({ provider, model }) => provider.enabled && model.enabled,
									)
									.map(({ provider, model }) => (
										<label className="chat-choice" key={model.id}>
											<input
												type="radio"
												className="sr-only"
												name={`model-${threadId}`}
												data-model-id={model.id}
												checked={thread.data.selected_model_id === model.id}
												disabled={busy || patch.isPending}
												onClick={(event) => {
													if (thread.data.selected_model_id === model.id)
														event.currentTarget
															.closest<HTMLElement>("[popover]")
															?.hidePopover();
												}}
												onChange={(event) => {
													patch.mutate({
														expected_revision: thread.data.revision,
														model_id: model.id,
													});
													event.currentTarget
														.closest<HTMLElement>("[popover]")
														?.hidePopover();
												}}
											/>
											<span className="chat-choice-name">
												{model.model_id}
												<small>{provider.name}</small>
											</span>
											<span className="chat-choice-check" aria-hidden="true">
												{thread.data.selected_model_id === model.id ? "✓" : ""}
											</span>
										</label>
									))}
								{!models.some(
									({ provider, model }) => provider.enabled && model.enabled,
								) && <p className="chat-choice-empty">暂无可用模型</p>}
							</fieldset>
							<label className="chat-stream-choice">
								<span>流式生成</span>
								<input
									className="chat-stream-switch"
									type="checkbox"
									role="switch"
									aria-checked={stream}
									checked={stream}
									disabled={busy}
									onChange={(event) => setStream(event.target.checked)}
								/>
							</label>
						</ComposerSetting>
						<ComposerSetting
							label="设置审核模式"
							panelLabel="审核模式"
							value={
								thread.data.permission_mode === "review"
									? "审核模式"
									: "完全访问"
							}
						>
							<fieldset className="chat-choice-list" aria-label="可选审核模式">
								{(["review", "full_access"] as const).map((mode) => (
									<label className="chat-choice" key={mode}>
										<input
											type="radio"
											className="sr-only"
											name={`permission-${threadId}`}
											data-permission-mode={mode}
											checked={thread.data.permission_mode === mode}
											disabled={busy || patch.isPending}
											onClick={(event) => {
												if (thread.data.permission_mode === mode)
													event.currentTarget
														.closest<HTMLElement>("[popover]")
														?.hidePopover();
											}}
											onChange={(event) => {
												patch.mutate({
													expected_revision: thread.data.revision,
													permission_mode: mode,
												});
												event.currentTarget
													.closest<HTMLElement>("[popover]")
													?.hidePopover();
											}}
										/>
										<span className="chat-choice-name">
											{mode === "review" ? "审核模式" : "完全访问"}
										</span>
										<span className="chat-choice-check" aria-hidden="true">
											{thread.data.permission_mode === mode ? "✓" : ""}
										</span>
									</label>
								))}
							</fieldset>
						</ComposerSetting>
					</section>
					<div className="chat-composer-footer">
						<div className="actions">
							{thread.data.active_job_id && (
								<button
									className="button secondary"
									type="button"
									disabled={
										stop.isPending || active.data?.status === "stopping"
									}
									onClick={() => stop.mutate(thread.data.active_job_id ?? "")}
								>
									{stop.isPending || active.data?.status === "stopping"
										? "停止中…"
										: "停止本轮"}
								</button>
							)}
							<button
								className="chat-send-button"
								type="button"
								aria-label={sending ? "提交中…" : "发送问题"}
								title={sending ? "提交中…" : "发送问题（Enter）"}
								disabled={sendDisabled}
								onClick={() => void send(makeInput(thread.data))}
							>
								<ChatIcon name="send" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function Workbench({
	headerAction,
	segment,
	explainToken,
	selectedThreadId,
	onSelectThread,
	onSubmissionStarted,
	onJobAccepted,
	onOpenArtifact,
}: {
	headerAction?: ReactNode;
	segment: Segment;
	explainToken: string | null;
	selectedThreadId: string | null;
	onSelectThread: (threadId: string | null) => void;
	onSubmissionStarted: (requestId: string) => void;
	onJobAccepted: (job: Job) => void;
	onOpenArtifact: (analysisId: string, revisionId: string, job?: Job) => void;
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
	const setSelectedDraft = useCallback(
		(next: Draft | ((current: Draft) => Draft)) => {
			if (!selected) return;
			setDrafts((old) => ({
				...old,
				[selected]:
					typeof next === "function" ? next(old[selected] ?? emptyDraft) : next,
			}));
		},
		[selected],
	);
	const setSelectedPending = useCallback(
		(item: Pending | null) => {
			if (selected) setPending((old) => ({ ...old, [selected]: item }));
		},
		[selected],
	);
	const [createKey, setCreateKey] = useState<string | null>(null);
	const [firstModelId, setFirstModelId] = useState<string | null>(null);
	const handledExplanations = useRef(new Set<string>());
	const [explanationAttempts, setExplanationAttempts] = useState<
		Record<string, ExplanationAttempt>
	>({});
	const [explanationErrors, setExplanationErrors] = useState<
		Record<string, Error | null>
	>({});
	const clearExplanationError = useCallback((threadId: string) => {
		setExplanationErrors((old) => ({ ...old, [threadId]: null }));
	}, []);
	const [acceptedJobIds, setAcceptedJobIds] = useState<Record<string, string>>(
		{},
	);
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
		if (explainToken) setView("detail");
	}, [explainToken]);
	useEffect(() => {
		if (defaults.data && firstModelId === null)
			setFirstModelId(defaults.data.defaults.chat_model_id ?? "");
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
	const selectedModel = selectedInfo.data?.selected_model_id;
	const explanationModel = availableModels.some(
		({ model }) => model.id === selectedModel,
	)
		? selectedModel
		: defaults.data?.defaults.chat_model_id;
	const explanationRequests = useRef<ExplanationRequests | null>(null);
	if (!explanationRequests.current)
		explanationRequests.current = new ExplanationRequests({
			onProgress: (token, progress) => {
				setExplanationAttempts((old) => {
					const attempt = old[token];
					return attempt ? { ...old, [token]: { ...attempt, progress } } : old;
				});
			},
			readPrompt: () =>
				client.fetchQuery({
					queryKey: chatKeys.explanationPrompt,
					queryFn: getExplanationPrompt,
					staleTime: 0,
				}),
			findByRequest: getJobByRequest,
			createThread: (requestId, modelId) =>
				createThread(segment.id, requestId, modelId),
			submit: (threadId, input) =>
				new DiscussionCoordinator(client, {
					submit: submitJob,
					findByRequest: getJobByRequest,
				}).submit(threadId, input),
		});
	const requestCoordinator = explanationRequests.current;
	const explain = useMutation({
		mutationFn: (input: ExplanationInput) => {
			setExplanationAttempts((old) => ({
				...old,
				[input.token]: { input, error: null, pending: true },
			}));
			onSubmissionStarted(input.token);
			return requestCoordinator.start(
				input.token,
				input.modelId,
				input.segmentRevision,
			);
		},
		onError: (error, input) => {
			setExplanationAttempts((old) => ({
				...old,
				[input.token]: { input, error, pending: false },
			}));
		},
		onSuccess: ({ token, item, question, input, result }) => {
			setExplanationAttempts((old) => {
				const next = { ...old };
				delete next[token];
				return next;
			});
			client.setQueryData(chatKeys.thread(item.id), item);
			setDrafts((old) => ({ ...old, [item.id]: old[item.id] ?? { question } }));
			if (result.job) {
				new DiscussionCoordinator(client, {
					submit: submitJob,
					findByRequest: getJobByRequest,
				}).acceptSubmission(result.job, {
					threadId: item.id,
					segmentId: segment.id,
					input,
					setRecentJobId: (jobId) =>
						setAcceptedJobIds((old) => ({ ...old, [item.id]: jobId })),
					setPending: (value) =>
						setPending((old) => ({ ...old, [item.id]: value })),
					setDraft: (update) =>
						setDrafts((old) => ({
							...old,
							[item.id]: update(old[item.id] ?? { question }),
						})),
					setError: (error) =>
						setExplanationErrors((old) => ({ ...old, [item.id]: error })),
					onJobAccepted,
				});
			} else if (result.pending) {
				setPending((old) => ({ ...old, [item.id]: result.pending }));
			} else if ("error" in result) {
				setExplanationErrors((old) => ({
					...old,
					[item.id]:
						result.error instanceof Error
							? result.error
							: new Error("提交失败"),
				}));
			}
			setSelected(item.id);
			onSelectThread(item.id);
			setView("detail");
			void client.invalidateQueries({ queryKey: chatKeys.threads(segment.id) });
		},
	});
	useEffect(() => {
		if (
			!explainToken ||
			handledExplanations.current.has(explainToken) ||
			!defaults.isSuccess ||
			!providers.isSuccess ||
			(selected && selectedInfo.isPending) ||
			!explanationModel ||
			!availableModels.some(({ model }) => model.id === explanationModel)
		)
			return;
		handledExplanations.current.add(explainToken);
		explain.mutate({
			token: explainToken,
			modelId: explanationModel,
			segmentRevision: segment.revision,
		});
	}, [
		explainToken,
		defaults.isSuccess,
		providers.isSuccess,
		selected,
		selectedInfo.isPending,
		explanationModel,
		availableModels,
		segment.revision,
		explain.mutate,
	]);
	const needsExplanationModel = Boolean(
		explainToken && !handledExplanations.current.has(explainToken),
	);

	return (
		<section className="workbench" aria-label="片段讨论工作台">
			<div className="chat-list-view" hidden={view !== "list"}>
				<div className="chat-pane-header">
					<div>
						<h2>对话</h2>
					</div>
					<div className="chat-header-actions">
						<button
							className="chat-new-button chat-icon-button"
							type="button"
							aria-label="新建对话"
							title="新建对话"
							data-tooltip="新建对话"
							disabled={create.isPending}
							onClick={() => {
								const key = createKey ?? crypto.randomUUID();
								setCreateKey(key);
								create.mutate({ requestId: key });
							}}
						>
							<span aria-hidden="true">＋</span>
						</button>
						{view === "list" && headerAction}
					</div>
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
											: drafts[item.id]?.question
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
						title="返回对话列表"
						data-tooltip="返回对话列表"
						onClick={() => {
							setView("list");
							onSelectThread(null);
						}}
					>
						<ChatIcon name="back" />
					</button>
					<div>
						<h2>对话</h2>
					</div>
					{view === "detail" && (
						<div className="chat-header-actions">{headerAction}</div>
					)}
				</div>
				<div className="chat-main">
					{Object.values(explanationAttempts).map((attempt) =>
						attempt.pending ? (
							<p
								className="chat-reply-progress chat-preparation"
								role="status"
								key={attempt.input.token}
							>
								{attempt.progress === "thread"
									? "正在准备新的讲解对话…"
									: attempt.progress === "checking"
										? "正在核实本次讲解请求…"
										: attempt.progress === "submitting"
											? "正在提交讲解请求…"
											: "正在读取讲解请求…"}
							</p>
						) : null,
					)}
					{Object.values(explanationAttempts).map(({ input, error }) =>
						error ? (
							<div className="state-card" key={input.token}>
								<InlineError error={error} />
								<button
									type="button"
									className="button secondary"
									onClick={() => explain.mutate(input)}
								>
									重试新建讲解对话
								</button>
							</div>
						) : null,
					)}
					{selected && !needsExplanationModel ? (
						<ThreadPanel
							key={selected}
							segment={segment}
							threadId={selected}
							draft={drafts[selected] ?? emptyDraft}
							setDraft={setSelectedDraft}
							pending={pending[selected] ?? null}
							setPending={setSelectedPending}
							initialJobId={acceptedJobIds[selected] ?? null}
							initialError={explanationErrors[selected] ?? null}
							onClearInitialError={clearExplanationError}
							onSubmissionStarted={onSubmissionStarted}
							onJobAccepted={onJobAccepted}
							onOpenArtifact={onOpenArtifact}
						/>
					) : explainToken &&
						explanationAttempts[explainToken] ? null : explainToken &&
						(defaults.isPending ||
							providers.isPending ||
							(selected && selectedInfo.isPending) ||
							(needsExplanationModel &&
								availableModels.some(
									({ model }) => model.id === explanationModel,
								))) ? (
						<p className="chat-reply-progress chat-preparation" role="status">
							{defaults.isPending ||
							providers.isPending ||
							(selected && selectedInfo.isPending)
								? "正在读取模型设置…"
								: "正在准备讲解请求…"}
						</p>
					) : explainToken ? (
						<div className="chat-first-generation">
							<h3>创建 AI 讲解</h3>
							<p>选择模型后，在新对话中创建并保存一份独立讲解。</p>
							<label htmlFor="explanation-model">模型</label>
							<NativeSelect
								id="explanation-model"
								value={firstModelId ?? ""}
								onChange={(event) => setFirstModelId(event.target.value)}
							>
								<option value="">请选择模型</option>
								{availableModels.map(({ provider, model }) => (
									<option key={model.id} value={model.id}>
										{provider.name} / {model.model_id}
									</option>
								))}
							</NativeSelect>
							{defaults.isError && <InlineError error={defaults.error} />}
							{providers.isError && <InlineError error={providers.error} />}
							{threads.isError && <InlineError error={threads.error} />}
							<InlineError error={create.error} />
							<button
								type="button"
								className="button primary"
								disabled={
									!defaults.isSuccess ||
									!providers.isSuccess ||
									!firstModelId ||
									!availableModels.some(
										({ model }) => model.id === firstModelId,
									) ||
									Boolean(explanationAttempts[explainToken]?.pending)
								}
								onClick={() => {
									if (!firstModelId) return;
									handledExplanations.current.add(explainToken);
									explain.mutate({
										token: explainToken,
										modelId: firstModelId,
										segmentRevision: segment.revision,
									});
								}}
							>
								创建 AI 讲解
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
