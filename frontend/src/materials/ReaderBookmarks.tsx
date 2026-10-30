import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RequestError } from "../content";
import { useViewActivity } from "../navigation/view-activity";
import type { Position, Settings } from "./api";
import {
	bookmarkDraftSession,
	bookmarkNoteTooLong,
	freezeBookmarkPosition,
} from "./bookmark-drafts";
import {
	type Bookmark,
	type BookmarkCreate,
	bookmarkKeys,
	createBookmark,
	deleteBookmark,
	getBookmark,
	listBookmarks,
	updateBookmark,
} from "./bookmarks-api";
import "./reader-bookmarks.css";

const pendingCreations = new Map<string, BookmarkCreate>();

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function isConflict(error: unknown): boolean {
	return error instanceof RequestError && error.status === 409;
}
function bookmarkExcerpt(bookmark: Bookmark): string {
	return (
		bookmark.excerpt ||
		(bookmark.position.kind === "image" ? "图片位置" : "此处暂无原文摘要")
	);
}

/** Owns a frozen creation request and its retry identity, independent of navigation and scrolling. */
export function useReaderBookmarks(materialId: string, versionId: string) {
	const client = useQueryClient();
	const sessionKey = JSON.stringify([materialId, versionId]);
	const pending = useRef<BookmarkCreate | null>(
		pendingCreations.get(sessionKey) ?? null,
	);
	const inFlight = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<Bookmark | null>(null);
	const [editing, setEditing] = useState<Bookmark | null>(null);
	const [editorRequest, setEditorRequest] = useState(0);
	const drafts = bookmarkDraftSession(materialId, versionId);
	const invalidate = () =>
		client.invalidateQueries({
			queryKey: bookmarkKeys.list(materialId, versionId),
		});
	const creation = useMutation({
		mutationFn: (request: BookmarkCreate) =>
			createBookmark(materialId, request),
		onSuccess: (bookmark, request) => {
			if (pendingCreations.get(sessionKey)?.request_id === request.request_id)
				pendingCreations.delete(sessionKey);
			pending.current = null;
			setCreated(bookmark);
			setError(null);
			void invalidate();
		},
		onError: (failure) =>
			setError(`书签未保存：${failureMessage(failure)} 重试将保存刚才的位置。`),
		onSettled: () => {
			inFlight.current = false;
		},
	});
	const submit = (request: BookmarkCreate) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setError(null);
		setCreated(null);
		creation.mutate(request);
	};
	const add = (sample: () => Position | null) => {
		if (inFlight.current) return;
		if (pending.current) {
			setError(
				"上次书签尚未确认保存，请重试保存刚才的位置，或放弃重试后添加新位置。",
			);
			return;
		}
		const position = freezeBookmarkPosition(sample(), versionId);
		if (!position) {
			setError("当前位置尚未稳定，请等待章节或排版呈现后重试。");
			return;
		}
		pending.current = { request_id: crypto.randomUUID(), position };
		pendingCreations.set(sessionKey, pending.current);
		submit(pending.current);
	};
	return {
		materialId,
		versionId,
		drafts,
		editing,
		editorRequest,
		busy: creation.isPending,
		created,
		error,
		add,
		invalidate,
		retry: () => {
			if (pending.current) submit(pending.current);
		},
		canRetry: pending.current !== null,
		discardRetry: () => {
			pending.current = null;
			pendingCreations.delete(sessionKey);
			setError(null);
		},
		dismiss: () => {
			setCreated(null);
			if (!pending.current) setError(null);
		},
		edit: (bookmark: Bookmark) => {
			setEditing(bookmark);
			setEditorRequest((value) => value + 1);
		},
		forgetCreated: (id: string) =>
			setCreated((current) => (current?.id === id ? null : current)),
		closeEditor: (id?: string) =>
			setEditing((current) => (!id || current?.id === id ? null : current)),
	};
}
export type ReaderBookmarks = ReturnType<typeof useReaderBookmarks>;

export function ReaderBookmarkNotice({
	bookmarks,
	onEdit,
}: {
	bookmarks: ReaderBookmarks;
	onEdit: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const [fading, setFading] = useState(false);
	const notice = useRef<HTMLElement>(null);
	const dismiss = useRef(bookmarks.dismiss);
	dismiss.current = bookmarks.dismiss;
	const visible = !!(bookmarks.created || bookmarks.error || bookmarks.busy);
	useEffect(() => {
		if (!visible) {
			setHovered(false);
			setFocused(false);
		}
	}, [visible]);
	useEffect(() => {
		setFading(false);
		if (
			!bookmarks.created ||
			bookmarks.error ||
			bookmarks.busy ||
			hovered ||
			focused
		)
			return;
		let fadeTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			setFading(true);
			fadeTimer = setTimeout(() => dismiss.current(), 180);
		}, 8000);
		return () => {
			clearTimeout(timer);
			if (fadeTimer) clearTimeout(fadeTimer);
		};
	}, [bookmarks.created, bookmarks.error, bookmarks.busy, hovered, focused]);
	useEffect(() => {
		const node = notice.current;
		const shell = node?.parentElement;
		if (!visible || !node || !shell) return;
		let speech: Element | null = null;
		const update = () => {
			const clearance = speech ? speech.getBoundingClientRect().height + 12 : 0;
			node.style.setProperty("--reader-speech-clearance", `${clearance}px`);
		};
		const resize = new ResizeObserver(update);
		const findSpeech = () => {
			resize.disconnect();
			speech = shell.querySelector(":scope > .device-speech-bar");
			if (speech) resize.observe(speech);
			update();
		};
		const changes = new MutationObserver(findSpeech);
		changes.observe(shell, { childList: true });
		findSpeech();
		return () => {
			resize.disconnect();
			changes.disconnect();
		};
	}, [visible]);
	if (!visible) return null;
	return (
		<aside
			ref={notice}
			className="reader-bookmark-notice"
			data-fading={fading || undefined}
			data-reader-tool
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setFocused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget))
					setFocused(false);
			}}
		>
			<div role={bookmarks.error ? "alert" : "status"}>
				{bookmarks.busy
					? "正在保存书签…"
					: bookmarks.error
						? bookmarks.error
						: bookmarks.created && (
								<>
									<strong>已添加书签</strong>
									<span lang="ja">{bookmarkExcerpt(bookmarks.created)}</span>
								</>
							)}
			</div>
			{bookmarks.created && (
				<button
					type="button"
					onClick={() => {
						if (bookmarks.created) bookmarks.edit(bookmarks.created);
						bookmarks.dismiss();
						onEdit();
					}}
				>
					添加备注
				</button>
			)}
			{bookmarks.error && bookmarks.canRetry && (
				<button
					type="button"
					disabled={bookmarks.busy}
					onClick={bookmarks.retry}
				>
					重试保存书签
				</button>
			)}
			{bookmarks.error && bookmarks.canRetry && (
				<button type="button" onClick={bookmarks.discardRetry}>
					放弃重试
				</button>
			)}
			{!bookmarks.canRetry && !bookmarks.busy && (
				<button
					type="button"
					aria-label="关闭书签提示"
					onClick={bookmarks.dismiss}
				>
					×
				</button>
			)}
		</aside>
	);
}

function BookmarkEditor({
	bookmark,
	bookmarks,
}: {
	bookmark: Bookmark;
	bookmarks: ReaderBookmarks;
}) {
	const [draft, setDraft] = useState(() => {
		const existing = bookmarks.drafts.read(bookmark);
		return bookmarks.drafts.write(existing.base, existing.note);
	});
	const [conflict, setConflict] = useState(draft.conflict);
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
			if (bookmarks.drafts.acceptSaved(saved, draft))
				bookmarks.closeEditor(bookmark.id);
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
			<strong>{draft.base.chapter_title}</strong>
			<p lang="ja">{bookmarkExcerpt(draft.base)}</p>
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
				可留空。草稿在本次会话保留，关闭导航后可继续编辑。
			</p>
			{tooLong && <p role="alert">备注不能超过 5000 个字符。</p>}
			{error && <p role="alert">{error}</p>}
			{conflict && (
				<button type="button" disabled={busy} onClick={() => reload.mutate()}>
					读取最新书签
				</button>
			)}
			{draft.base.revision !== bookmark.revision && !conflict && (
				<details>
					<summary>已读取最新备注，草稿仍保留</summary>
					<p className="reader-bookmark-note">
						{draft.base.note || "（空备注）"}
					</p>
				</details>
			)}
			<div className="reader-bookmark-actions">
				<button
					type="button"
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
						bookmarks.closeEditor();
					}}
				>
					取消编辑
				</button>
			</div>
		</section>
	);
}

function BookmarkItem({
	bookmark,
	bookmarks,
	settings,
	onNavigate,
}: {
	bookmark: Bookmark;
	bookmarks: ReaderBookmarks;
	settings: Settings;
	onNavigate: (position: Position) => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const [current, setCurrent] = useState(bookmark);
	const [conflict, setConflict] = useState(false);
	useEffect(() => setCurrent(bookmark), [bookmark]);
	const deletion = useMutation({
		mutationFn: () =>
			deleteBookmark(bookmarks.materialId, bookmark.id, current.revision),
		onSuccess: () => {
			bookmarks.forgetCreated(bookmark.id);
			bookmarks.drafts.clear(bookmark.id);
			bookmarks.closeEditor(bookmark.id);
			void bookmarks.invalidate();
		},
		onError: (failure) => {
			setConflict(isConflict(failure));
			setError(
				isConflict(failure)
					? "书签已更新，请读取最新书签后重试删除。"
					: `删除失败：${failureMessage(failure)}`,
			);
		},
	});
	const reload = useMutation({
		mutationFn: () => getBookmark(bookmarks.materialId, bookmark.id),
		onSuccess: (latest) => {
			setCurrent(latest);
			setConflict(false);
			setError(null);
			void bookmarks.invalidate();
		},
		onError: (failure) =>
			setError(`无法读取最新书签：${failureMessage(failure)}`),
	});
	return (
		<li className="reader-bookmark-item">
			<button
				type="button"
				className="reader-bookmark-jump"
				aria-label={`前往书签：${current.chapter_title}`}
				onClick={() => onNavigate({ ...current.position, settings })}
			>
				<span className="reader-bookmark-chapter" lang="ja">
					{current.chapter_title}
				</span>
				<span className="reader-bookmark-excerpt" lang="ja">
					{bookmarkExcerpt(current)}
				</span>
			</button>
			{current.note && <p className="reader-bookmark-note">{current.note}</p>}
			<div className="reader-bookmark-actions">
				<button type="button" onClick={() => bookmarks.edit(current)}>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" />
					</svg>
					{current.note ? "编辑备注" : "添加备注"}
				</button>
				<button
					type="button"
					className="reader-bookmark-delete"
					aria-label="删除书签"
					title="删除书签"
					disabled={deletion.isPending || reload.isPending || conflict}
					onClick={() => {
						if (window.confirm("删除这个书签及其备注？此操作无法撤销。")) {
							setError(null);
							deletion.mutate();
						}
					}}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
					</svg>
				</button>
			</div>
			{error && <p role="alert">{error}</p>}
			{conflict && (
				<button
					type="button"
					disabled={reload.isPending}
					onClick={() => reload.mutate()}
				>
					读取最新书签
				</button>
			)}
		</li>
	);
}
export function ReaderBookmarksContent({
	bookmarks,
	active,
	settings,
	navigationError,
	onNavigate,
}: {
	bookmarks: ReaderBookmarks;
	active: boolean;
	settings: Settings;
	navigationError?: Error | null;
	onNavigate: (position: Position) => void;
}) {
	const activity = useViewActivity();
	const query = useInfiniteQuery({
		queryKey: bookmarkKeys.list(bookmarks.materialId, bookmarks.versionId),
		queryFn: ({ pageParam, signal }) =>
			listBookmarks(
				bookmarks.materialId,
				bookmarks.versionId,
				pageParam,
				signal,
			),
		initialPageParam: 0,
		getNextPageParam: (page) =>
			page.offset + page.items.length < page.total
				? page.offset + page.items.length
				: undefined,
		enabled: active && activity.active,
		retry: false,
	});
	// Failed validation must not keep an earlier material/source snapshot visible.
	const page = query.isError ? undefined : query.data;
	const items = page?.pages.flatMap((entry) => entry.items) ?? [];
	const listError =
		query.error instanceof RequestError && query.error.status === 404
			? "本书或所属来源已不可用，暂时无法查看书签。备注草稿已保留。"
			: query.error instanceof RequestError && query.error.status === 409
				? "本书版本已变化，请重新打开本书后查看书签。备注草稿已保留。"
				: "书签读取失败，请重试。备注草稿已保留。";
	const created = bookmarks.created;
	const forgetCreated = bookmarks.forgetCreated;
	useEffect(() => {
		if (query.isError && created) forgetCreated(created.id);
	}, [query.isError, created, forgetCreated]);
	return (
		<div className="reader-bookmarks-content">
			<p className="reader-bookmark-hint">
				{query.isError
					? "书签清单暂不可用"
					: `按书中顺序 · ${page?.pages[0]?.total ?? "—"} 个书签`}
			</p>
			{!query.isError && bookmarks.editing && (
				<BookmarkEditor
					key={`${bookmarks.editing.id}:${bookmarks.editorRequest}`}
					bookmark={bookmarks.editing}
					bookmarks={bookmarks}
				/>
			)}
			{!query.isError && navigationError && (
				<p role="alert">
					定位失败：{navigationError.message}。请再次点击书签重试。
				</p>
			)}
			{query.isPending && <p role="status">正在读取书签…</p>}
			{query.isError && (
				<p role="alert">
					{listError}
					<button
						type="button"
						onClick={() => {
							void query.refetch();
						}}
					>
						重试读取书签
					</button>
				</p>
			)}
			{page?.pages[0]?.total === 0 && (
				<p className="reader-query-status">
					还没有书签。点击工具栏的书签图标保存当前位置。
				</p>
			)}
			<ol aria-label="位置书签" className="reader-bookmarks-list">
				{items.map((bookmark) => (
					<BookmarkItem
						key={bookmark.id}
						bookmark={bookmark}
						bookmarks={bookmarks}
						settings={settings}
						onNavigate={onNavigate}
					/>
				))}
			</ol>
			{!query.isError && query.hasNextPage && (
				<button
					type="button"
					disabled={query.isFetching}
					onClick={() => {
						void query.fetchNextPage();
					}}
				>
					{query.isFetchingNextPage ? "正在读取…" : "更多书签"}
				</button>
			)}
		</div>
	);
}
