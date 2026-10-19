import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { Source } from "../content";
import { dateLabel, InlineError } from "../Shared";
import {
	type AnalysisQuery,
	type BookQuery,
	catalogAnalyses,
	catalogBooks,
	catalogKeys,
	catalogSegments,
	type SegmentQuery,
} from "./api";
import { BookEditDialog } from "./BookEditDialog";
import { BookCard } from "./Books";
import { useCatalogScroll } from "./hooks";
import { ImportDialog } from "./ImportDialog";
import { Icon } from "./LibraryTools";
import { analysisDestination } from "./state";

const analysesQuery: AnalysisQuery = {
	sort: "updated_at",
	order: "desc",
	page: 1,
	page_size: 2,
};
const segmentsQuery: SegmentQuery = {
	sort: "created_at",
	order: "desc",
	page: 1,
	page_size: 3,
};
function Retry({ error, retry }: { error: Error; retry: () => void }) {
	return (
		<>
			<InlineError error={error} />
			<button className="source-text-button" type="button" onClick={retry}>
				重试
			</button>
		</>
	);
}
export function SourceOverview({
	source,
	onView,
	onAddSegment,
	onShowInfo,
}: {
	source: Source;
	onView: (view: string) => void;
	onAddSegment: () => void;
	onShowInfo: () => void;
}) {
	const location = useLocation();
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const focusAfterEdit = useRef(false);
	const client = useQueryClient();
	const bookQuery: BookQuery = {
		source_id: source.id,
		type: "book",
		sort: "title",
		order: "asc",
		page: 1,
		page_size: 3,
	};
	const analyses = useQuery({
		queryKey: catalogKeys.analyses(source.id, analysesQuery),
		queryFn: () => catalogAnalyses(source.id, analysesQuery),
	});
	const segments = useQuery({
		queryKey: catalogKeys.segments(source.id, segmentsQuery),
		queryFn: () => catalogSegments(source.id, segmentsQuery),
	});
	const books = useQuery({
		queryKey: catalogKeys.books(bookQuery),
		queryFn: () => catalogBooks(bookQuery),
	});
	useEffect(() => {
		if (
			editing !== null ||
			!focusAfterEdit.current ||
			books.isFetching ||
			books.data !== client.getQueryData(catalogKeys.books(bookQuery))
		)
			return;
		focusAfterEdit.current = false;
		const active = document.activeElement;
		if (!active || active === document.body || !active.isConnected)
			document.getElementById("source-content-panel-overview")?.focus();
	});
	const settled =
		!analyses.isPending && !segments.isPending && !books.isPending;
	useCatalogScroll(settled, `source-overview-${source.id}`);
	const returnTo = {
		to: `${location.pathname}${location.search}`,
		label: source.title,
	};
	const emptyLearning =
		analyses.isSuccess &&
		segments.isSuccess &&
		analyses.data.total === 0 &&
		segments.data.total === 0;
	const empty = emptyLearning && books.isSuccess && books.data.total === 0;
	const note = source.note && (
		<section className="overview-note">
			<h2>来源备注</h2>
			<p>{source.note}</p>
			<button
				type="button"
				className="source-text-button"
				onClick={(event) => {
					event.currentTarget.focus();
					onShowInfo();
				}}
			>
				来源信息
			</button>
		</section>
	);
	const materials = (
		<section className="overview-materials" aria-label="所属素材">
			<div className="overview-heading">
				<h2>所属素材</h2>
				<button
					type="button"
					className="source-text-button"
					onClick={() => onView("materials")}
				>
					查看全部
				</button>
			</div>
			{books.isPending ? (
				<p role="status">正在加载素材…</p>
			) : books.isError ? (
				<Retry error={books.error} retry={() => void books.refetch()} />
			) : books.data.total === 0 ? (
				<p className="overview-empty-hint">
					没有完整素材，也可以保留和阅读这里的片段。
				</p>
			) : (
				<div className="overview-books">
					{books.data.items.map((book) => (
						<BookCard
							key={book.id}
							book={book}
							returnLabel={source.title}
							onEdit={setEditing}
						/>
					))}
				</div>
			)}
			<button
				type="button"
				className="source-text-button overview-import"
				onClick={(event) => {
					event.currentTarget.focus();
					setAdding(true);
				}}
			>
				导入书籍
			</button>
		</section>
	);
	return (
		<>
			{empty ? (
				<div className="overview-empty">
					<div className="source-welcome">
						<div className="source-welcome-icon">
							<Icon name="book" />
						</div>
						<h2>从第一段内容开始</h2>
						<p>可以直接添加日文片段，也可以先导入一个素材。</p>
						<div className="actions">
							<button
								type="button"
								className="button primary"
								onClick={(event) => {
									event.currentTarget.focus();
									onAddSegment();
								}}
							>
								添加片段
							</button>
							<button
								type="button"
								className="button secondary"
								onClick={(event) => {
									event.currentTarget.focus();
									setAdding(true);
								}}
							>
								导入素材
							</button>
						</div>
					</div>
					{note}
				</div>
			) : emptyLearning && books.isSuccess ? (
				<div className="overview-sparse">
					{materials}
					<section className="sparse-learning">
						<h2>片段与讲解</h2>
						<p className="overview-empty-hint">
							这里还没有保存的片段和讲解。阅读时可以按需留下内容。
						</p>
						<button
							type="button"
							className="source-text-button"
							onClick={(event) => {
								event.currentTarget.focus();
								onAddSegment();
							}}
						>
							添加片段
						</button>
					</section>
					{note}
				</div>
			) : (
				<div className="source-overview">
					<div className="overview-learning">
						<section className="overview-section" aria-label="最近更新的讲解">
							<div className="overview-heading">
								<h2>最近更新的讲解</h2>
								<button
									type="button"
									className="source-text-button"
									onClick={() => onView("analyses")}
								>
									查看全部
								</button>
							</div>
							{analyses.isPending ? (
								<p role="status">正在加载讲解…</p>
							) : analyses.isError ? (
								<Retry
									error={analyses.error}
									retry={() => void analyses.refetch()}
								/>
							) : analyses.data.total === 0 ? (
								<p className="overview-empty-hint">
									尚无已保存讲解。片段仍可直接阅读和讨论。
								</p>
							) : (
								analyses.data.items.map((analysis) => (
									<Link
										className="overview-analysis"
										key={analysis.id}
										to={analysisDestination(analysis)}
										state={{ returnTo }}
									>
										<h3>{analysis.title}</h3>
										<p>{analysis.excerpt}</p>
										<blockquote lang="ja">
											{analysis.segment_excerpt}
										</blockquote>
										<small>更新于 {dateLabel(analysis.updated_at)}</small>
									</Link>
								))
							)}
						</section>
						<section className="overview-section" aria-label="最近添加的片段">
							<div className="overview-heading">
								<h2>最近添加的片段</h2>
								<div className="actions">
									<button
										type="button"
										className="source-text-button"
										onClick={(event) => {
											event.currentTarget.focus();
											onAddSegment();
										}}
									>
										添加片段
									</button>
									<button
										type="button"
										className="source-text-button"
										onClick={() => onView("segments")}
									>
										查看全部
									</button>
								</div>
							</div>
							{segments.isPending ? (
								<p role="status">正在加载片段…</p>
							) : segments.isError ? (
								<Retry
									error={segments.error}
									retry={() => void segments.refetch()}
								/>
							) : segments.data.total === 0 ? (
								<p className="overview-empty-hint">
									还没有片段，可直接录入日文。
								</p>
							) : (
								segments.data.items.map((segment) => (
									<article className="overview-segment" key={segment.id}>
										<Link to={`/segments/${segment.id}`} state={{ returnTo }}>
											<p lang="ja">{segment.text}</p>
											<small>
												{segment.source_ref || "未填写出处"} · 添加于{" "}
												{dateLabel(segment.created_at)}
											</small>
										</Link>
										<Link
											className="source-text-button"
											to={`/segments/${segment.id}?chat=1`}
											state={{ returnTo }}
										>
											讨论
										</Link>
									</article>
								))
							)}
						</section>
					</div>
					<aside className="overview-reference">
						{materials}
						{note}
					</aside>
				</div>
			)}
			{adding && (
				<ImportDialog sourceId={source.id} close={() => setAdding(false)} />
			)}
			{editing !== null && (
				<BookEditDialog
					id={editing}
					close={() => {
						focusAfterEdit.current = true;
						setEditing(null);
					}}
					restoreFocusId="source-content-panel-overview"
				/>
			)}
		</>
	);
}
