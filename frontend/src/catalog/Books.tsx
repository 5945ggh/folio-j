import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
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
import {
	readPreference,
	savePreference,
	useCatalogScroll,
	useCatalogState,
} from "./hooks";
import { Icon, LibraryTools } from "./LibraryTools";
import { bookListState, cardWidth } from "./presentation";
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
	const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
	const failedCover = Boolean(
		book.cover_url && failedCoverUrl === book.cover_url,
	);
	const [coverAttempt, setCoverAttempt] = useState(0);
	const menuId = useId();
	const menu = useRef<HTMLDivElement>(null);

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
							key={`${book.cover_url}:${coverAttempt}`}
							src={
								coverAttempt
									? `${book.cover_url}${book.cover_url.includes("?") ? "&" : "?"}retry=${coverAttempt}`
									: book.cover_url
							}
							alt=""
							loading="lazy"
							onError={() => setFailedCoverUrl(book.cover_url)}
						/>
					) : (
						<div className="book-cover-placeholder">
							<Icon name="book" />
							<span>暂无封面</span>
						</div>
					)}
				</div>
				<h3 className="book-title" title={book.title}>
					{book.title}
				</h3>
			</Link>
			<div className="book-actions">
				<button
					type="button"
					className="library-icon book-menu-trigger"
					aria-label={`「${book.title}」的更多操作`}
					title="更多操作"
					aria-haspopup="menu"
					popoverTarget={menuId}
					onClick={(event) => {
						const box = event.currentTarget.getBoundingClientRect();
						if (menu.current) {
							menu.current.style.top = `${Math.min(box.bottom + 6, Math.max(16, window.innerHeight - 240))}px`;
							menu.current.style.right = `${Math.max(16, window.innerWidth - box.right)}px`;
						}
					}}
				>
					<Icon name="more" />
				</button>
			</div>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				onToggle={(event) => {
					if (event.newState === "open") {
						const selected =
							event.currentTarget.querySelector<HTMLButtonElement>(
								"button[aria-checked=true]:not(:disabled)",
							);
						(
							selected ??
							event.currentTarget.querySelector<HTMLButtonElement>(
								"button:not(:disabled)",
							)
						)?.focus();
					}
				}}
				className="library-popover book-menu"
				role="menu"
				aria-label={`「${book.title}」阅读状态`}
				onKeyDown={(event) => {
					const controls = Array.from(
						event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
					);
					const current = controls.indexOf(
						document.activeElement as HTMLButtonElement,
					);
					const next =
						event.key === "ArrowDown"
							? (current + 1) % controls.length
							: event.key === "ArrowUp"
								? (current - 1 + controls.length) % controls.length
								: event.key === "Home"
									? 0
									: event.key === "End"
										? controls.length - 1
										: null;
					if (next !== null) {
						event.preventDefault();
						controls[next]?.focus();
					}
				}}
			>
				<strong>阅读状态</strong>
				{Object.entries(statusLabels).map(([value, label]) => (
					<button
						key={value}
						type="button"
						role="menuitemradio"
						aria-checked={book.status === value}
						disabled={usage.isPending}
						onClick={() => {
							usage.mutate(value as Book["status"]);
							menu.current?.hidePopover();
						}}
					>
						{label}
						{book.status === value ? " ✓" : ""}
					</button>
				))}
				{failedCover && (
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setFailedCoverUrl(null);
							setCoverAttempt((v) => v + 1);
							menu.current?.hidePopover();
						}}
					>
						重试封面
					</button>
				)}
			</div>
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
	add,
}: {
	sourceId?: string;
	sources?: readonly { id: string; title: string }[];
	internal?: boolean;
	add?: () => void;
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
	const [size, setSize] = useState(() =>
		cardWidth(readPreference("card-width")),
	);
	const filtered = Boolean(state.q || state.status || state.source_id);
	const view = books.data
		? bookListState(
				books.data.total,
				books.data.items.length,
				filtered,
				state.page,
			)
		: null;
	const trueEmpty = books.isSuccess && !books.isFetching && view === "empty";
	return (
		<>
			{add ? (
				<LibraryTools
					state={state}
					change={change}
					sources={sources}
					size={size}
					setSize={(value) => {
						setSize(value);
						savePreference("card-width", String(value));
					}}
					empty={trueEmpty}
					add={add}
				/>
			) : (
				<CatalogToolbar
					kind="books"
					state={state}
					change={change}
					sources={sourceId ? undefined : sources}
				/>
			)}
			<div
				style={
					add ? ({ "--card-width": `${size}px` } as CSSProperties) : undefined
				}
				ref={scroll}
				className={internal ? "dialog-scroll" : "catalog-body"}
			>
				{books.isPending || (books.isFetching && view === "empty") ? (
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
				) : trueEmpty && add ? (
					<button
						id="library-empty-import"
						type="button"
						className="library-empty-import"
						aria-label="导入 EPUB"
						onClick={(event) => {
							event.currentTarget.focus();
							add();
						}}
					>
						<Icon name="book" />
						<span className="library-empty-title">这里，留给下一本好书。</span>
						<span>点击这片区域，开始导入 EPUB</span>
					</button>
				) : books.data.items.length === 0 ? (
					<div className="empty-state">
						<p>
							{view === "out-of-page"
								? "正在调整到有效页…"
								: filtered
									? "没有找到匹配的书籍"
									: "还没有书籍。添加 EPUB 后即可开始阅读。"}
						</p>
						{filtered && (
							<button
								type="button"
								className="button secondary"
								onClick={() => change({ q: "", status: "", source_id: "" })}
							>
								清空条件
							</button>
						)}
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
