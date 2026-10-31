import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { RequestError } from "../content";
import { InlineError } from "../Shared";
import {
	type Book,
	type BookQuery,
	catalogBooks,
	catalogKeys,
	updateUsage,
} from "./api";
import { BookCoverPlaceholder } from "./BookCoverPlaceholder";
import { BookDeleteDialog } from "./BookDeleteDialog";
import { BookEditDialog } from "./BookEditDialog";
import {
	type BookMenuPage,
	bookMenuPageForKey,
	nextBookMenuIndex,
} from "./book-menu";
import "./book-menu.css";
import { CatalogToolbar, Pagination, statusLabels } from "./Controls";
import {
	readPreference,
	savePreference,
	useCatalogScroll,
	useCatalogState,
} from "./hooks";
import { ImportCards, useImportTasks } from "./ImportCards";
import type { ImportTask } from "./import-state";
import { Icon, LibraryTools } from "./LibraryTools";
import { bookListState, cardWidth } from "./presentation";
import { lastCatalogPage } from "./state";
export function BookCard({
	book,
	returnLabel,
	onEdit,
	onDelete,
}: {
	book: Book;
	returnLabel: string;
	onEdit: (id: string) => void;
	onDelete: (book: Book) => void;
}) {
	const location = useLocation();
	const navigate = useNavigate();
	const trigger = useRef<HTMLButtonElement>(null);
	const client = useQueryClient();
	const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
	const failedCover = Boolean(
		book.cover_url && failedCoverUrl === book.cover_url,
	);
	const [coverAttempt, setCoverAttempt] = useState(0);
	const menuId = useId();
	const menu = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuPage, setMenuPage] = useState<BookMenuPage>("main");
	const returnToStatus = useRef(false);
	const positionMenu = useCallback(() => {
		const element = menu.current;
		const box = trigger.current?.getBoundingClientRect();
		if (!element || !box) return;
		const bounds = element.getBoundingClientRect();
		element.style.top = `${Math.max(12, Math.min(box.bottom + 6, window.innerHeight - bounds.height - 12))}px`;
		element.style.right = `${Math.max(12, Math.min(window.innerWidth - bounds.width - 12, window.innerWidth - box.right))}px`;
	}, []);
	useLayoutEffect(() => {
		if (!menuOpen) return;
		positionMenu();
		const element = menu.current;
		const selector =
			menuPage === "status"
				? '[aria-checked="true"]:not(:disabled)'
				: returnToStatus.current
					? "[data-status-trigger]"
					: "button:not(:disabled)";
		(
			element?.querySelector<HTMLButtonElement>(selector) ??
			element?.querySelector<HTMLButtonElement>("button:not(:disabled)")
		)?.focus();
	}, [menuOpen, menuPage, positionMenu]);
	useEffect(() => {
		if (!menuOpen) return;
		window.addEventListener("resize", positionMenu);
		return () => window.removeEventListener("resize", positionMenu);
	}, [menuOpen, positionMenu]);

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
						<BookCoverPlaceholder title={book.title} />
					)}
				</div>
				<h3 className="book-title" title={book.title}>
					{book.title}
				</h3>
			</Link>
			<div className="book-actions">
				<button
					type="button"
					ref={trigger}
					className="library-icon book-menu-trigger"
					aria-label={`「${book.title}」的更多操作`}
					title="更多操作"
					aria-haspopup="menu"
					popoverTarget={menuId}
				>
					<Icon name="more" />
				</button>
			</div>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				onToggle={(event) => {
					setMenuOpen(event.newState === "open");
					if (event.newState === "open") {
						returnToStatus.current = false;
						setMenuPage("main");
					}
				}}
				className="library-popover book-menu popover-motion"
				role="menu"
				aria-label={
					menuPage === "status" ? "阅读状态" : `「${book.title}」的更多操作`
				}
				onKeyDown={(event) => {
					const page = bookMenuPageForKey(
						menuPage,
						event.key,
						document.activeElement?.hasAttribute("data-status-trigger") ??
							false,
					);
					if (page !== menuPage) {
						event.preventDefault();
						event.stopPropagation();
						returnToStatus.current = page === "main";
						setMenuPage(page);
						return;
					}
					if (event.key === "Escape" || event.key === "Tab") {
						if (event.key === "Escape") event.preventDefault();
						menu.current?.hidePopover();
						trigger.current?.focus();
						return;
					}
					const controls = Array.from(
						event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
					);
					const current = controls.indexOf(
						document.activeElement as HTMLButtonElement,
					);
					const next = nextBookMenuIndex(
						controls.map((control) => control.disabled),
						current,
						event.key,
					);
					if (next !== null) {
						event.preventDefault();
						controls[next]?.focus();
					}
				}}
			>
				{menuPage === "main" ? (
					<>
						<button
							type="button"
							role="menuitem"
							tabIndex={-1}
							onClick={() => {
								menu.current?.hidePopover();
								navigate(`/materials/${book.id}/details`, {
									state: { returnTo },
								});
							}}
						>
							书籍详情
						</button>
						<button
							type="button"
							role="menuitem"
							tabIndex={-1}
							onClick={() => {
								menu.current?.hidePopover();
								trigger.current?.focus();
								onEdit(book.id);
							}}
						>
							编辑书籍信息
						</button>
						<button type="button" role="menuitem" tabIndex={-1} disabled>
							移动到其他来源… <small>暂未开放</small>
						</button>
						<button
							type="button"
							role="menuitem"
							tabIndex={-1}
							aria-haspopup="menu"
							data-status-trigger
							onClick={() => setMenuPage("status")}
						>
							阅读状态
							<span className="book-menu-meta">
								<small>{statusLabels[book.status]}</small>
								<span className="book-menu-arrow" aria-hidden="true">
									›
								</span>
							</span>
						</button>
						{failedCover && (
							<button
								type="button"
								role="menuitem"
								tabIndex={-1}
								onClick={() => {
									setFailedCoverUrl(null);
									setCoverAttempt((v) => v + 1);
									menu.current?.hidePopover();
								}}
							>
								重试封面
							</button>
						)}
						<hr />
						<button
							type="button"
							role="menuitem"
							tabIndex={-1}
							onClick={() => {
								menu.current?.hidePopover();
								trigger.current?.focus();
								onDelete(book);
							}}
						>
							删除书籍…
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							role="menuitem"
							tabIndex={-1}
							aria-label="返回更多操作"
							onClick={() => {
								returnToStatus.current = true;
								setMenuPage("main");
							}}
						>
							<span className="book-menu-arrow" aria-hidden="true">
								‹
							</span>
							阅读状态
						</button>
						<hr />
						{Object.entries(statusLabels).map(([value, label]) => (
							<button
								key={value}
								type="button"
								role="menuitemradio"
								tabIndex={-1}
								aria-checked={book.status === value}
								disabled={usage.isPending}
								onClick={() => {
									usage.mutate(value as Book["status"]);
									menu.current?.hidePopover();
								}}
							>
								{label}
								{book.status === value && <span aria-hidden="true">✓</span>}
							</button>
						))}
					</>
				)}
			</div>
			<InlineError error={usage.error} />
		</article>
	);
}
export function BookGrid({
	books,
	returnLabel,
	onEdit,
	onDelete,
	imports = [],
}: {
	books: readonly Book[];
	returnLabel: string;
	onEdit: (id: string) => void;
	onDelete: (book: Book) => void;
	imports?: readonly ImportTask[];
}) {
	return (
		<div className="book-grid">
			<ImportCards tasks={imports} returnLabel={returnLabel} />
			{books.map((book) => (
				<BookCard
					key={book.id}
					book={book}
					returnLabel={returnLabel}
					onEdit={onEdit}
					onDelete={onDelete}
				/>
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
	const catalogId = useId();
	const [editing, setEditing] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Book | null>(null);
	const focusAfterEdit = useRef(false);
	const client = useQueryClient();
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
	const renderedBooks = books.isSuccess ? books.data.items : [];
	const imports = useImportTasks(
		renderedBooks,
		sourceId,
		books.isSuccess && !books.isFetching,
	);
	useEffect(() => {
		if (
			editing !== null ||
			deleting !== null ||
			!focusAfterEdit.current ||
			books.isFetching ||
			(books.data &&
				state.page > lastCatalogPage(books.data.total, books.data.page_size)) ||
			books.data !== client.getQueryData(catalogKeys.books(query))
		)
			return;
		focusAfterEdit.current = false;
		const active = document.activeElement;
		const container = document.getElementById(catalogId);
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
	const scroll = useCatalogScroll(
		books.isSuccess,
		sourceId ?? "books",
		internal,
	);
	const lastPage = books.data
		? lastCatalogPage(books.data.total, books.data.page_size)
		: null;
	useEffect(() => {
		if (
			editing === null &&
			deleting === null &&
			lastPage !== null &&
			state.page > lastPage
		)
			change({ page: lastPage });
	}, [editing, deleting, lastPage, state.page, change]);
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
	const trueEmpty =
		books.isSuccess && !books.isFetching && view === "empty" && !imports.length;
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
				id={catalogId}
				tabIndex={-1}
				style={
					add ? ({ "--card-width": `${size}px` } as CSSProperties) : undefined
				}
				ref={scroll}
				className={internal ? "dialog-scroll" : "catalog-body"}
			>
				{(imports.length > 0 || renderedBooks.length > 0) && (
					<BookGrid
						books={renderedBooks}
						imports={imports}
						returnLabel={sourceId ? "来源书籍窗口" : "素材库"}
						onEdit={setEditing}
						onDelete={setDeleting}
					/>
				)}
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
				) : imports.length &&
					books.data.items.length === 0 ? null : trueEmpty && add ? (
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
						<span className="library-empty-title">留下一本好书</span>
						<span>点击这片区域，导入 EPUB</span>
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
				) : null}
				{books.data && (
					<Pagination
						page={state.page}
						total={books.data.total}
						pageSize={books.data.page_size}
						onChange={(page) => change({ page })}
					/>
				)}
			</div>
			{deleting !== null && (
				<BookDeleteDialog
					book={deleting}
					close={() => {
						focusAfterEdit.current = true;
						setDeleting(null);
					}}
					restoreFocusId={catalogId}
				/>
			)}
			{editing !== null && (
				<BookEditDialog
					id={editing}
					close={() => {
						focusAfterEdit.current = true;
						setEditing(null);
					}}
					restoreFocusId={catalogId}
				/>
			)}
		</>
	);
}
