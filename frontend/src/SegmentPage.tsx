import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AnalysisPanel } from "./analysis/AnalysisPanel";
import { analysisKeys } from "./analysis/api";
import { api } from "./api/client";
import { chatKeys, getJob, type Job } from "./chat/api";
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
	ConfirmDialog,
	dateLabel,
	InlineError,
	Loading,
	PageError,
} from "./Shared";

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
	const client = useQueryClient();
	const activeId = useRef<string | null>(id);
	activeId.current = id;
	useEffect(() => {
		return () => {
			activeId.current = null;
		};
	}, []);
	const [editing, setEditing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [chatOpen, setChatOpen] = useState(true);
	const [readerTab, setReaderTab] = useState<"source" | "analysis">("source");
	const [selectedAnalysis, setSelectedAnalysis] = useState<string | null>(null);
	const [selectedRevision, setSelectedRevision] = useState<string | null>(null);
	const [generateToken, setGenerateToken] = useState<string | null>(null);
	const [generationJobId, setGenerationJobId] = useState<string | null>(null);
	const openedGenerationArtifact = useRef<string | null>(null);
	const generation = useQuery({
		queryKey: chatKeys.job(generationJobId ?? ""),
		queryFn: () => getJob(generationJobId ?? ""),
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
		setSelectedAnalysis(artifact.analysis_id);
		setSelectedRevision(artifact.revision_id);
		setReaderTab("analysis");
		void client.invalidateQueries({ queryKey: analysisKeys.list(id) });
	}, [generation.data, client, id]);
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
		<div className={`segment-shell ${chatOpen ? "" : "conversation-closed"}`}>
			<nav className="segment-rail" aria-label="工作台导航">
				<Link
					to={`/sources/${current.source_id}`}
					title="返回来源"
					aria-label="返回来源"
				>
					<WorkspaceIcon name="back" />
				</Link>
				<span className="segment-rail-rule" />
				<span className="segment-rail-active" title="阅读片段">
					<WorkspaceIcon name="read" />
				</span>
				<button
					type="button"
					className={chatOpen ? "segment-rail-active" : ""}
					title={chatOpen ? "收起对话" : "展开对话"}
					aria-label={chatOpen ? "收起对话" : "展开对话"}
					aria-pressed={chatOpen}
					onClick={() => setChatOpen(!chatOpen)}
				>
					<WorkspaceIcon name="chat" />
				</button>
				<Link
					className="segment-rail-settings"
					to="/settings"
					title="设置"
					aria-label="设置"
				>
					<WorkspaceIcon name="settings" />
				</Link>
			</nav>
			<header className="segment-toolbar">
				<div className="segment-toolbar-title">
					<strong>{source.data?.title ?? "来源"}</strong>
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
			<div className="segment-workspace">
				<main className="segment-reader">
					<div className="segment-reader-inner">
						<div className="reader-tabs" role="tablist" aria-label="阅读内容">
							<button
								type="button"
								role="tab"
								aria-selected={readerTab === "source"}
								onClick={() => setReaderTab("source")}
							>
								原文
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={readerTab === "analysis"}
								onClick={() => setReaderTab("analysis")}
							>
								讲解
							</button>
						</div>
						<div hidden={readerTab !== "source"}>
							<div className="segment-reader-label">
								<span>原文</span>
								<span>{dateLabel(current.created_at)} 保存</span>
							</div>
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
										<DetailField label="具体出处" value={current.source_ref} />
										<DetailField label="个人管理备注" value={current.note} />
									</div>
								</details>
							)}
						</div>
						<div hidden={readerTab !== "analysis"}>
							<AnalysisPanel
								segmentId={current.id}
								selectedId={selectedAnalysis}
								revisionId={selectedRevision}
								onSelect={(analysisId, revisionId) => {
									setSelectedAnalysis(analysisId || null);
									setSelectedRevision(revisionId);
									setReaderTab("analysis");
								}}
								onGenerate={() => {
									setChatOpen(true);
									setReaderTab("analysis");
									setGenerateToken(crypto.randomUUID());
								}}
								job={generation.data}
							/>
						</div>
					</div>
				</main>
				<aside className="segment-conversation" hidden={!chatOpen}>
					<Workbench
						key={current.id}
						segment={current}
						generateToken={generateToken}
						onGenerationAccepted={(job: Job) => {
							setGenerationJobId(job.id);
							setGenerateToken(null);
						}}
						onOpenArtifact={(analysisId, revisionId) => {
							setSelectedAnalysis(analysisId);
							setSelectedRevision(revisionId);
							setReaderTab("analysis");
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
	);
}
