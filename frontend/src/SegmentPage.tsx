import "./materials/reader-refresh.css";
import "./segments/layout.css";
import "./segments/segment-speech.css";
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
import { AnalysisPanel } from "./analysis/AnalysisPanel";
import type { AnalysisDetail } from "./analysis/api";
import { savedAnalysisLocation } from "./analysis/editor";
import { api } from "./api/client";
import type { Job } from "./chat/api";
import {
	captureReadingPosition,
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
	getSegment,
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
import { changedSegmentFields, segmentEditFields } from "./segments/edit";
import { NewAnalysisActions } from "./segments/NewAnalysisActions";
import { OriginalCard } from "./segments/OriginalCard";
import { SegmentDeleteDialog } from "./segments/SegmentDeleteDialog";
import { SegmentFrame } from "./segments/SegmentFrame";
import { SpeechPlaybackBar, useStopSpeechOnLeave } from "./speech";

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
	const editSnapshot = useRef<Segment | null>(null);
	const { id = "" } = useParams();
	useStopSpeechOnLeave(id);
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
		focusReturn: boolean;
	} | null>(null);
	const selectAnalysis = (
		analysisId: string | null,
		revisionId: string | null,
		focusReturn = false,
	) => {
		if (analysisId && !selectedAnalysis)
			analysisListScroll.current = readerRef.current?.scrollTop ?? null;
		setPendingReadingScroll({
			analysisId,
			revisionId,
			focusReturn,
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
		if (pending.focusReturn)
			section
				.querySelector<HTMLButtonElement>("#analysis-list-return")
				?.focus({ preventScroll: true });
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
	const speechDockRef = useRef<HTMLDivElement>(null);
	const conversationRef = useRef<HTMLElement>(null);
	const resizeStart = useRef<{
		pointerId: number;
		x: number;
		width: number;
		lastWidth: number;
	} | null>(null);
	const widthRange = conversationWidthRange(workspaceWidth);
	const [explainToken, setExplainToken] = useState<string | null>(null);
	const [discussionActivated, setDiscussionActivated] = useState(false);
	const workbenchMounted = shouldMountWorkbench(
		discussionActivated,
		chatOpen,
		explainToken,
	);
	useEffect(() => {
		if (workbenchMounted) setDiscussionActivated(true);
	}, [workbenchMounted]);
	const jobReading = useRef<
		Record<string, { analysisId: string | null; revisionId: string | null }>
	>({});
	const requestReading = useRef<
		Record<string, { analysisId: string | null; revisionId: string | null }>
	>({});
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
	useLayoutEffect(() => {
		const workspace = workspaceRef.current;
		const dock = speechDockRef.current;
		if (!segment.isSuccess || !workspace || !dock) return;
		const updateHeight = () => {
			workspace.style.setProperty(
				"--segment-speech-height",
				`${dock.getBoundingClientRect().height}px`,
			);
		};
		updateHeight();
		const observer = new ResizeObserver(updateHeight);
		observer.observe(dock);
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
	const [conflictReadVersion, setConflictReadVersion] = useState(0);
	const update = useMutation({
		mutationFn: async (fields: SegmentFields) => {
			const initial = editSnapshot.current;
			if (!initial) throw new Error("无法读取编辑依据，请重新打开片段编辑。");
			const body = changedSegmentFields(fields, initial);
			if (Object.keys(body).length === 0) return initial;
			const { data, error, response } = await api.PATCH(
				"/api/segments/{segment_id}",
				{
					params: { path: { segment_id: id } },
					body: {
						...body,
						expected_revision: initial.revision,
					},
				},
			);
			return requireData(data, error, response.status);
		},
		onError: (error) => {
			if (error instanceof RequestError && error.status === 409)
				setConflictReadVersion((version) => version + 1);
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
	const editConflicted =
		update.error instanceof RequestError && update.error.status === 409;
	const conflictCurrent = useQuery({
		queryKey: ["segment-edit-current", id, conflictReadVersion],
		queryFn: async () => {
			const fresh = await getSegment(id);
			client.setQueryData(queries.segment(id), fresh);
			return fresh;
		},
		enabled: Boolean(editing) && editConflicted,
		retry: false,
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
				editSnapshot.current = segment.data
					? structuredClone(segment.data)
					: null;
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
									sourceQuery={source}
									interactive={!(compact && chatOpen)}
									returnFocusId={
										compact && chatOpen
											? "segment-discussion-toggle"
											: "segment-original-trigger"
									}
									onEdit={() => {
										update.reset();
										editSnapshot.current = structuredClone(current);
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
												onCreate={() =>
													setAnalysisEditor({
														segment: current,
														restoreFocusId: "manual-analysis-create",
													})
												}
												onExplain={() => {
													setChatOpen(true);
													setExplainToken(crypto.randomUUID());
												}}
											/>
										}
									></AnalysisPanel>
								</section>
							</div>
						</section>
						<div className="segment-speech-dock" ref={speechDockRef}>
							<SpeechPlaybackBar />
						</div>
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
									headerAction={
										<button
											ref={discussionClose}
											className="chat-icon-button"
											type="button"
											aria-label={compact ? "返回阅读" : "收起讨论"}
											title={compact ? "返回阅读" : "收起讨论"}
											data-tooltip={compact ? "返回阅读" : "收起讨论"}
											onClick={() => setChatOpen(false)}
										>
											<svg
												aria-hidden="true"
												width="18"
												height="18"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="1.6"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<rect x="3" y="4" width="18" height="16" rx="2" />
												<path d="M15 4v16" />
											</svg>
										</button>
									}
									segment={current}
									selectedThreadId={selectedThread}
									onSelectThread={(threadId) =>
										updateLocation({ threadId, chatOpen: true })
									}
									explainToken={explainToken}
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
					{deleting && (
						<SegmentDeleteDialog
							segment={current}
							restoreFocusId="segment-more-trigger"
							close={() => setDeleting(false)}
							onDeleted={() => {
								if (activeId.current === id)
									navigate(`/sources/${current.source_id}`);
							}}
						/>
					)}
				</div>
			)}
			{editing && editSnapshot.current && (
				<ConfirmDialog
					titleId="edit-segment-title"
					restoreFocusId={editing}
					onClose={() => setEditing(null)}
				>
					<h2 id="edit-segment-title">编辑片段资料</h2>
					<div className="segment-editor">
						{editConflicted && (
							<section aria-label="当前已保存内容">
								<h3>当前已保存内容</h3>
								{conflictCurrent.isFetching ? (
									<p role="status">正在读取当前内容…</p>
								) : conflictCurrent.isError ? (
									<>
										<InlineError error={conflictCurrent.error} />
										<button
											type="button"
											onClick={() => void conflictCurrent.refetch()}
										>
											重试读取当前内容
										</button>
									</>
								) : conflictCurrent.data ? (
									<>
										{segmentEditFields.map(([name, label]) => (
											<div key={name} className="segment-material-field">
												<h4>
													{name === "source_ref" &&
													conflictCurrent.data.material_provenance
														? "出处补充"
														: label}
												</h4>
												<p style={{ whiteSpace: "pre-wrap" }}>
													{conflictCurrent.data[name] || "（空）"}
												</p>
											</div>
										))}
										<button
											type="button"
											onClick={() => {
												if (
													!editSnapshot.current ||
													!conflictCurrent.data ||
													conflictCurrent.isFetching ||
													conflictCurrent.isError
												)
													return;
												editSnapshot.current = {
													...editSnapshot.current,
													revision: conflictCurrent.data.revision,
												};
												update.reset();
											}}
										>
											已核对，允许按当前版本保存草稿
										</button>
									</>
								) : null}
							</section>
						)}
						<SegmentForm
							key={id}
							initial={editSnapshot.current}
							onSave={(fields) => update.mutate(fields)}
							onCancel={() => setEditing(null)}
							pending={update.isPending}
							submitDisabled={editConflicted}
							error={
								update.error instanceof RequestError &&
								update.error.status === 409
									? new Error(
											"片段已被其他操作更新，草稿已保留。请核对上方的当前内容，再明确重试保存。",
										)
									: update.error
							}
							submitLabel="保存更改"
						/>
					</div>
				</ConfirmDialog>
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
						selectAnalysis(
							target.analysisId,
							target.revisionId,
							!analysisEditor.initial,
						);
					}}
				/>
			)}
		</SegmentFrame>
	);
}
