import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RequestError } from "../content";
import type { Position, Settings } from "./api";
import { BookmarkDeleteDialog } from "./BookmarkDeleteDialog";
import {
	BookmarkChapter,
	BookmarkCreatedAt,
	BookmarkIcon,
	bookmarkExcerpt,
} from "./BookmarkPresentation";
import { bookmarkDetailPosition } from "./bookmark-detail-position";
import { bookmarkNoteTooLong } from "./bookmark-drafts";
import {
	type Bookmark,
	bookmarkKeys,
	getBookmark,
	updateBookmark,
} from "./bookmarks-api";
import type { ReaderBookmarks } from "./ReaderBookmarks";

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function isConflict(error: unknown): boolean {
	return error instanceof RequestError && error.status === 409;
}

function BookmarkEditor({
	bookmark,
	bookmarks,
	onSaved,
	onCancel,
}: {
	bookmark: Bookmark;
	bookmarks: ReaderBookmarks;
	onSaved: (saved: Bookmark) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(() => {
		const existing = bookmarks.drafts.read(bookmark);
		return bookmarks.drafts.write(existing.base, existing.note);
	});
	const [conflict, setConflict] = useState(draft.conflict);
	const [reloaded, setReloaded] = useState(false);
	const [error, setError] = useState<string | null>(
		draft.conflict
			? "此书签已在其他操作中更新，备注草稿已保留。请读取最新书签后确认保存。"
			: null,
	);
	const textarea = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		textarea.current?.focus({ preventScroll: true });
	}, []);
	const save = useMutation({
		mutationFn: () =>
			updateBookmark(
				bookmarks.materialId,
				bookmark.id,
				draft.note,
				draft.base.revision,
			),
		onSuccess: (saved) => {
			bookmarks.forgetCreated(saved.id);
			if (bookmarks.drafts.acceptSaved(saved, draft)) onSaved(saved);
			void bookmarks.invalidate();
		},
		onError: (failure) => {
			if (isConflict(failure)) bookmarks.drafts.markConflict(draft.base);
			setConflict(isConflict(failure));
			setError(
				isConflict(failure)
					? "此书签已在其他操作中更新，备注草稿已保留。请读取最新书签后确认保存。"
					: `备注未保存：${failureMessage(failure)} 草稿已保留。`,
			);
		},
	});
	const reload = useMutation({
		mutationFn: () => getBookmark(bookmarks.materialId, bookmark.id),
		onSuccess: (latest) => {
			setDraft(bookmarks.drafts.rebase(latest));
			setReloaded(true);
			setConflict(false);
			setError(null);
			void bookmarks.invalidate();
		},
		onError: (failure) =>
			setError(`无法读取最新书签：${failureMessage(failure)} 草稿已保留。`),
	});
	const tooLong = bookmarkNoteTooLong(draft.note);
	const busy = save.isPending || reload.isPending;
	return (
		<section className="reader-bookmark-editor" aria-label="编辑书签备注">
			<label>
				书签备注
				<textarea
					ref={textarea}
					aria-label="书签备注"
					value={draft.note}
					disabled={busy}
					onChange={(event) =>
						setDraft(bookmarks.drafts.write(draft.base, event.target.value))
					}
				/>
			</label>
			<p className="reader-bookmark-hint">
				可留空。草稿在本次会话保留，关闭详情后可继续编辑。
			</p>
			{tooLong && <p role="alert">备注不能超过 5000 个字符。</p>}
			{error && <p role="alert">{error}</p>}
			{conflict && (
				<button type="button" disabled={busy} onClick={() => reload.mutate()}>
					读取最新书签
				</button>
			)}
			{(reloaded || draft.base.revision !== bookmark.revision) && !conflict && (
				<details>
					<summary>
						{draft.base.revision < bookmark.revision
							? "书签已有更新，草稿仍保留"
							: "已读取最新备注，草稿仍保留"}
					</summary>
					<p className="reader-bookmark-note">
						{(draft.base.revision >= bookmark.revision
							? draft.base.note
							: bookmark.note) || "（空备注）"}
					</p>
				</details>
			)}
			<div className="reader-bookmark-actions">
				<button
					type="button"
					className="reader-bookmark-note-action"
					disabled={busy || tooLong || conflict}
					onClick={() => {
						setError(null);
						save.mutate();
					}}
				>
					{save.isPending ? "正在保存…" : "保存备注"}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						bookmarks.drafts.clear(bookmark.id);
						onCancel();
					}}
				>
					取消编辑
				</button>
			</div>
		</section>
	);
}

export function ReaderBookmarkDetail({
	bookmark,
	listUpdatedAt,
	bookmarks,
	settings,
	onNavigate,
	restoreFocusId,
	onDeleted,
}: {
	bookmark: Bookmark;
	listUpdatedAt: number;
	bookmarks: ReaderBookmarks;
	settings: Settings;
	onNavigate: (position: Position) => void;
	restoreFocusId: string;
	onDeleted: (id: string) => void;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const [deleting, setDeleting] = useState<Bookmark | null>(null);
	const [editing, setEditing] = useState(bookmarks.detailEditing);
	const client = useQueryClient();
	const itemKey = bookmarkKeys.item(bookmarks.materialId, bookmark.id);
	const validation = useQuery({
		queryKey: itemKey,
		queryFn: ({ signal }) =>
			getBookmark(bookmarks.materialId, bookmark.id, signal),
		refetchOnMount: "always",
		retry: false,
	});
	const lastListUpdate = useRef(listUpdatedAt);
	useEffect(() => {
		if (lastListUpdate.current === listUpdatedAt) return;
		lastListUpdate.current = listUpdatedAt;
		void validation.refetch();
	}, [listUpdatedAt, validation.refetch]);
	const close = useRef(bookmarks.closeEditor);
	close.current = bookmarks.closeEditor;
	useEffect(() => {
		if (
			validation.error instanceof RequestError &&
			[404, 409].includes(validation.error.status)
		)
			close.current(bookmark.id);
	}, [validation.error, bookmark.id]);
	useLayoutEffect(() => {
		const element = panel.current;
		if (!element) return;
		const previous = document.activeElement;
		const side = element.closest<HTMLElement>("[data-reader-panel-side]");
		const position = () => {
			const rect = side?.getBoundingClientRect() ?? { right: 392, top: 76 };
			const placement = bookmarkDetailPosition(rect, {
				width: window.innerWidth,
				height: window.innerHeight,
			});
			Object.assign(element.style, {
				left: `${placement.left}px`,
				top: `${placement.top}px`,
				width: `${placement.width}px`,
				maxHeight: `${placement.maxHeight}px`,
			});
		};
		position();
		element.showPopover();
		element
			.querySelector<HTMLButtonElement>("button")
			?.focus({ preventScroll: true });
		const keydown = (event: KeyboardEvent) => {
			if (event.key === "Escape") event.stopPropagation();
		};
		element.addEventListener("keydown", keydown);
		window.addEventListener("resize", position);
		const resize = new ResizeObserver(position);
		if (side) resize.observe(side);
		return () => {
			element.removeEventListener("keydown", keydown);
			window.removeEventListener("resize", position);
			resize.disconnect();
			if (element.matches(":popover-open")) element.hidePopover();
			if (
				previous instanceof HTMLElement &&
				previous.isConnected &&
				previous.getClientRects().length &&
				!previous.closest("[inert]")
			)
				previous.focus({ preventScroll: true });
			else
				side
					?.querySelector<HTMLButtonElement>(".reader-panel-close")
					?.focus({ preventScroll: true });
		};
	}, []);
	const available = validation.isFetchedAfterMount && !validation.isError;
	// Automatic refresh may update the read view, while a delete confirmation owns its frozen revision.
	// BookmarkEditor retains its own draft baseline and never rebases from this refreshed DTO.
	const displayed = deleting ?? validation.data ?? bookmark;
	return (
		<div
			ref={panel}
			popover="auto"
			role="dialog"
			aria-label="书签详情"
			className="reader-bookmark-detail"
			data-reader-tool
			onToggle={(event) => {
				if (event.newState === "closed") close.current(bookmark.id);
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") event.stopPropagation();
			}}
		>
			<header>
				<strong>书签详情</strong>
				<button
					type="button"
					className="reader-bookmark-detail-close"
					aria-label="关闭书签详情"
					onClick={() => bookmarks.closeEditor(bookmark.id)}
				>
					×
				</button>
			</header>

			<div className="reader-bookmark-detail-content">
				{!validation.isFetchedAfterMount && <p role="status">正在核验书签…</p>}
				{validation.isError && (
					<p role="alert">
						无法读取书签，备注草稿已保留。
						<button
							type="button"
							disabled={validation.isFetching}
							onClick={() => {
								void validation.refetch();
							}}
						>
							重试读取书签
						</button>
					</p>
				)}
				{available && (
					<>
						<div className="reader-bookmark-detail-meta">
							<BookmarkChapter bookmark={displayed} />
							<BookmarkCreatedAt bookmark={displayed} />
						</div>
						<section className="reader-bookmark-original" aria-label="原文摘录">
							<h3>原文摘录</h3>
							<blockquote className="reader-bookmark-detail-excerpt" lang="ja">
								{bookmarkExcerpt(displayed)}
							</blockquote>
						</section>
						<section className="reader-bookmark-notes" aria-label="书签备注">
							<div className="reader-bookmark-section-heading">
								<h3>备注</h3>
								{!editing && (
									<button
										type="button"
										className="reader-bookmark-edit-note"
										onClick={() => setEditing(true)}
									>
										<BookmarkIcon name="note" />
										{displayed.note ? "编辑备注" : "添加备注"}
									</button>
								)}
							</div>
							{editing ? (
								<BookmarkEditor
									bookmark={displayed}
									bookmarks={bookmarks}
									onSaved={(saved) => {
										client.setQueryData(itemKey, saved);
										setEditing(false);
									}}
									onCancel={() => setEditing(false)}
								/>
							) : displayed.note ? (
								<p className="reader-bookmark-note">{displayed.note}</p>
							) : (
								<p className="reader-bookmark-empty-note">暂无备注</p>
							)}
						</section>
					</>
				)}
			</div>
			{available && (
				<footer className="reader-bookmark-detail-actions">
					<button
						type="button"
						className="reader-bookmark-delete"
						aria-label="删除书签"
						onClick={() => setDeleting(displayed)}
					>
						<BookmarkIcon name="delete" />
						删除
					</button>
					<button
						type="button"
						className="reader-bookmark-note-action reader-bookmark-go"
						onClick={() => {
							bookmarks.closeEditor();
							onNavigate({ ...displayed.position, settings });
						}}
					>
						前往原文 <BookmarkIcon name="jump" />
					</button>
				</footer>
			)}
			{deleting && available && (
				<BookmarkDeleteDialog
					bookmark={deleting}
					bookmarks={bookmarks}
					restoreFocusId={restoreFocusId}
					onDeleted={onDeleted}
					onClose={() => setDeleting(null)}
				/>
			)}
		</div>
	);
}
