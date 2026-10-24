import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ConfirmDialog, InlineError } from "../Shared";
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
	const [deleting, setDeleting] = useState(false);
	const selectedRef = useRef(selectedId);
	useEffect(() => {
		selectedRef.current = selectedId;
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
		queryKey: analysisKeys.impact(effectiveId ?? ""),
		queryFn: () => getAnalysisImpact(effectiveId ?? ""),
		enabled: deleting && Boolean(document),
		staleTime: 0,
	});
	const remove = useMutation({
		mutationFn: async () => {
			if (!document) throw new Error("请先打开当前片段的讲解。");
			const fresh = await impact.refetch();
			if (fresh.isError || !fresh.data)
				throw fresh.error ?? new Error("无法核对删除影响，请重试。");
			if (
				fresh.data.revision_count !== impact.data?.revision_count ||
				fresh.data.section_count !== impact.data?.section_count ||
				fresh.data.occurrence_count !== impact.data?.occurrence_count
			)
				throw new Error("删除影响刚刚变化，请核对后再确认。");
			await deleteAnalysis(document.id);
			return document.id;
		},
		onSuccess: (deletedId) => {
			setDeleting(false);
			client.removeQueries({ queryKey: ["analysis", deletedId] });
			client.removeQueries({ queryKey: analysisKeys.impact(deletedId) });
			if (selectedRef.current === deletedId) onSelect(null, null);
			void client.invalidateQueries({ queryKey: analysisKeys.list(segmentId) });
			void client.invalidateQueries({ queryKey: ["catalog"] });
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
				setDeleting(false);
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
									<Markdown text={presentation.title.markdown} />
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
											查看当前版本
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
							onDelete={() => {
								remove.reset();
								setDeleting(true);
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
								<Markdown text={block.raw} />
							</section>
						) : (
							<span key={block.id ?? index} id={anchor} />
						);
					})}
				</article>
			)}
			{deleting && document && (
				<ConfirmDialog
					titleId="delete-analysis-title"
					onClose={() => setDeleting(false)}
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
							disabled={!impact.isSuccess || remove.isPending}
							onClick={() => remove.mutate()}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							type="button"
							className="button secondary"
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

function DocumentActions({
	document,
	fetching,
	onEdit,
	onDelete,
}: {
	document: AnalysisDetail;
	fetching: boolean;
	onEdit?: (document: AnalysisDetail) => void;
	onDelete: () => void;
}) {
	const menuId = useId();
	const versionTitleId = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const lastItemFirst = useRef(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [versionOpen, setVersionOpen] = useState(false);
	const positionMenu = useCallback(() => {
		const element = menu.current;
		const box = trigger.current?.getBoundingClientRect();
		if (!element || !box) return;
		const bounds = element.getBoundingClientRect();
		element.style.top = `${Math.max(8, Math.min(box.bottom + 6, window.innerHeight - bounds.height - 8))}px`;
		element.style.right = `${Math.max(8, Math.min(window.innerWidth - bounds.width - 8, window.innerWidth - box.right))}px`;
	}, []);
	useLayoutEffect(() => {
		if (!menuOpen) return;
		positionMenu();
		const controls =
			menu.current?.querySelectorAll<HTMLButtonElement>("button");
		(lastItemFirst.current ? controls?.item(1) : controls?.item(0))?.focus();
		lastItemFirst.current = false;
	}, [menuOpen, positionMenu]);
	useEffect(() => {
		if (!menuOpen) return;
		window.addEventListener("resize", positionMenu);
		window.addEventListener("scroll", positionMenu, true);
		return () => {
			window.removeEventListener("resize", positionMenu);
			window.removeEventListener("scroll", positionMenu, true);
		};
	}, [menuOpen, positionMenu]);
	const closeMenu = () => {
		menu.current?.hidePopover();
		trigger.current?.focus();
	};
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
				ref={trigger}
				className="analysis-menu-trigger"
				aria-label={`「${document.title}」的更多操作`}
				title="更多操作"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				popoverTarget={menuId}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					lastItemFirst.current = event.key === "ArrowUp";
					menu.current?.showPopover();
				}}
			>
				<span aria-hidden="true">···</span>
			</button>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				className="analysis-document-menu"
				role="menu"
				aria-label={`「${document.title}」的更多操作`}
				onToggle={(event) => {
					setMenuOpen(event.newState === "open");
					if (
						event.newState === "closed" &&
						(menu.current?.contains(globalThis.document.activeElement) ||
							globalThis.document.activeElement === globalThis.document.body)
					)
						trigger.current?.focus();
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape" || event.key === "Tab") {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
						}
						closeMenu();
						return;
					}
					const controls = Array.from(
						event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
					);
					const index = controls.indexOf(
						globalThis.document.activeElement as HTMLButtonElement,
					);
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? controls.length - 1
								: event.key === "ArrowDown"
									? (index + 1) % controls.length
									: event.key === "ArrowUp"
										? (index - 1 + controls.length) % controls.length
										: null;
					if (next !== null) {
						event.preventDefault();
						controls[next]?.focus();
					}
				}}
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
