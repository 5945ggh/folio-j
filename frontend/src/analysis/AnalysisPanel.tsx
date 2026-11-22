import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog, InlineError } from "../Shared";
import { AnalysisRenameDialog } from "./AnalysisRenameDialog";
import {
	type AnalysisDetail,
	analysisKeys,
	deleteAnalysis,
	getAnalysis,
	getAnalysisImpact,
	listAnalyses,
} from "./api";
import { Markdown } from "./Markdown";
import { analysisPresentation } from "./presentation";
import { readingAnalysis } from "./state";
import { useAnalysisActionMenu } from "./useAnalysisActionMenu";
import "./reading.css";

const pageSize = 100;

export function AnalysisPanel({
	segmentId,
	selectedId,
	revisionId,
	onSelect,
	onEdit,
	toolbarActions,
	children,
}: {
	segmentId: string;
	selectedId: string | null;
	revisionId: string | null;
	onSelect: (analysisId: string | null, revisionId: string | null) => void;
	onEdit?: (document: AnalysisDetail) => void;
	toolbarActions?: ReactNode;
	children?: ReactNode;
}) {
	const client = useQueryClient();
	const [deleting, setDeleting] = useState<AnalysisDetail | null>(null);
	const [renaming, setRenaming] = useState<AnalysisDetail | null>(null);
	const selectedRef = useRef(selectedId);
	const submittingDelete = useRef(false);
	useEffect(() => {
		selectedRef.current = selectedId;
		setRenaming((current) => (current?.id === selectedId ? current : null));
	}, [selectedId]);

	const analyses = useInfiniteQuery({
		queryKey: analysisKeys.list(segmentId),
		initialPageParam: 0,
		queryFn: ({ pageParam }) => listAnalyses(segmentId, pageParam),
		getNextPageParam: (last, all) =>
			last.length === pageSize ? all.length * pageSize : undefined,
	});
	const items = analyses.data?.pages.flat() ?? [];
	const effectiveId = selectedId;
	const detail = useQuery({
		queryKey: analysisKeys.detail(effectiveId ?? "", revisionId),
		queryFn: () => getAnalysis(effectiveId ?? "", revisionId),
		enabled: Boolean(effectiveId),
	});
	const document = readingAnalysis(
		detail.data,
		segmentId,
		selectedId,
		detail.isError,
	);
	const presentation = document ? analysisPresentation(document) : null;
	const impact = useQuery({
		queryKey: analysisKeys.impact(deleting?.id ?? ""),
		queryFn: () => getAnalysisImpact(deleting?.id ?? ""),
		enabled: Boolean(deleting),
		staleTime: 0,
	});
	const remove = useMutation({
		mutationFn: async () => {
			if (!deleting) throw new Error("请先打开当前片段的讲解。");
			if (!impact.data || impact.data.analysis_id !== deleting.id)
				throw new Error("无法核对目标讲解，请重新读取删除影响。");
			await deleteAnalysis(deleting.id);
			return deleting.id;
		},
		onSuccess: (deletedId) => {
			setDeleting(null);
			client.removeQueries({ queryKey: ["analysis", deletedId] });
			client.removeQueries({ queryKey: analysisKeys.impact(deletedId) });
			if (selectedRef.current === deletedId) onSelect(null, null);
			void client.invalidateQueries({ queryKey: analysisKeys.list(segmentId) });
			void client.invalidateQueries({ queryKey: ["catalog"] });
		},
		onSettled: () => {
			submittingDelete.current = false;
		},
	});
	const backToList = (
		<button
			id="analysis-list-return"
			type="button"
			className="analysis-back-button"
			aria-label="返回讲解列表"
			title="返回讲解列表"
			onClick={() => {
				setDeleting(null);
				onSelect(null, null);
			}}
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				aria-hidden="true"
			>
				<path d="m14 5-7 7 7 7" />
			</svg>
			{!document && <span>讲解列表</span>}
		</button>
	);
	return (
		<div className="analysis-panel">
			{!effectiveId ? (
				<div className="analysis-toolbar">
					<div className="analysis-picker-wrap">
						<h2>讲解</h2>
					</div>
					<div className="analysis-toolbar-actions">{toolbarActions}</div>
				</div>
			) : !document ? (
				<div className="analysis-return">{backToList}</div>
			) : null}
			{!effectiveId && items.length > 0 && (
				<section className="analysis-list" aria-label="讲解">
					{items.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => {
								onSelect(item.id, null);
							}}
						>
							<strong>{item.title}</strong>
							<small>
								正文摘录：{item.excerpt.slice(0, 90)}
								{item.excerpt.length > 90 ? "…" : ""}
							</small>
						</button>
					))}
				</section>
			)}
			{!effectiveId && analyses.isPending && (
				<p className="loading">正在加载讲解…</p>
			)}
			{!effectiveId && analyses.isError && (
				<>
					<InlineError error={analyses.error} />
					<button
						type="button"
						className="analysis-quiet-button"
						onClick={() => void analyses.refetch()}
					>
						重试加载讲解列表
					</button>
				</>
			)}
			{!effectiveId && analyses.hasNextPage && (
				<button
					type="button"
					className="analysis-quiet-button"
					disabled={analyses.isFetchingNextPage}
					onClick={() => void analyses.fetchNextPage()}
				>
					{analyses.isFetchingNextPage ? "加载中…" : "加载更多讲解"}
				</button>
			)}
			{children}
			{!effectiveId &&
				items.length === 0 &&
				analyses.isSuccess &&
				!children && (
					<div className="analysis-empty">
						<h2>还没有已保存讲解</h2>
						<p>保存的讲解会显示在这里。</p>
					</div>
				)}
			{detail.isPending && effectiveId && (
				<p className="loading">正在打开讲解…</p>
			)}
			{effectiveId && detail.isError && (
				<>
					<InlineError error={detail.error} />
					<button
						type="button"
						className="analysis-quiet-button"
						onClick={() => void detail.refetch()}
					>
						重试打开讲解
					</button>
				</>
			)}
			{effectiveId && detail.isSuccess && detail.data && !document && (
				<p className="inline-error" role="alert">
					这份讲解不属于当前片段，请返回讲解列表选择。
				</p>
			)}
			{document && presentation && (
				<article className="analysis-document" aria-label={document.title}>
					<header
						className="analysis-document-header"
						id={
							presentation.title?.sectionId
								? `analysis-section-${presentation.title.sectionId}`
								: undefined
						}
					>
						{backToList}
						<div className="analysis-document-heading">
							<div className="analysis-document-title">
								{presentation.title ? (
									<Markdown text={presentation.title.markdown} lookup />
								) : (
									<h2>{document.title}</h2>
								)}
							</div>
							<div className="analysis-revision-status">
								{document.revision_id === document.current_revision_id ? (
									<span>当前版本</span>
								) : (
									<>
										<span>历史版本（只读）</span>
										<button
											type="button"
											className="analysis-quiet-button"
											onClick={() => onSelect(document.id, null)}
										>
											回到当前版本
										</button>
									</>
								)}
							</div>
						</div>
						<DocumentActions
							key={`${document.id}-${document.revision_id}`}
							document={document}
							fetching={detail.isFetching}
							onEdit={onEdit}
							onRename={() => setRenaming(document)}
							onDelete={() => {
								remove.reset();
								setDeleting(document);
							}}
						/>
					</header>
					{document.warnings.length > 0 && (
						<details className="analysis-warnings">
							<summary>格式提醒（{document.warnings.length}）</summary>
							<ul>
								{document.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</details>
					)}
					{document.sections.some((section) => section.kind === "section") && (
						<details className="analysis-toc-disclosure">
							<summary>目录</summary>
							<nav className="analysis-toc" aria-label="讲解目录">
								{document.sections
									.filter((section) => section.kind === "section")
									.map((section) => (
										<a
											key={section.id}
											href={`#analysis-section-${section.id}`}
										>
											{section.title ?? "未命名段落"}
										</a>
									))}
							</nav>
						</details>
					)}
					{presentation.blocks.map((block, index) => {
						const anchor =
							block.id && block.id !== presentation.title?.sectionId
								? `analysis-section-${block.id}`
								: undefined;
						return block.raw.trim() ? (
							<section
								key={block.id ?? index}
								id={anchor}
								className="analysis-section"
							>
								<Markdown text={block.raw} lookup />
							</section>
						) : (
							<span key={block.id ?? index} id={anchor} />
						);
					})}
				</article>
			)}
			{renaming && renaming.id === selectedId && (
				<AnalysisRenameDialog
					analysis={renaming}
					onClose={() => setRenaming(null)}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					titleId="delete-analysis-title"
					onClose={() => {
						if (!submittingDelete.current) setDeleting(null);
					}}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id="delete-analysis-title">删除这份讲解？</h2>
					{impact.isPending ? (
						<p>正在核对关联范围…</p>
					) : impact.isError ? (
						<>
							<InlineError error={impact.error} />
							<button
								type="button"
								className="analysis-quiet-button"
								onClick={() => void impact.refetch()}
							>
								重新核对删除影响
							</button>
						</>
					) : (
						<p>
							“{impact.data.title}”的 {impact.data.revision_count} 个修订、
							{impact.data.section_count} 个讲解块及{" "}
							{impact.data.occurrence_count}{" "}
							个关联学习条目会受到影响。片段和对话保留。删除后无法从页面恢复。
						</p>
					)}
					<InlineError error={remove.error} />
					<div className="actions">
						<button
							type="button"
							className="button danger"
							disabled={
								!impact.isSuccess || impact.isFetching || remove.isPending
							}
							onClick={() => {
								if (submittingDelete.current) return;
								submittingDelete.current = true;
								remove.mutate();
							}}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							type="button"
							className="button secondary"
							disabled={remove.isPending}
							data-dialog-cancel
							onClick={() => {
								if (!submittingDelete.current) setDeleting(null);
							}}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
		</div>
	);
}

function DocumentActions({
	document,
	fetching,
	onEdit,
	onRename,
	onDelete,
}: {
	document: AnalysisDetail;
	fetching: boolean;
	onEdit?: (document: AnalysisDetail) => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const { triggerProps, menuProps, closeMenu } = useAnalysisActionMenu();
	const versionTitleId = useId();
	const [versionOpen, setVersionOpen] = useState(false);
	return (
		<div className="analysis-document-actions">
			{document.revision_id === document.current_revision_id && onEdit && (
				<button
					type="button"
					id={`manual-analysis-edit-${document.id}`}
					className="analysis-quiet-button"
					disabled={fetching}
					onClick={() => onEdit(document)}
				>
					编辑
				</button>
			)}
			<button
				type="button"
				{...triggerProps}
				className="analysis-menu-trigger"
				aria-label={`「${document.title}」的更多操作`}
				title="更多操作"
			>
				<span aria-hidden="true">···</span>
			</button>
			<div
				{...menuProps}
				role="menu"
				className="analysis-document-menu popover-motion"
				aria-label={`「${document.title}」的更多操作`}
			>
				<button
					type="button"
					role="menuitem"
					tabIndex={-1}
					onClick={() => {
						closeMenu();
						setVersionOpen(true);
					}}
				>
					版本信息
				</button>
				<button
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={fetching}
					onClick={() => {
						closeMenu();
						onRename();
					}}
				>
					重命名
				</button>
				<button
					type="button"
					role="menuitem"
					tabIndex={-1}
					className="text-danger"
					onClick={() => {
						closeMenu();
						onDelete();
					}}
				>
					删除此讲解
				</button>
			</div>
			{versionOpen && (
				<ConfirmDialog
					titleId={versionTitleId}
					className="analysis-version-dialog"
					onClose={() => setVersionOpen(false)}
				>
					<h2 id={versionTitleId}>版本信息</h2>
					<p className="analysis-version-title">{document.title}</p>
					<p>
						{document.revision_id === document.current_revision_id
							? "正在阅读当前版本。"
							: "正在阅读历史版本，此版本只读。"}
					</p>
					<dl>
						<dt>讲解 ID</dt>
						<dd>{document.id}</dd>
						<dt>所读修订</dt>
						<dd>{document.revision_id}</dd>
						<dt>当前修订</dt>
						<dd>{document.current_revision_id}</dd>
					</dl>
					<button
						type="button"
						className="button secondary"
						data-dialog-cancel
						onClick={() => setVersionOpen(false)}
					>
						关闭
					</button>
				</ConfirmDialog>
			)}
		</div>
	);
}
