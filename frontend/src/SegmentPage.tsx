import "./materials/reader-refresh.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { AnalysisPanel } from "./analysis/AnalysisPanel";
import { analysisKeys } from "./analysis/api";
import { api } from "./api/client";
import { chatKeys, getJob, type Job } from "./chat/api";
import {
	captureReadingPosition,
	freshestJob,
	readingPositionForJob,
	shouldOpenArtifact,
} from "./chat/discussion";
import {
	clampConversationWidth,
	conversationWidthRange,
	MAX_CONVERSATION_WIDTH,
	MIN_CONVERSATION_WIDTH,
} from "./chat/layout";
import { Workbench } from "./chat/Workbench";
import {
	errorMessage,
	getSegment,
	getSegmentDeleteImpact,
	getSource,
	queries,
	requireData,
	type SegmentFields,
} from "./content";
import { SegmentForm } from "./Forms";
import {
	readSegmentLocation,
	returnDestination,
	type SegmentLocation,
	updateSegmentLocation,
} from "./navigation";
import {
	ConfirmDialog,
	dateLabel,
	InlineError,
	Loading,
	PageError,
	Shell,
} from "./Shared";

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

function WorkspaceIcon({
	name,
}: {
	name: "back" | "read" | "chat" | "settings" | "more" | "edit";
}) {
	const path = {
		back: <path d="m14 5-7 7 7 7M7 12h12" />,
		read: (
			<>
				<path d="M12 20c-2.5-1.8-5.2-2.2-9-1.4V4.5c3.8-.8 6.5-.4 9 1.4 2.5-1.8 5.2-2.2 9-1.4v14.1c-3.8-.8-6.5-.4-9 1.4Z" />
				<path d="M12 5.9V20" />
			</>
		),
		chat: (
			<path d="M20 11.5a8 8 0 0 1-8 8 8.5 8.5 0 0 1-3.3-.7L4 20l1.2-4.7A8 8 0 1 1 20 11.5Z" />
		),
		settings: (
			<>
				<circle cx="12" cy="12" r="3" />
				<path d="M19 12a7 7 0 0 0-.1-1.2l1.7-1.3-1.7-3-2 .8a7 7 0 0 0-2-1.2L14.5 4h-3l-.4 2.1a7 7 0 0 0-2 1.2l-2-.8-1.7 3 1.7 1.3a7 7 0 0 0 0 2.4l-1.7 1.3 1.7 3 2-.8a7 7 0 0 0 2 1.2l.4 2.1h3l.4-2.1a7 7 0 0 0 2-1.2l2 .8 1.7-3-1.7-1.3A7 7 0 0 0 19 12Z" />
			</>
		),
		more: (
			<>
				<circle cx="5" cy="12" r="1" />
				<circle cx="12" cy="12" r="1" />
				<circle cx="19" cy="12" r="1" />
			</>
		),
		edit: (
			<>
				<path d="M4 20h4l11-11-4-4L4 16v4Z" />
				<path d="m13 7 4 4" />
			</>
		),
	}[name];
	return (
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
			{path}
		</svg>
	);
}

function DetailField({
	label,
	value,
	lang,
}: {
	label: string;
	value: string;
	lang?: string;
}) {
	return value ? (
		<div className="detail-field">
			<h3>{label}</h3>
			<p lang={lang}>{value}</p>
		</div>
	) : null;
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
	const setChatOpen = (open: boolean) => updateLocation({ chatOpen: open });
	const [originalExpanded, setOriginalExpanded] = useState(false);
	const originalRef = useRef<HTMLElement>(null);
	const analysisRef = useRef<HTMLElement>(null);
	const readerRef = useRef<HTMLElement>(null);
	const scrollReading = (target: "original" | "analysis") => {
		requestAnimationFrame(() => {
			const reader = readerRef.current;
			const section =
				target === "original" ? originalRef.current : analysisRef.current;
			if (!reader || !section) return;
			const reference = originalRef.current;
			const inset =
				target === "analysis" &&
				reference &&
				getComputedStyle(reference).position === "sticky"
					? reference.getBoundingClientRect().height + 16
					: 15;
			reader.scrollTo({
				top:
					reader.scrollTop +
					section.getBoundingClientRect().top -
					reader.getBoundingClientRect().top -
					inset,
			});
		});
	};
	const client = useQueryClient();
	useEffect(() => {
		activeId.current = id;
		return () => {
			activeId.current = null;
		};
	}, [id]);
	const [editing, setEditing] = useState(false);
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
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuButtonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!menuOpen) return;
		const closeOutside = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				!menuRef.current?.contains(event.target)
			)
				setMenuOpen(false);
		};
		const closeEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setMenuOpen(false);
			menuButtonRef.current?.focus();
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeEscape);
		};
	}, [menuOpen]);
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
		const reference = originalRef.current;
		const reader = readerRef.current;
		if (!segment.isSuccess || !reference || !reader) return;
		const measureReference = () => {
			reader.style.setProperty(
				"--original-reference-height",
				selectedAnalysis
					? `${reference.getBoundingClientRect().height}px`
					: "0px",
			);
		};
		measureReference();
		const observer = new ResizeObserver(measureReference);
		observer.observe(reference);
		return () => observer.disconnect();
	}, [segment.isSuccess, selectedAnalysis]);
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
			if (activeId.current === id) setEditing(false);
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
	if (segment.isPending) return <Loading />;
	if (segment.isError)
		return (
			<PageError error={segment.error} retry={() => void segment.refetch()} />
		);
	const current = segment.data;
	return (
		<Shell fullWidth>
			<div className={`segment-shell ${chatOpen ? "" : "conversation-closed"}`}>
				<header className="segment-toolbar">
					<div className="segment-toolbar-title">
						<Link to={returnTo.to}>← {returnTo.label}</Link>
						<Link to={`/sources/${current.source_id}`} title="查看所属来源">
							{source.data?.title ?? "来源"}
						</Link>
						<span>{current.source_ref || "片段阅读"}</span>
					</div>
					<div className="segment-toolbar-actions">
						<span className="segment-saved">已保存</span>
						<button
							type="button"
							className="segment-icon-button"
							title={chatOpen ? "收起对话" : "展开对话"}
							aria-label={chatOpen ? "收起对话" : "展开对话"}
							onClick={() => setChatOpen(!chatOpen)}
						>
							<WorkspaceIcon name="chat" />
						</button>
						<div className="segment-menu-wrap" ref={menuRef}>
							<button
								ref={menuButtonRef}
								type="button"
								className="segment-icon-button"
								aria-label="更多片段操作"
								title="更多片段操作"
								aria-expanded={menuOpen}
								onClick={() => setMenuOpen(!menuOpen)}
							>
								<WorkspaceIcon name="more" />
							</button>
							{menuOpen && (
								<div className="segment-menu">
									<button
										type="button"
										onClick={() => {
											update.reset();
											setEditing(true);
											setMenuOpen(false);
										}}
									>
										<WorkspaceIcon name="edit" />
										编辑片段
									</button>
									<button
										type="button"
										className="text-danger"
										onClick={() => {
											setDeleting(true);
											setMenuOpen(false);
										}}
									>
										删除此片段
									</button>
								</div>
							)}
						</div>
					</div>
				</header>
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
					>
						<div className="segment-reader-inner">
							<nav className="reader-navigation" aria-label="片段内容导航">
								<button type="button" onClick={() => scrollReading("original")}>
									原文
								</button>
								<button
									type="button"
									onClick={() => {
										updateLocation({ analysisId: null, revisionId: null });
										scrollReading("analysis");
									}}
								>
									讲解
								</button>
								<button
									type="button"
									aria-expanded={chatOpen}
									aria-controls="segment-conversation"
									onClick={() =>
										updateLocation({ chatOpen: true, threadId: null })
									}
								>
									讨论
								</button>
							</nav>
							<section
								ref={originalRef}
								id="segment-original"
								aria-label="原文"
								className={`original-reading ${selectedAnalysis ? "original-reference" : ""} ${originalExpanded ? "original-expanded" : ""}`}
							>
								<div className="segment-reader-label">
									<span>{selectedAnalysis ? "原文参照" : "原文"}</span>
									{selectedAnalysis && (
										<button
											type="button"
											className="analysis-quiet-button"
											aria-expanded={originalExpanded}
											aria-controls="segment-original-content"
											onClick={() => setOriginalExpanded(!originalExpanded)}
										>
											{originalExpanded ? "收起参照" : "展开原文"}
										</button>
									)}
									<span className="segment-saved-at">
										{dateLabel(current.created_at)} 保存
									</span>
								</div>
								<div
									id="segment-original-content"
									className="original-content"
									tabIndex={selectedAnalysis ? 0 : undefined}
								>
									<p className="segment-original" lang="ja">
										{current.text}
									</p>
									{current.translation && (
										<DetailField label="译文" value={current.translation} />
									)}
									{(current.context_before ||
										current.context_after ||
										current.transcription ||
										current.note ||
										current.source_ref) && (
										<details className="segment-reader-more">
											<summary>补充资料</summary>
											<div className="segment-reader-fields">
												<DetailField
													label="前文"
													value={current.context_before}
													lang="ja"
												/>
												<DetailField
													label="后文"
													value={current.context_after}
													lang="ja"
												/>
												<DetailField
													label="听写"
													value={current.transcription}
													lang="ja"
												/>
												<DetailField
													label="具体出处"
													value={current.source_ref}
												/>
												<DetailField
													label="个人管理备注"
													value={current.note}
												/>
											</div>
										</details>
									)}
								</div>
							</section>
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
									onSelect={(analysisId, revisionId) => {
										updateLocation({
											analysisId: analysisId || null,
											revisionId,
										});
										setOriginalExpanded(false);
										scrollReading("analysis");
									}}
									onGenerate={() => {
										setChatOpen(true);
										setGenerateToken(crypto.randomUUID());
									}}
									onDiscuss={() =>
										updateLocation({ chatOpen: true, threadId: null })
									}
									job={generation.data}
								/>
							</section>
						</div>
					</section>
					<aside
						id="segment-conversation"
						className="segment-conversation"
						ref={conversationRef}
						hidden={!chatOpen}
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
								if (resizeStart.current?.pointerId !== event.pointerId) return;
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
								updateLocation({ analysisId, revisionId });
								setOriginalExpanded(false);
								scrollReading("analysis");
							}}
						/>
					</aside>
				</div>
				{editing && (
					<ConfirmDialog
						titleId="edit-segment-title"
						onClose={() => setEditing(false)}
					>
						<h2 id="edit-segment-title">编辑片段</h2>
						<div className="segment-editor">
							<SegmentForm
								key={current.updated_at}
								initial={current}
								onSave={(fields) => update.mutate(fields)}
								onCancel={() => setEditing(false)}
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
		</Shell>
	);
}
