import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { RequestError } from "../content";
import { InlineError } from "../Shared";
import {
	type Book,
	type BookQuery,
	catalogBooks,
	catalogKeys,
	updateUsage,
} from "./api";
import { CatalogToolbar, Pagination, statusLabels } from "./Controls";
import { useCatalogScroll, useCatalogState } from "./hooks";
import { lastCatalogPage } from "./state";
export function BookCard({
	book,
	returnLabel,
}: {
	book: Book;
	returnLabel: string;
}) {
	const location = useLocation();
	const client = useQueryClient();
	const [failedCover, setFailedCover] = useState(false);
	const usage = useMutation({
		mutationFn: (status: Book["status"]) =>
			updateUsage(book.id, status, book.usage_revision),
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: catalogKeys.all });
		},
		onError: (error) => {
			if (error instanceof RequestError && error.status === 409) {
				void client.invalidateQueries({ queryKey: catalogKeys.all });
			}
		},
	});
	const returnTo = {
		to: `${location.pathname}${location.search}`,
		label: returnLabel,
	};
	return (
		<article className="book-card">
			<Link
				className="book-main-link"
				to={`/materials/${book.id}`}
				state={{ returnTo }}
			>
				<div className="book-cover">
					{book.cover_url && !failedCover ? (
						<img
							src={book.cover_url}
							alt=""
							loading="lazy"
							onError={() => setFailedCover(true)}
						/>
					) : (
						<div className="book-cover-placeholder">
							<span className="cover-mark" aria-hidden="true">
								文
							</span>
							<span>{book.title}</span>
							<small>EPUB</small>
						</div>
					)}
				</div>
				<h3 className="book-title" title={book.title}>
					{book.title}
				</h3>
			</Link>
			<Link
				className="book-source"
				to={`/sources/${book.source_id}?view=materials`}
				title={book.source_title}
			>
				{book.source_title}
			</Link>
			<label className="book-status">
				<span className="sr-only">「{book.title}」阅读状态</span>
				<select
					value={book.status}
					disabled={usage.isPending}
					onChange={(event) =>
						usage.mutate(event.target.value as Book["status"])
					}
				>
					{Object.entries(statusLabels).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</label>
			<InlineError error={usage.error} />
		</article>
	);
}
export function BookGrid({
	books,
	returnLabel,
}: {
	books: readonly Book[];
	returnLabel: string;
}) {
	return (
		<div className="book-grid">
			{books.map((book) => (
				<BookCard key={book.id} book={book} returnLabel={returnLabel} />
			))}
		</div>
	);
}
export function BookCatalog({
	sourceId,
	sources,
	internal = false,
}: {
	sourceId?: string;
	sources?: readonly { id: string; title: string }[];
	internal?: boolean;
}) {
	const { state, change } = useCatalogState(
		"books",
		sourceId ? `source-books-${sourceId}` : "books",
	);
	const query: BookQuery = {
		type: "book",
		source_id: sourceId || state.source_id || undefined,
		q: state.q,
		status: state.status || undefined,
		sort: state.sort as BookQuery["sort"],
		order: state.order,
		page: state.page,
		page_size: 50,
	};
	const books = useQuery({
		queryKey: catalogKeys.books(query),
		queryFn: () => catalogBooks(query),
	});
	const scroll = useCatalogScroll(
		books.isSuccess,
		sourceId ?? "books",
		internal,
	);
	const lastPage = books.data
		? lastCatalogPage(books.data.total, books.data.page_size)
		: null;
	useEffect(() => {
		if (lastPage !== null && state.page > lastPage) change({ page: lastPage });
	}, [lastPage, state.page, change]);
	return (
		<>
			<CatalogToolbar
				kind="books"
				state={state}
				change={change}
				sources={sourceId ? undefined : sources}
			/>
			<div ref={scroll} className={internal ? "dialog-scroll" : "catalog-body"}>
				{books.isPending ? (
					<p role="status">正在加载书籍…</p>
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
				) : books.data.items.length === 0 ? (
					<div className="empty-state">
						<p>
							{state.q || state.status || state.source_id
								? "当前筛选没有结果。可调整或清空条件。"
								: "还没有书籍。添加 EPUB 后即可开始阅读。"}
						</p>
					</div>
				) : (
					<BookGrid
						books={books.data.items}
						returnLabel={sourceId ? "Source 书籍窗口" : "素材库"}
					/>
				)}
				{books.data && (
					<Pagination
						page={state.page}
						total={books.data.total}
						pageSize={books.data.page_size}
						onChange={(page) => change({ page })}
					/>
				)}
			</div>
		</>
	);
}
