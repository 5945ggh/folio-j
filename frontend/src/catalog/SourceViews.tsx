import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { Source } from "../content";
import { ConfirmDialog, dateLabel, InlineError } from "../Shared";
import {
	type AnalysisQuery,
	type BookQuery,
	catalogAnalyses,
	catalogBooks,
	catalogKeys,
	catalogSegments,
	type SegmentQuery,
} from "./api";
import { BookCatalog, BookGrid } from "./Books";
import { CatalogToolbar, Pagination, Tabs } from "./Controls";
import { readPreference, useCatalogScroll, useCatalogState } from "./hooks";
import { ImportDialog } from "./ImportDialog";
import { SourceOverview } from "./SourceOverview";
import {
	analysisDestination,
	lastCatalogPage,
	readCatalogState,
	sourceView,
} from "./state";

function SourceBooks({ source }: { source: Source }) {
	const [params, setParams] = useSearchParams();
	const [adding, setAdding] = useState(false);
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
	const expanded = params.get("expanded") === "book";
	useCatalogScroll(
		books.isSuccess && !expanded,
		`source-materials-${source.id}`,
	);
	function close() {
		const next = new URLSearchParams(params);
		next.delete("expanded");
		next.set("view", "materials");
		for (const key of ["q", "status", "sort", "order", "page"])
			next.delete(key);
		setParams(next, { replace: true });
	}
	function expand() {
		const next = new URLSearchParams(params);
		next.set("view", "materials");
		next.set("expanded", "book");
		setParams(next);
	}
	return (
		<>
			<div className="section-heading">
				<h2>
					{books.data?.total === 0 ? "尚未添加素材" : "书籍"}{" "}
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
			) : books.data.total === 0 ? (
				<div className="empty-state">
					<p>此来源还没有书籍。可导入 EPUB，或切换到片段查看手动录入的内容。</p>
				</div>
			) : (
				<BookGrid books={books.data.items} returnLabel={source.title} />
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
	});
	useCatalogScroll(segments.isSuccess, "segments");
	const last = segments.data
		? lastCatalogPage(segments.data.total, segments.data.page_size)
		: null;
	useEffect(() => {
		if (last !== null && state.page > last) change({ page: last });
	}, [last, state.page, change]);
	const returnTo = {
		to: `${location.pathname}${location.search}`,
		label: source.title,
	};
	return (
		<>
			<div className="source-list-tools">
				<CatalogToolbar kind="segments" state={state} change={change} />
				<button
					type="button"
					className="button secondary"
					onClick={(event) => {
						event.currentTarget.focus();
						onAddSegment();
					}}
				>
					添加片段
				</button>
			</div>
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
			) : segments.data.items.length === 0 ? (
				<div className="empty-state">
					<p>
						{state.q
							? "没有匹配的片段。"
							: "还没有片段。手动添加日文即可学习，无需先导入材料。"}
					</p>
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
									{segment.source_ref || "未填写出处"} ·{" "}
									{dateLabel(segment.created_at)}
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
			{segments.data && (
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
function SourceAnalyses({ source }: { source: Source }) {
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
	});
	useCatalogScroll(analyses.isSuccess, "analyses");
	const last = analyses.data
		? lastCatalogPage(analyses.data.total, analyses.data.page_size)
		: null;
	useEffect(() => {
		if (last !== null && state.page > last) change({ page: last });
	}, [last, state.page, change]);
	return (
		<>
			<CatalogToolbar kind="analyses" state={state} change={change} />
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
			) : analyses.data.items.length === 0 ? (
				<div className="empty-state">
					<p>
						{state.q
							? "没有匹配的讲解。"
							: "此来源还没有已保存讲解。可进入片段阅读或讨论。"}
					</p>
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
			{analyses.data && (
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
	const [params, setParams] = useSearchParams();
	const view = sourceView(params.toString());
	const sortScope =
		view === "materials" ? `source-books-${source.id}` : `${view}-${source.id}`;
	const defaults =
		view === "overview"
			? null
			: readCatalogState(
					params.toString(),
					view === "materials" ? "books" : view,
					readPreference(`sort-${sortScope}`),
				);
	const defaultSort = defaults?.sort;
	const defaultOrder = defaults?.order;
	useEffect(() => {
		if (
			params.get("view") !== view ||
			(defaultSort &&
				defaultOrder &&
				(params.get("sort") !== defaultSort ||
					params.get("order") !== defaultOrder))
		) {
			const next = new URLSearchParams(params);
			next.set("view", view);
			if (defaultSort && defaultOrder) {
				next.set("sort", defaultSort);
				next.set("order", defaultOrder);
			}
			setParams(next, { replace: true });
		}
	}, [params, setParams, view, defaultSort, defaultOrder]);
	function change(value: string) {
		const next = new URLSearchParams(params);
		next.set("view", value);
		for (const name of ["expanded", "q", "status", "sort", "order", "page"])
			next.delete(name);
		setParams(next);
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
								<SourceBooks source={source} />
							) : panel === "segments" ? (
								<SourceSegments source={source} onAddSegment={onAddSegment} />
							) : (
								<SourceAnalyses source={source} />
							))}
					</section>
				),
			)}
		</>
	);
}
