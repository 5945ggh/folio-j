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
	catalogSources,
	type SegmentQuery,
} from "./api";
import { BookCatalog, BookGrid } from "./Books";
import { CatalogToolbar, Pagination, Tabs } from "./Controls";
import {
	readPreference,
	savePreference,
	useCatalogScroll,
	useCatalogState,
} from "./hooks";
import { ImportDialog } from "./ImportDialog";
import {
	analysisDestination,
	lastCatalogPage,
	readCatalogState,
	sourceListSearch,
	sourceView,
} from "./state";
export function SourceDirectory({ compact = false }: { compact?: boolean }) {
	const location = useLocation();
	const { state, change } = useCatalogState(
		"sources",
		"sources",
		compact ? "s" : "",
	);
	const query = {
		q: state.q,
		sort: state.sort as "title" | "created_at" | "updated_at",
		order: state.order,
		page: state.page,
		page_size: 50,
	};
	const sources = useQuery({
		queryKey: catalogKeys.sources(query),
		queryFn: () => catalogSources(query),
	});
	const scroll = useCatalogScroll(
		sources.isSuccess,
		compact ? "source-context" : "sources",
		compact,
	);
	const last = sources.data
		? lastCatalogPage(sources.data.total, sources.data.page_size)
		: null;
	useEffect(() => {
		if (last !== null && state.page > last) change({ page: last });
	}, [last, state.page, change]);
	return (
		<section
			className={`source-directory ${compact ? "source-context" : ""}`}
			aria-label="Source 列表"
		>
			<CatalogToolbar kind="sources" state={state} change={change} />
			<div ref={scroll} className={compact ? "source-context-scroll" : ""}>
				{sources.isPending ? (
					<p role="status">正在加载 Source…</p>
				) : sources.isError ? (
					<>
						<InlineError error={sources.error} />
						<button
							type="button"
							className="button secondary"
							onClick={() => void sources.refetch()}
						>
							重试
						</button>
					</>
				) : sources.data.items.length === 0 ? (
					<div className="empty-state">
						<p>
							{state.q
								? "没有匹配的 Source。"
								: "还没有 Source。先新建来源，再添加书籍或学习片段。"}
						</p>
					</div>
				) : (
					<div className="source-list">
						{sources.data.items.map((source) => (
							<Link
								className={`source-row ${location.pathname === `/sources/${source.id}` ? "selected" : ""}`}
								key={source.id}
								to={`/sources/${source.id}${sourceListSearch(location.search, compact ? "s" : "", "s")}`}
							>
								<div>
									<h3>{source.title}</h3>
									{!compact && source.description && (
										<p>{source.description}</p>
									)}
									<span className="source-counts">
										{source.material_count} 本书 · {source.segment_count} 个片段
										· {source.analysis_count} 篇讲解
									</span>
								</div>
								<span aria-hidden="true">→</span>
							</Link>
						))}
					</div>
				)}
				{sources.data && (
					<Pagination
						page={state.page}
						total={sources.data.total}
						pageSize={sources.data.page_size}
						onChange={(page) => change({ page })}
					/>
				)}
			</div>
		</section>
	);
}
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
		`source-overview-${source.id}`,
	);
	function close() {
		const next = new URLSearchParams(params);
		next.delete("expanded");
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
						添加书籍
					</button>
					{books.data && books.data.total > 6 && (
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
					)}
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
					<p>
						此 Source 还没有书籍。可添加 EPUB，或切换到片段查看手动录入的内容。
					</p>
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
function SourceSegments({ source }: { source: Source }) {
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
			<CatalogToolbar kind="segments" state={state} change={change} />
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
									{dateLabel(segment.created_at)} · 阅读／讲解 →
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
							: "此 Source 还没有已保存讲解。可进入片段阅读或讨论。"}
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
							<p className="analysis-excerpt">
								<span className="excerpt-label">正文摘录</span>
								{analysis.excerpt}
							</p>
							<blockquote lang="ja">{analysis.segment_excerpt}</blockquote>
							<small>
								更新于 {dateLabel(analysis.updated_at)} · 打开讲解 →
							</small>
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
export function SourceContent({ source }: { source: Source }) {
	const [params, setParams] = useSearchParams();
	const view = sourceView(
		params.toString(),
		readPreference(`source-view-${source.id}`),
	);
	const sortScope =
		view === "materials" ? `source-books-${source.id}` : `${view}-${source.id}`;
	const defaults = readCatalogState(
		params.toString(),
		view === "materials" ? "books" : view,
		readPreference(`sort-${sortScope}`),
	);
	useEffect(() => {
		if (
			params.get("view") !== view ||
			params.get("sort") !== defaults.sort ||
			params.get("order") !== defaults.order
		) {
			const next = new URLSearchParams(params);
			next.set("view", view);
			next.set("sort", defaults.sort);
			next.set("order", defaults.order);
			setParams(next, { replace: true });
		}
	}, [params, setParams, view, defaults.sort, defaults.order]);
	function change(value: string) {
		savePreference(`source-view-${source.id}`, value);
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
				label="Source 内容"
				items={[
					{ value: "materials", label: "素材" },
					{ value: "segments", label: "片段" },
					{ value: "analyses", label: "讲解" },
				]}
				value={view}
				onChange={change}
			/>
			{(["materials", "segments", "analyses"] as const).map((panel) => (
				<section
					className="source-view-panel"
					role="tabpanel"
					id={`source-content-panel-${panel}`}
					aria-labelledby={`source-content-tab-${panel}`}
					key={`${source.id}-${panel}`}
					hidden={panel !== view}
				>
					{panel === view &&
						(panel === "materials" ? (
							<SourceBooks source={source} />
						) : panel === "segments" ? (
							<SourceSegments source={source} />
						) : (
							<SourceAnalyses source={source} />
						))}
				</section>
			))}
		</>
	);
}
