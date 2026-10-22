import "./materials/reader-refresh.css";
import "./segments/layout.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { AnalysisEditor } from "./analysis/AnalysisEditor";
import { AnalysisGenerationStatus } from "./analysis/AnalysisGeneration";
import { AnalysisPanel } from "./analysis/AnalysisPanel";
import { type AnalysisDetail, analysisKeys } from "./analysis/api";
import { savedAnalysisLocation } from "./analysis/editor";
import { api } from "./api/client";
import { chatKeys, getJob, type Job } from "./chat/api";
import {
	captureReadingPosition,
	freshestJob,
	isTerminalJob,
	readingPositionForJob,
	shouldOpenArtifact,
} from "./chat/discussion";
import {
	clampConversationWidth,
	conversationWidthRange,
	MAX_CONVERSATION_WIDTH,
	MIN_CONVERSATION_WIDTH,
} from "./chat/layout";
import { shouldMountWorkbench } from "./chat/lifecycle";
import { Workbench } from "./chat/Workbench";
import {
	errorMessage,
	getSegment,
	getSegmentDeleteImpact,
	getSource,
	queries,
	RequestError,
	requireData,
	type Segment,
	type SegmentFields,
} from "./content";
import { SegmentForm } from "./Forms";
import { SegmentMaterialOrigin } from "./materials/SegmentMaterialOrigin";
import {
	readSegmentLocation,
	returnDestination,
	type SegmentLocation,
	updateSegmentLocation,
} from "./navigation";
import { ConfirmDialog, InlineError } from "./Shared";
import { NewAnalysisActions } from "./segments/NewAnalysisActions";
import { OriginalCard } from "./segments/OriginalCard";
import { SegmentFrame } from "./segments/SegmentFrame";

const CONVERSATION_WIDTH_KEY = "folio-j:conversation-width";

function initialConversationWidth() {
	const defaultWidth = Math.max(360, Math.min(420, window.innerWidth * 0.29));
	try {
		const stored = Number(window.localStorage.getItem(CONVERSATION_WIDTH_KEY));
		return stored >= MIN_CONVERSATION_WIDTH && stored <= MAX_CONVERSATION_WIDTH
			? stored
			: defaultWidth;
	} catch {
		return defaultWidth;
	}
}

function saveConversationWidth(width: number) {
	try {
		window.localStorage.setItem(CONVERSATION_WIDTH_KEY, String(width));
	} catch {
		// Resizing still works if browser storage is unavailable.
	}
}

export function SegmentDetail() {
	const { id = "" } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
	const {
		analysisId: selectedAnalysis,
		revisionId: selectedRevision,
		threadId: selectedThread,
		chatOpen,
	} = readSegmentLocation(location.search);
	const returnTo = returnDestination(location.state);
	const locationRef = useRef({ rendered: location, latest: location });
	if (locationRef.current.rendered !== location) {
		locationRef.current = { rendered: location, latest: location };
	}
	const activeId = useRef<string | null>(id);
	const updateLocation = useCallback(
		(patch: Partial<SegmentLocation>) => {
			if (activeId.current !== id) return;
			const latest = locationRef.current.latest;
			const next = {
				...latest,
				search: updateSegmentLocation(latest.search, patch),
				hash:
					patch.analysisId !== undefined || patch.revisionId !== undefined
						? ""
						: latest.hash,
			};
			// Merge consecutive updates before React Router delivers its next render.
			locationRef.current.latest = next;
			navigate(
				{ pathname: next.pathname, search: next.search, hash: next.hash },
				{ state: next.state },
			);
		},
		[navigate, id],
	);
	const [compact, setCompact] = useState(
		() => window.matchMedia("(max-width: 999px)").matches,
	);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 999px)");
		const changed = () => setCompact(query.matches);
		query.addEventListener("change", changed);
		return () => query.removeEventListener("change", changed);
	}, []);
	const discussionClose = useRef<HTMLButtonElement>(null);
	const setChatOpen = (open: boolean) => {
		updateLocation({ chatOpen: open });
		requestAnimationFrame(() => {
			if (open && compact) discussionClose.current?.focus();
			else if (!open)
				document.getElementById("segment-discussion-toggle")?.focus();
		});
	};
	const analysisListScroll = useRef<number | null>(null);
	const analysisRef = useRef<HTMLElement>(null);
	const readerRef = useRef<HTMLElement>(null);
	const [pendingReadingScroll, setPendingReadingScroll] = useState<{
		analysisId: string | null;
		revisionId: string | null;
		top: number | "analysis";
	} | null>(null);
	const selectAnalysis = (
		analysisId: string | null,
		revisionId: string | null,
	) => {
		if (analysisId && !selectedAnalysis)
			analysisListScroll.current = readerRef.current?.scrollTop ?? null;
		setPendingReadingScroll({
			analysisId,
			revisionId,
			top: !analysisId
				? (analysisListScroll.current ?? "analysis")
				: "analysis",
		});
		updateLocation({ analysisId, revisionId });
	};
	// Restore only after the destination DOM exists; before that, the shorter
	// document view would clamp a saved list offset back to zero.
	useLayoutEffect(() => {
		const pending = pendingReadingScroll;
		const reader = readerRef.current;
		const section = analysisRef.current;
		if (
			!pending ||
			!reader ||
			!section ||
			pending.analysisId !== selectedAnalysis ||
			pending.revisionId !== selectedRevision
		)
			return;
		setPendingReadingScroll(null);
		reader.scrollTo({
			top:
				pending.top === "analysis"
					? reader.scrollTop +
						section.getBoundingClientRect().top -
						reader.getBoundingClientRect().top -
						15
					: pending.top,
		});
	}, [pendingReadingScroll, selectedAnalysis, selectedRevision]);
	const client = useQueryClient();
	useEffect(() => {
		activeId.current = id;
		return () => {
			activeId.current = null;
		};
	}, [id]);
	const [editing, setEditing] = useState<
		| "segment-more-trigger"
		| "segment-original-trigger"
		| "segment-discussion-toggle"
		| null
	>(null);
	const [analysisEditor, setAnalysisEditor] = useState<{
		segment: Segment;
		initial?: AnalysisDetail;
		restoreFocusId: string;
	} | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [conversationWidth, setConversationWidth] = useState(
		initialConversationWidth,
	);
	const [workspaceWidth, setWorkspaceWidth] = useState(0);
	const workspaceRef = useRef<HTMLDivElement>(null);
	const conversationRef = useRef<HTMLElement>(null);
	const resizeStart = useRef<{
		pointerId: number;
		x: number;
		width: number;
		lastWidth: number;
	} | null>(null);
	const widthRange = conversationWidthRange(workspaceWidth);
	const [generateToken, setGenerateToken] = useState<string | null>(null);
	const [discussionActivated, setDiscussionActivated] = useState(false);
	const workbenchMounted = shouldMountWorkbench(
		discussionActivated,
		chatOpen,
		generateToken,
	);
	useEffect(() => {
		if (workbenchMounted) setDiscussionActivated(true);
	}, [workbenchMounted]);
	const [generationJobId, setGenerationJobId] = useState<string | null>(null);
	const openedGenerationArtifact = useRef<string | null>(null);
	const jobReading = useRef<
		Record<string, { analysisId: string | null; revisionId: string | null }>
	>({});
	const requestReading = useRef<
		Record<string, { analysisId: string | null; revisionId: string | null }>
	>({});
	const generation = useQuery({
		queryKey: chatKeys.job(generationJobId ?? ""),
		queryFn: async () => {
			const fresh = await getJob(generationJobId ?? "");
			return freshestJob(
				client.getQueryData<Job>(chatKeys.job(generationJobId ?? "")),
				fresh,
			);
		},
		enabled: Boolean(generationJobId),
		refetchInterval: (query) =>
			query.state.data &&
			["succeeded", "failed", "interrupted"].includes(query.state.data.status)
				? false
				: 1000,
	});
	useEffect(() => {
		const artifact = generation.data?.artifacts?.[0];
		if (!artifact?.analysis_id || !artifact.revision_id) return;
		const key = `${generation.data?.id}:${artifact.analysis_id}:${artifact.revision_id}`;
		if (openedGenerationArtifact.current === key) return;
		openedGenerationArtifact.current = key;
		void client.invalidateQueries({ queryKey: analysisKeys.list(id) });
		void client.invalidateQueries({ queryKey: ["catalog"] });
		const latest = readSegmentLocation(locationRef.current.latest.search);
		const expected = generation.data
			? readingPositionForJob(
					jobReading.current,
					requestReading.current,
					generation.data,
				)
			: undefined;
		if (!shouldOpenArtifact(expected, latest)) return;
		updateLocation({
			analysisId: artifact.analysis_id,
			revisionId: artifact.revision_id,
		});
	}, [generation.data, client, id, updateLocation]);
	const segment = useQuery({
		queryKey: queries.segment(id),
		queryFn: () => getSegment(id),
	});
	useEffect(() => {
		if (!segment.isSuccess || !workspaceRef.current) return;
		const observer = new ResizeObserver(() => {
			setWorkspaceWidth(workspaceRef.current?.clientWidth ?? 0);
		});
		observer.observe(workspaceRef.current);
		return () => observer.disconnect();
	}, [segment.isSuccess]);
	useEffect(() => {
		if (
			compact &&
			chatOpen &&
			readerRef.current?.contains(document.activeElement)
		)
			discussionClose.current?.focus();
	}, [compact, chatOpen]);
	const source = useQuery({
		queryKey: queries.source(segment.data?.source_id ?? ""),
		queryFn: () => getSource(segment.data?.source_id ?? ""),
		enabled: segment.isSuccess,
	});
	const impact = useQuery({
		queryKey: queries.segmentImpact(id),
		queryFn: () => getSegmentDeleteImpact(id),
		enabled: deleting,
		staleTime: 0,
	});
	const update = useMutation({
		mutationFn: async (fields: SegmentFields) => {
			const body = segment.data?.text_locked_at
				? {
						translation: fields.translation,
						context_before: fields.context_before,
						context_after: fields.context_after,
						transcription: fields.transcription,
						note: fields.note,
						source_ref: fields.source_ref,
					}
				: fields;
			const { data, error, response } = await api.PATCH(
				"/api/segments/{segment_id}",
				{ params: { path: { segment_id: id } }, body },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			if (activeId.current === id) setEditing(null);
			void client.invalidateQueries({ queryKey: queries.segment(id) });
			void client.invalidateQueries({ queryKey: ["catalog"] });
			if (segment.data)
				void client.invalidateQueries({
					queryKey: queries.segments(segment.data.source_id),
				});
		},
	});
	const remove = useMutation({
		mutationFn: async () => {
			const latest = await impact.refetch();
			if (latest.isError || !latest.data)
				throw latest.error ?? new Error("无法核对删除范围，请重试。");
			if (
				latest.data.thread_count !== impact.data?.thread_count ||
				latest.data.message_count !== impact.data?.message_count ||
				latest.data.active_job_count !== impact.data?.active_job_count
			)
				throw new Error("删除范围刚刚变化，请核对最新影响后再次确认。");
			const { error, response } = await api.DELETE(
				"/api/segments/{segment_id}",
				{ params: { path: { segment_id: id } } },
			);
			if (error || !response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: () => {
			if (segment.data) {
				void client.invalidateQueries({
					queryKey: queries.segments(segment.data.source_id),
				});
				void client.invalidateQueries({
					queryKey: queries.source(segment.data.source_id),
				});
			}
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: ["catalog"] });
			if (activeId.current === id)
				navigate(segment.data ? `/sources/${segment.data.source_id}` : "/");
		},
	});
	const current = segment.data;
	return (
		<SegmentFrame
			returnTo={returnTo}
			chatOpen={chatOpen}
			available={segment.isSuccess}
			onToggleDiscussion={() => setChatOpen(!chatOpen)}
			onEdit={() => {
				update.reset();
				setEditing("segment-more-trigger");
			}}
			onDelete={() => setDeleting(true)}
		>
			{segment.isError ? (
				<div className="segment-page-state" role="alert">
					<h1>
						{segment.error instanceof RequestError &&
						segment.error.status === 404
							? "找不到这条记录"
							: "暂时无法加载"}
					</h1>
					<InlineError error={segment.error} />
					{!(
						segment.error instanceof RequestError &&
						segment.error.status === 404
					) && (
						<button
							className="button secondary"
							type="button"
							onClick={() => void segment.refetch()}
						>
							重试
						</button>
					)}
				</div>
			) : !current ? (
				<p className="segment-page-state" role="status">
					正在加载片段…
				</p>
			) : (
				<div
					className={`segment-shell ${chatOpen ? "" : "conversation-closed"}`}
				>
					<div
						className="segment-workspace"
						ref={workspaceRef}
						style={
							{
								"--conversation-width": `${conversationWidth}px`,
							} as CSSProperties
						}
					>
						<section
							className="segment-reader"
							ref={readerRef}
							aria-label="片段阅读与讲解"
							inert={compact && chatOpen}
							aria-hidden={compact && chatOpen}
						>
							<div className="segment-reader-inner">
								<header className="segment-identity">
									<Link to={`/sources/${current.source_id}`}>
										{source.data?.title ?? "所属来源"}
									</Link>
									<span aria-hidden="true">／</span>
									<span>片段</span>
								</header>
								<SegmentMaterialOrigin segment={current} />
								<OriginalCard
									segment={current}
									returnFocusId={
										compact && chatOpen
											? "segment-discussion-toggle"
											: "segment-original-trigger"
									}
									onEdit={() => {
										update.reset();
										setEditing(
											compact && chatOpen
												? "segment-discussion-toggle"
												: "segment-original-trigger",
										);
									}}
								/>
								<section
									ref={analysisRef}
									id="segment-analyses"
									aria-label="讲解"
									className="segment-analyses"
								>
									<AnalysisPanel
										segmentId={current.id}
										selectedId={selectedAnalysis}
										revisionId={selectedRevision}
										onSelect={selectAnalysis}
										onEdit={
											segment.isSuccess
												? (document) =>
														setAnalysisEditor({
															segment: current,
															initial: document,
															restoreFocusId: `manual-analysis-edit-${document.id}`,
														})
												: undefined
										}
										toolbarActions={
											<NewAnalysisActions
												disabled={!segment.isSuccess}
												generationDisabled={Boolean(
													generation.data && !isTerminalJob(generation.data),
												)}
												onCreate={() =>
													setAnalysisEditor({
														segment: current,
														restoreFocusId: "manual-analysis-create",
													})
												}
												onGenerate={() => {
													setChatOpen(true);
													setGenerateToken(crypto.randomUUID());
												}}
											/>
										}
									>
										{generation.data && (
											<AnalysisGenerationStatus
												job={generation.data}
												onSelect={selectAnalysis}
											/>
										)}
									</AnalysisPanel>
								</section>
							</div>
						</section>
						<aside
							id="segment-conversation"
							className="segment-conversation"
							ref={conversationRef}
							hidden={!chatOpen}
							onKeyDown={(event) => {
								if (
									event.key === "Escape" &&
									!event.defaultPrevented &&
									!document.querySelector("dialog[open], :popover-open")
								) {
									event.stopPropagation();
									setChatOpen(false);
								}
							}}
						>
							<div className="segment-discussion-heading">
								<strong>片段讨论</strong>
								<button
									ref={discussionClose}
									type="button"
									onClick={() => setChatOpen(false)}
								>
									{compact ? "返回阅读" : "收起讨论"}
								</button>
							</div>
							<hr
								className="conversation-resizer"
								aria-label="调整对话栏宽度"
								aria-controls="segment-conversation"
								aria-orientation="vertical"
								aria-valuemin={widthRange.min}
								aria-valuemax={widthRange.max}
								aria-valuenow={Math.round(
									clampConversationWidth(conversationWidth, workspaceWidth),
								)}
								tabIndex={0}
								onPointerDown={(event) => {
									if (event.button !== 0 || !conversationRef.current) return;
									event.preventDefault();
									const width =
										conversationRef.current.getBoundingClientRect().width;
									resizeStart.current = {
										pointerId: event.pointerId,
										x: event.clientX,
										width,
										lastWidth: width,
									};
									event.currentTarget.setPointerCapture(event.pointerId);
								}}
								onPointerMove={(event) => {
									const start = resizeStart.current;
									if (!start || start.pointerId !== event.pointerId) return;
									const width = Math.round(
										clampConversationWidth(
											start.width + start.x - event.clientX,
											workspaceRef.current?.clientWidth ?? 0,
										),
									);
									start.lastWidth = width;
									setConversationWidth(width);
								}}
								onPointerUp={(event) => {
									if (resizeStart.current?.pointerId !== event.pointerId)
										return;
									saveConversationWidth(resizeStart.current.lastWidth);
									resizeStart.current = null;
								}}
								onPointerCancel={() => {
									resizeStart.current = null;
								}}
								onKeyDown={(event) => {
									const step = event.shiftKey ? 48 : 16;
									const currentWidth = clampConversationWidth(
										conversationWidth,
										workspaceRef.current?.clientWidth ?? 0,
									);
									const next =
										event.key === "ArrowLeft"
											? currentWidth + step
											: event.key === "ArrowRight"
												? currentWidth - step
												: event.key === "Home"
													? widthRange.min
													: event.key === "End"
														? widthRange.max
														: null;
									if (next === null) return;
									event.preventDefault();
									const width = clampConversationWidth(
										next,
										workspaceRef.current?.clientWidth ?? 0,
									);
									setConversationWidth(width);
									saveConversationWidth(width);
								}}
							/>
							{workbenchMounted && (
								<Workbench
									key={current.id}
									segment={current}
									selectedThreadId={selectedThread}
									onSelectThread={(threadId) =>
										updateLocation({ threadId, chatOpen: true })
									}
									generateToken={generateToken}
									onGenerationAccepted={(job: Job) => {
										if (activeId.current !== id) return;
										setGenerationJobId(job.id);
										updateLocation({ threadId: job.thread_id });
										setGenerateToken(null);
									}}
									onSubmissionStarted={(requestId) => {
										const latest = readSegmentLocation(
											locationRef.current.latest.search,
										);
										requestReading.current = captureReadingPosition(
											requestReading.current,
											requestId,
											latest,
										);
									}}
									onJobAccepted={(job: Job) => {
										jobReading.current[job.id] = requestReading.current[
											job.request_id
										] ?? { analysisId: null, revisionId: null };
									}}
									onOpenArtifact={(analysisId, revisionId, job) => {
										const latest = readSegmentLocation(
											locationRef.current.latest.search,
										);
										if (
											job &&
											!shouldOpenArtifact(
												readingPositionForJob(
													jobReading.current,
													requestReading.current,
													job,
												),
												latest,
											)
										)
											return;
										selectAnalysis(analysisId, revisionId);
									}}
								/>
							)}
						</aside>
					</div>
					{editing && (
						<ConfirmDialog
							titleId="edit-segment-title"
							restoreFocusId={editing}
							onClose={() => setEditing(null)}
						>
							<h2 id="edit-segment-title">编辑片段</h2>
							<div className="segment-editor">
								<SegmentForm
									key={current.updated_at}
									initial={current}
									onSave={(fields) => update.mutate(fields)}
									onCancel={() => setEditing(null)}
									pending={update.isPending}
									error={update.error}
									submitLabel="保存更改"
								/>
							</div>
						</ConfirmDialog>
					)}
					{deleting && (
						<ConfirmDialog
							titleId="delete-segment-title"
							restoreFocusId="segment-more-trigger"
							onClose={() => setDeleting(false)}
						>
							<p className="eyebrow">删除确认</p>
							<h2 id="delete-segment-title">删除这个片段？</h2>
							<blockquote lang="ja">
								{current.text.slice(0, 140)}
								{current.text.length > 140 ? "…" : ""}
							</blockquote>
							{impact.isPending ? (
								<p>正在读取当前影响范围…</p>
							) : impact.isError ? (
								<InlineError error={impact.error} />
							) : (
								<p>
									这会一并删除 {impact.data.thread_count} 条讨论和{" "}
									{impact.data.message_count} 条消息。
									{impact.data.active_job_count > 0 &&
										`其中 ${impact.data.active_job_count} 个进行中的任务会被中断。`}
									来源本身及其他片段保留。删除后无法从页面恢复。
								</p>
							)}
							<InlineError error={remove.error} />
							<div className="actions">
								<button
									className="button danger"
									type="button"
									disabled={!impact.isSuccess || remove.isPending}
									onClick={() => remove.mutate()}
								>
									{remove.isPending ? "删除中…" : "确认删除"}
								</button>
								<button
									className="button secondary"
									type="button"
									disabled={remove.isPending}
									onClick={() => setDeleting(false)}
								>
									取消
								</button>
							</div>
						</ConfirmDialog>
					)}
				</div>
			)}
			{analysisEditor && (
				<AnalysisEditor
					segment={analysisEditor.segment}
					initial={analysisEditor.initial}
					refreshError={segment.isError ? segment.error : null}
					restoreFocusId={analysisEditor.restoreFocusId}
					onClose={() => setAnalysisEditor(null)}
					onSaved={(result) => {
						if (activeId.current !== id) return;
						setAnalysisEditor(null);
						const target = savedAnalysisLocation(result);
						selectAnalysis(target.analysisId, target.revisionId);
					}}
				/>
			)}
		</SegmentFrame>
	);
}
