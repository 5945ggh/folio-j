import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { Source } from "../content";
import { ConfirmDialog, dateLabel, InlineError } from "../Shared";
import {
	type AnalysisQuery,
	type Book,
	type BookQuery,
	catalogAnalyses,
	catalogBooks,
	catalogKeys,
	catalogSegments,
	type SegmentQuery,
} from "./api";
import { BookDeleteDialog } from "./BookDeleteDialog";
import { BookEditDialog } from "./BookEditDialog";
import { BookCatalog, BookGrid } from "./Books";
import { CatalogToolbar, Pagination, Tabs } from "./Controls";
import {
	useCatalogScroll,
	useCatalogState,
	useSourceContentLocation,
} from "./hooks";
import { ImportDialog } from "./ImportDialog";
import { Icon } from "./LibraryTools";
import { sourceListState } from "./presentation";
import { SourceOverview } from "./SourceOverview";
import { analysisDestination, lastCatalogPage } from "./state";

function SourceBooks({
	source,
	expanded,
	onExpandedChange,
}: {
	source: Source;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
}) {
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Book | null>(null);
	const focusAfterEdit = useRef(false);
	const client = useQueryClient();
	const { state } = useCatalogState("books", `source-books-${source.id}`);
	const query: BookQuery = {
		source_id: source.id,
		type: "book",
		sort: state.sort as BookQuery["sort"],
		order: state.order,
		page_size: 6,
	};
	const books = useQuery({
		queryKey: catalogKeys.books(query),
		queryFn: () => catalogBooks(query),
	});
	useEffect(() => {
		if (
			editing !== null ||
			deleting !== null ||
			!focusAfterEdit.current ||
			books.isFetching ||
			books.data !== client.getQueryData(catalogKeys.books(query))
		)
			return;
		focusAfterEdit.current = false;
		const active = document.activeElement;
		const container = document.getElementById("source-content-panel-materials");
		if (
			!active ||
			active === document.body ||
			!active.isConnected ||
			active === container
		)
			(
				container?.querySelector<HTMLElement>(
					".book-menu-trigger, button:not(:disabled), a[href]",
				) ?? container
			)?.focus();
	});
	const empty = books.isSuccess && books.data.total === 0;
	useCatalogScroll(
		books.isSuccess && !expanded,
		`source-materials-${source.id}`,
	);
	function close() {
		onExpandedChange(false);
	}
	function expand() {
		onExpandedChange(true);
	}
	return (
		<>
			{!empty && !books.isPending && (
				<div className="section-heading">
					<h2>
						书籍{" "}
						{books.data && books.data.total > 0 && (
							<span>· {books.data.total}</span>
						)}
					</h2>
					<div className="actions">
						<button
							className="button secondary"
							type="button"
							onClick={(event) => {
								event.currentTarget.focus();
								setAdding(true);
							}}
						>
							导入书籍
						</button>
						<button
							className="button secondary"
							type="button"
							onClick={(event) => {
								event.currentTarget.focus();
								expand();
							}}
						>
							查看全部
						</button>
					</div>
				</div>
			)}
			{books.isPending ? (
				<p role="status">正在加载素材…</p>
			) : books.isError ? (
				<>
					<InlineError error={books.error} />
					<button
						className="button secondary"
						type="button"
						onClick={() => void books.refetch()}
					>
						重试
					</button>
				</>
			) : empty ? (
				<div className="source-welcome">
					<div className="source-welcome-icon">
						<Icon name="book" />
					</div>
					<h2>从一本书开始</h2>
					<p>导入一本 EPUB，开始阅读原文。</p>
					<div className="actions">
						<button
							className="button primary"
							type="button"
							onClick={(event) => {
								event.currentTarget.focus();
								setAdding(true);
							}}
						>
							导入书籍
						</button>
					</div>
				</div>
			) : (
				<BookGrid
					books={books.data.items}
					returnLabel={source.title}
					onEdit={setEditing}
					onDelete={setDeleting}
				/>
			)}
			{expanded && (
				<ConfirmDialog
					className="scoped-material-dialog"
					titleId="source-books-title"
					restoreFocusId="source-content-tab-materials"
					onClose={close}
				>
					<div className="section-heading">
						<div>
							<p className="eyebrow">{source.title}</p>
							<h2 id="source-books-title">全部书籍</h2>
						</div>
						<button
							className="button secondary"
							data-dialog-cancel
							type="button"
							onClick={close}
						>
							关闭
						</button>
					</div>
					<BookCatalog sourceId={source.id} internal />
				</ConfirmDialog>
			)}
			{adding && (
				<ImportDialog sourceId={source.id} close={() => setAdding(false)} />
			)}
			{deleting !== null && (
				<BookDeleteDialog
					book={deleting}
					close={() => {
						focusAfterEdit.current = true;
						setDeleting(null);
					}}
					restoreFocusId="source-content-panel-materials"
				/>
			)}
			{editing !== null && (
				<BookEditDialog
					id={editing}
					close={() => {
						focusAfterEdit.current = true;
						setEditing(null);
					}}
					restoreFocusId="source-content-panel-materials"
				/>
			)}
		</>
	);
}
function SourceSegments({
	source,
	onAddSegment,
}: {
	source: Source;
	onAddSegment: () => void;
}) {
	const location = useLocation();
	const { state, change } = useCatalogState(
		"segments",
		`segments-${source.id}`,
	);
	const query: SegmentQuery = {
		q: state.q,
		sort: state.sort as SegmentQuery["sort"],
		order: state.order,
		page: state.page,
		page_size: 50,
	};
	const segments = useQuery({
		queryKey: catalogKeys.segments(source.id, query),
		queryFn: () => catalogSegments(source.id, query),
		placeholderData: keepPreviousData,
	});
	useCatalogScroll(
		segments.isSuccess && !segments.isPlaceholderData,
		"segments",
	);
	const last =
		segments.data && !segments.isPlaceholderData
			? lastCatalogPage(segments.data.total, segments.data.page_size)
			: null;
	useEffect(() => {
		if (last !== null && state.page > last) change({ page: last });
	}, [last, state.page, change]);
	const returnTo = {
		to: `${location.pathname}${location.search}`,
		label: source.title,
	};
	const view = sourceListState(
		segments.isSuccess && !segments.isPlaceholderData
			? segments.data.total
			: undefined,
		segments.data?.items.length ?? 0,
		state.q,
	);
	const showToolbar =
		Boolean(state.q) ||
		segments.isPlaceholderData ||
		view === "items" ||
		view === "out-of-page";
	const addButton = (
		<button
			type="button"
			className={`button ${view === "empty" ? "primary" : "secondary"}`}
			onClick={(event) => {
				event.currentTarget.focus();
				onAddSegment();
			}}
		>
			添加片段
		</button>
	);
	return (
		<>
			{showToolbar && (
				<CatalogToolbar kind="segments" state={state} change={change}>
					{addButton}
				</CatalogToolbar>
			)}
			{segments.isPending ? (
				<p role="status">正在加载片段…</p>
			) : segments.isError ? (
				<>
					<InlineError error={segments.error} />
					<button
						type="button"
						className="button secondary"
						onClick={() => void segments.refetch()}
					>
						重试
					</button>
				</>
			) : view === "loading" || view === "out-of-page" ? (
				<p role="status">正在加载片段…</p>
			) : view === "empty" ? (
				<div className="source-welcome">
					<div className="source-welcome-icon">
						<Icon name="book" />
					</div>
					<h2>从第一段内容开始</h2>
					<p>添加一段日文，开始阅读和讨论。</p>
					<div className="actions">{addButton}</div>
				</div>
			) : view === "no-results" ? (
				<div className="source-list-no-results">
					<p>没有找到匹配的片段。</p>
					<button
						className="source-text-button"
						type="button"
						onClick={() => change({ q: "" })}
					>
						清除搜索
					</button>
				</div>
			) : (
				<div className="segment-list">
					{segments.data.items.map((segment) => (
						<article className="segment-row" key={segment.id}>
							<Link
								className="segment-content-link"
								to={`/segments/${segment.id}`}
								state={{ returnTo }}
							>
								<span className="segment-text" lang="ja">
									{segment.text}
								</span>
								<span className="segment-meta">
									{segment.source_ref ||
										(segment.material_provenance
											? "已保存材料出处"
											: "未填写出处")}{" "}
									· {dateLabel(segment.created_at)}
								</span>
							</Link>
							<Link
								className="button secondary"
								to={`/segments/${segment.id}?chat=1`}
								state={{ returnTo }}
							>
								讨论
							</Link>
						</article>
					))}
				</div>
			)}
			{segments.data && view === "items" && (
				<Pagination
					page={state.page}
					total={segments.data.total}
					pageSize={segments.data.page_size}
					onChange={(page) => change({ page })}
				/>
			)}
		</>
	);
}
function SourceAnalyses({
	source,
	onViewSegments,
}: {
	source: Source;
	onViewSegments: () => void;
}) {
	const location = useLocation();
	const { state, change } = useCatalogState(
		"analyses",
		`analyses-${source.id}`,
	);
	const query: AnalysisQuery = {
		q: state.q,
		sort: state.sort as AnalysisQuery["sort"],
		order: state.order,
		page: state.page,
		page_size: 50,
	};
	const analyses = useQuery({
		queryKey: catalogKeys.analyses(source.id, query),
		queryFn: () => catalogAnalyses(source.id, query),
		placeholderData: keepPreviousData,
	});
	useCatalogScroll(
		analyses.isSuccess && !analyses.isPlaceholderData,
		"analyses",
	);
	const last =
		analyses.data && !analyses.isPlaceholderData
			? lastCatalogPage(analyses.data.total, analyses.data.page_size)
			: null;
	useEffect(() => {
		if (last !== null && state.page > last) change({ page: last });
	}, [last, state.page, change]);
	const view = sourceListState(
		analyses.isSuccess && !analyses.isPlaceholderData
			? analyses.data.total
			: undefined,
		analyses.data?.items.length ?? 0,
		state.q,
	);
	const showToolbar =
		Boolean(state.q) ||
		analyses.isPlaceholderData ||
		view === "items" ||
		view === "out-of-page";
	return (
		<>
			{showToolbar && (
				<CatalogToolbar kind="analyses" state={state} change={change} />
			)}
			{analyses.isPending ? (
				<p role="status">正在加载讲解…</p>
			) : analyses.isError ? (
				<>
					<InlineError error={analyses.error} />
					<button
						type="button"
						className="button secondary"
						onClick={() => void analyses.refetch()}
					>
						重试
					</button>
				</>
			) : view === "loading" || view === "out-of-page" ? (
				<p role="status">正在加载讲解…</p>
			) : view === "empty" ? (
				<div className="source-welcome">
					<div className="source-welcome-icon">
						<Icon name="book" />
					</div>
					<h2>还没有保存的讲解</h2>
					<p>进入片段阅读或讨论，保存值得留用的讲解。</p>
					<div className="actions">
						<button
							className="button secondary"
							type="button"
							onClick={onViewSegments}
						>
							查看片段
						</button>
					</div>
				</div>
			) : view === "no-results" ? (
				<div className="source-list-no-results">
					<p>没有找到匹配的讲解。</p>
					<button
						className="source-text-button"
						type="button"
						onClick={() => change({ q: "" })}
					>
						清除搜索
					</button>
				</div>
			) : (
				<div className="analysis-catalog">
					{analyses.data.items.map((analysis) => (
						<Link
							className="analysis-catalog-row"
							key={analysis.id}
							to={analysisDestination(analysis)}
							state={{
								returnTo: {
									to: `${location.pathname}${location.search}`,
									label: source.title,
								},
							}}
						>
							<h3 className="analysis-catalog-title">{analysis.title}</h3>
							<p className="analysis-excerpt">{analysis.excerpt}</p>
							<blockquote lang="ja">{analysis.segment_excerpt}</blockquote>
							<small>更新于 {dateLabel(analysis.updated_at)}</small>
						</Link>
					))}
				</div>
			)}
			{analyses.data && view === "items" && (
				<Pagination
					page={state.page}
					total={analyses.data.total}
					pageSize={analyses.data.page_size}
					onChange={(page) => change({ page })}
				/>
			)}
		</>
	);
}
export function SourceContent({
	source,
	onAddSegment,
	onShowInfo,
}: {
	source: Source;
	onAddSegment: () => void;
	onShowInfo: () => void;
}) {
	const { view, expanded, navigate } = useSourceContentLocation(source.id);
	function change(value: string) {
		navigate({ type: "view", view: value });
	}
	return (
		<>
			<Tabs
				id="source-content"
				label="来源内容"
				items={[
					{ value: "overview", label: "概览" },
					{ value: "materials", label: "素材" },
					{ value: "segments", label: "片段" },
					{ value: "analyses", label: "讲解" },
				]}
				value={view}
				onChange={change}
			/>
			{(["overview", "materials", "segments", "analyses"] as const).map(
				(panel) => (
					<section
						className="source-view-panel"
						role="tabpanel"
						id={`source-content-panel-${panel}`}
						tabIndex={-1}
						aria-labelledby={`source-content-tab-${panel}`}
						key={`${source.id}-${panel}`}
						hidden={panel !== view}
					>
						{panel === view &&
							(panel === "overview" ? (
								<SourceOverview
									source={source}
									onView={change}
									onAddSegment={onAddSegment}
									onShowInfo={onShowInfo}
								/>
							) : panel === "materials" ? (
								<SourceBooks
									source={source}
									expanded={expanded}
									onExpandedChange={(open) =>
										navigate({ type: open ? "open-books" : "close-books" })
									}
								/>
							) : panel === "segments" ? (
								<SourceSegments source={source} onAddSegment={onAddSegment} />
							) : (
								<SourceAnalyses
									source={source}
									onViewSegments={() => change("segments")}
								/>
							))}
					</section>
				),
			)}
		</>
	);
}
