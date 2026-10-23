import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { analysisKeys, getAnalysis, listAnalyses } from "../analysis/api";
import { Markdown } from "../analysis/Markdown";
import { analysisPresentation } from "../analysis/presentation";
import { getSegment, queries } from "../content";
import type { ScreenAnchor } from "./reader-study";
import type { ChapterSegment } from "./study-api";
import { studyPreviewPosition } from "./study-overlays";
import { previewAnalyses, previewDocument } from "./study-preview";
import "./study-preview.css";

export type StudyPreviewProps = {
	anchor: ScreenAnchor;
	items: readonly ChapterSegment[];
	fixed?: boolean;
	loading?: boolean;
	expanded: boolean;
	inactive?: boolean;
	embedded?: boolean;
	onExpand: () => void;
	onCollapse: () => void;
	onClose: () => void;
	onOpen: (segmentId: string, analysisId?: string, revisionId?: string) => void;
	onEmphasize: (id: string | null) => void;
};

export function StudyPreview({
	anchor,
	items,
	fixed = false,
	loading = false,
	expanded,
	inactive = false,
	embedded = false,
	onExpand,
	onCollapse,
	onClose,
	onOpen,
	onEmphasize,
}: StudyPreviewProps) {
	const element = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const focusAfterSelection = useRef(false);
	const callbacks = useRef({ onClose, onEmphasize });
	callbacks.current = { onClose, onEmphasize };
	const headingId = useId();
	const pickerId = useId();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [expandedOriginalId, setExpandedOriginalId] = useState<string | null>(
		null,
	);
	const [analysisSelection, setAnalysisSelection] = useState<{
		segmentId: string;
		id: string;
	} | null>(null);
	const automaticId =
		!fixed && items.length === 1 ? items[0]?.segment_id : null;
	const selected = items.find(
		(item) => item.segment_id === (selectedId ?? automaticId),
	);
	const segmentId = selected?.segment_id ?? "";
	const [position, setPosition] = useState({
		left: 12,
		top: 82,
		maxHeight: 420,
	});

	useEffect(() => {
		callbacks.current.onEmphasize(inactive ? null : segmentId || null);
		return () => callbacks.current.onEmphasize(null);
	}, [segmentId, inactive]);
	useEffect(() => {
		const node = element.current;
		if (!node || inactive) return;
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
				return;
			event.preventDefault();
			event.stopPropagation();
			callbacks.current.onClose();
		};
		node.addEventListener("keydown", handleEscape);
		return () => node.removeEventListener("keydown", handleEscape);
	}, [inactive]);
	useLayoutEffect(() => {
		if (expanded || fixed || embedded) return;
		const node = element.current;
		if (!node) return;
		const measure = () =>
			setPosition(
				studyPreviewPosition(
					anchor,
					{ width: window.innerWidth, height: window.innerHeight },
					{ width: node.offsetWidth, height: node.offsetHeight },
				),
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [anchor, expanded, fixed, embedded]);
	useLayoutEffect(() => {
		if (segmentId && content.current) content.current.scrollTop = 0;
		if (focusAfterSelection.current) {
			focusAfterSelection.current = false;
			element.current
				?.querySelector<HTMLButtonElement>("button")
				?.focus({ preventScroll: true });
		}
	}, [segmentId]);

	const segment = useQuery({
		queryKey: queries.segment(segmentId),
		queryFn: () => getSegment(segmentId),
		enabled: Boolean(segmentId) && !inactive,
	});
	const analyses = useInfiniteQuery({
		queryKey: analysisKeys.list(segmentId),
		initialPageParam: 0,
		queryFn: ({ pageParam }) => listAnalyses(segmentId, pageParam),
		getNextPageParam: (last, all) =>
			last.length === 100 ? all.length * 100 : undefined,
		enabled: Boolean(segmentId) && !inactive,
	});
	const analysisItems = previewAnalyses(analyses.data?.pages, segmentId);
	const analysis =
		analysisItems.find(
			(item) =>
				analysisSelection?.segmentId === segmentId &&
				item.id === analysisSelection.id,
		) ?? analysisItems[0];
	const detail = useQuery({
		queryKey: analysisKeys.detail(
			analysis?.id ?? "",
			analysis?.current_revision_id,
		),
		queryFn: () =>
			getAnalysis(analysis?.id ?? "", analysis?.current_revision_id),
		enabled: Boolean(analysis) && !inactive,
	});
	const document = previewDocument(detail.data, segmentId, analysis);
	const presentation = document ? analysisPresentation(document) : null;
	const saved = segment.data?.id === segmentId ? segment.data : null;
	const translation = saved?.translation.trim();
	const original = saved?.text ?? selected?.excerpt ?? "";
	const canReturn = fixed || items.length > 1;
	const select = (id: string | null) => {
		focusAfterSelection.current = true;
		setSelectedId(id);
		setAnalysisSelection(null);
	};

	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: both dialog and the named embedded region support labels.
		<div
			ref={element}
			className={`reader-study-preview${embedded ? " embedded" : ""}${expanded ? " expanded" : ""}${fixed ? " fixed" : ""}${translation ? " has-translation" : ""}`}
			style={expanded || fixed || embedded ? undefined : position}
			role={embedded ? "region" : "dialog"}
			aria-label={embedded ? "学习片段" : undefined}
			aria-labelledby={embedded ? undefined : headingId}
			aria-hidden={inactive || undefined}
			inert={inactive || undefined}
			data-reader-tool=""
			data-reader-panel-side={expanded ? "right" : undefined}
		>
			{!embedded && (
				<header className="reader-study-preview-header">
					<div>
						{selected && canReturn ? (
							<button
								type="button"
								className="reader-study-preview-back"
								onClick={() => select(null)}
							>
								← {fixed ? "本章片段" : "片段列表"}
							</button>
						) : null}
						<strong id={headingId}>
							{selected
								? "学习片段"
								: fixed
									? `本章片段 · ${items.length}`
									: `此处的学习片段 · ${items.length}`}
						</strong>
					</div>
					<div className="reader-study-preview-actions">
						<button
							type="button"
							onClick={expanded ? onCollapse : onExpand}
							aria-label={expanded ? "收起学习片段预览" : "展开学习片段预览"}
							aria-expanded={expanded}
						>
							{expanded ? "收起" : "展开阅读"}
						</button>
						<button
							type="button"
							aria-label="关闭学习片段预览"
							onClick={onClose}
						>
							×
						</button>
					</div>
				</header>
			)}
			{embedded && selected && canReturn && (
				<button
					className="reader-record-back"
					type="button"
					onClick={() => select(null)}
				>
					← 学习片段列表
				</button>
			)}
			<div ref={content} className="reader-study-preview-content">
				{!selected ? (
					<>
						<p className="reader-study-preview-hint">
							选择片段，直接查看已保存的内容。
						</p>
						{loading && <p role="status">正在读取本章片段…</p>}
						{!loading && items.length === 0 && <p>此处暂无可定位片段。</p>}
						<div className="reader-study-preview-candidates">
							{items.map((item) => (
								<button
									type="button"
									key={item.segment_id}
									onClick={() => select(item.segment_id)}
									onMouseEnter={() => onEmphasize(item.segment_id)}
									onMouseLeave={() => onEmphasize(null)}
									onFocus={() => onEmphasize(item.segment_id)}
									onBlur={() => onEmphasize(null)}
								>
									<span lang="ja">{item.excerpt}</span>
									<small>
										{new Date(item.created_at).toLocaleString()} ·{" "}
										{item.segment_id.slice(-6)}
									</small>
								</button>
							))}
						</div>
					</>
				) : (
					<>
						<blockquote
							className={`reader-study-preview-original${expandedOriginalId === segmentId ? " original-expanded" : ""}`}
						>
							<p lang="ja">{original}</p>
							{!expanded && original.length > 70 && (
								<button
									type="button"
									aria-expanded={expandedOriginalId === segmentId}
									onClick={() =>
										setExpandedOriginalId(
											expandedOriginalId === segmentId ? null : segmentId,
										)
									}
								>
									{expandedOriginalId === segmentId ? "收起原文" : "展开原文"}
								</button>
							)}
						</blockquote>
						{saved && analyses.isSuccess && !translation && !analysis && (
							<p className="reader-study-preview-hint">已保存原文</p>
						)}
						{translation && (
							<section
								className="reader-study-preview-translation"
								aria-label="译文"
							>
								<h3>译文</h3>
								<p>{translation}</p>
							</section>
						)}
						{segment.isPending && <p role="status">正在读取片段…</p>}
						{segment.isError && (
							<PreviewError
								error={segment.error}
								onRetry={() => void segment.refetch()}
								label="重试读取片段"
							/>
						)}
						{segment.isSuccess && !saved && (
							<p role="alert">片段资料不匹配，请重新打开。</p>
						)}
						{analyses.isPending && <p role="status">正在读取讲解…</p>}
						{analyses.isError && (
							<PreviewError
								error={analyses.error}
								onRetry={() => void analyses.refetch()}
								label="重试读取讲解列表"
							/>
						)}
						{analysis && (
							<section
								className="reader-study-preview-analysis"
								aria-label="已保存讲解"
							>
								<div className="reader-study-preview-analysis-heading">
									<h3>讲解</h3>
									{analysisItems.length > 1 || analyses.hasNextPage ? (
										<>
											<label
												className="reader-study-preview-sr"
												htmlFor={pickerId}
											>
												选择讲解
											</label>
											<select
												id={pickerId}
												value={analysis.id}
												onChange={(event) =>
													setAnalysisSelection({
														segmentId,
														id: event.target.value,
													})
												}
											>
												{analysisItems.map((item) => (
													<option key={item.id} value={item.id}>
														{item.title}
													</option>
												))}
											</select>
										</>
									) : (
										<strong>{analysis.title}</strong>
									)}
								</div>
								{detail.isPending && <p role="status">正在打开讲解正文…</p>}
								{detail.isError && (
									<PreviewError
										error={detail.error}
										onRetry={() => void detail.refetch()}
										label="重试打开讲解"
									/>
								)}
								{detail.isSuccess && !document && (
									<p role="alert">讲解与当前片段或版本不匹配，请重新选择。</p>
								)}
								{presentation && (
									<div className="reader-study-preview-markdown">
										{presentation.title && (
											<Markdown text={presentation.title.markdown} />
										)}
										{presentation.blocks.map((block, index) => (
											<Markdown key={block.id ?? index} text={block.raw} />
										))}
									</div>
								)}
							</section>
						)}
						{analyses.hasNextPage && (
							<button
								type="button"
								className="reader-study-preview-more"
								disabled={analyses.isFetchingNextPage}
								onClick={() => void analyses.fetchNextPage()}
							>
								{analyses.isFetchingNextPage ? "正在加载…" : "加载更多讲解"}
							</button>
						)}
						{saved?.note.trim() && (
							<p className="reader-study-preview-note">
								<span>个人备注</span>
								{saved.note}
							</p>
						)}
					</>
				)}
			</div>
			{selected && (
				<footer className="reader-study-preview-footer">
					<details className="reader-study-preview-metadata">
						<summary>保存信息</summary>
						<dl>
							<dt>保存于</dt>
							<dd>
								{new Date(
									saved?.created_at ?? selected.created_at,
								).toLocaleString()}
							</dd>
							{saved && (
								<>
									<dt>片段更新于</dt>
									<dd>{new Date(saved.updated_at).toLocaleString()}</dd>
								</>
							)}
							<dt>片段 ID</dt>
							<dd>{segmentId}</dd>
							{analysis && (
								<>
									<dt>讲解更新于</dt>
									<dd>{new Date(analysis.updated_at).toLocaleString()}</dd>
									<dt>讲解 ID</dt>
									<dd>{analysis.id}</dd>
									<dt>修订 ID</dt>
									<dd>{analysis.current_revision_id}</dd>
								</>
							)}
						</dl>
					</details>
					<button
						type="button"
						onClick={() =>
							onOpen(segmentId, analysis?.id, analysis?.current_revision_id)
						}
					>
						打开片段 →
					</button>
				</footer>
			)}
		</div>
	);
}

function PreviewError({
	error,
	label,
	onRetry,
}: {
	error: Error;
	label: string;
	onRetry: () => void;
}) {
	return (
		<div className="reader-study-preview-error">
			<p role="alert">{error.message}</p>
			<button type="button" onClick={onRetry}>
				{label}
			</button>
		</div>
	);
}
