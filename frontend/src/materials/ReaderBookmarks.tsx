import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { RequestError } from "../content";
import { useViewActivity } from "../navigation/view-activity";
import type { Position, Settings } from "./api";
import { BookmarkDeleteDialog } from "./BookmarkDeleteDialog";
import {
	BookmarkChapter,
	BookmarkIcon,
	bookmarkExcerpt,
} from "./BookmarkPresentation";
import { BookmarkCreationIntent } from "./bookmark-creation";
import {
	bookmarkDraftSession,
	freezeBookmarkPosition,
} from "./bookmark-drafts";
import {
	type Bookmark,
	type BookmarkCreate,
	bookmarkKeys,
	createBookmark,
	listBookmarks,
} from "./bookmarks-api";
import { ReaderBookmarkDetail } from "./ReaderBookmarkDetail";
import "./reader-bookmarks.css";

const pendingCreations = new Map<string, BookmarkCreationIntent>();

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
/** Owns a frozen creation request and its retry identity, independent of navigation and scrolling. */
export function useReaderBookmarks(materialId: string, versionId: string) {
	const client = useQueryClient();
	const sessionKey = JSON.stringify([materialId, versionId]);
	const pending = useRef(
		pendingCreations.get(sessionKey) ?? new BookmarkCreationIntent(),
	);
	const inFlight = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<Bookmark | null>(null);
	const [editing, setEditing] = useState<Bookmark | null>(null);
	const [detailEditing, setDetailEditing] = useState(false);
	const [nearby, setNearby] = useState<Bookmark | null>(null);
	const [editorRequest, setEditorRequest] = useState(0);
	const drafts = bookmarkDraftSession(materialId, versionId);
	const invalidate = () =>
		client.invalidateQueries({
			queryKey: bookmarkKeys.list(materialId, versionId),
		});
	const creation = useMutation({
		mutationFn: (request: BookmarkCreate) =>
			createBookmark(materialId, request),
		onSuccess: (result, request) => {
			if (!pending.current.isCurrent(request)) return;
			setError(null);
			if ("kind" in result) {
				pending.current.offerNearby();
				setNearby(result.bookmark);
				return;
			}
			pendingCreations.delete(sessionKey);
			pending.current.clear();
			setNearby(null);
			setCreated(result);
			void invalidate();
		},
		onError: (failure, request) => {
			if (!pending.current.isCurrent(request)) return;
			setError(`书签未保存：${failureMessage(failure)} 重试将保存刚才的位置。`);
		},
		onSettled: () => {
			inFlight.current = false;
		},
	});
	const submit = (request: BookmarkCreate) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setError(null);
		setCreated(null);
		setNearby(null);
		creation.mutate(request);
	};
	const add = (sample: () => Position | null) => {
		if (inFlight.current) return;
		if (pending.current.canRetry) {
			setError(
				"上次书签尚未确认保存，请重试保存刚才的位置，或放弃重试后添加新位置。",
			);
			return;
		}
		if (pending.current.nearby) {
			pending.current.clear();
			pendingCreations.delete(sessionKey);
		}
		setNearby(null);
		setCreated(null);
		const position = freezeBookmarkPosition(sample(), versionId);
		if (!position) {
			setError("当前位置尚未稳定，请等待章节或排版呈现后重试。");
			return;
		}
		const request = {
			request_id: crypto.randomUUID(),
			position,
			allow_nearby: false,
		};
		pending.current.start(request);
		pendingCreations.set(sessionKey, pending.current);
		submit(request);
	};
	useEffect(
		() => () => {
			if (pending.current.nearby) {
				pending.current.clear();
				pendingCreations.delete(sessionKey);
			}
		},
		[sessionKey],
	);
	return {
		materialId,
		versionId,
		drafts,
		editing,
		detailEditing,
		nearby,
		editorRequest,
		busy: creation.isPending,
		created,
		error,
		add,
		invalidate,
		retry: () => {
			if (pending.current.canRetry && pending.current.request)
				submit(pending.current.request);
		},
		canRetry: pending.current.canRetry,
		force: () => {
			const request = pending.current.force();
			if (request) submit(request);
		},
		discardRetry: () => {
			pending.current.clear();
			pendingCreations.delete(sessionKey);
			setError(null);
		},
		dismiss: () => {
			setCreated(null);
			setNearby(null);
			if (pending.current.nearby) {
				pending.current.clear();
				pendingCreations.delete(sessionKey);
			}
			if (!pending.current.canRetry) setError(null);
		},
		edit: (bookmark: Bookmark, editNote = true) => {
			setEditing(bookmark);
			setDetailEditing(editNote);
			setEditorRequest((value) => value + 1);
		},
		forgetCreated: (id: string) => {
			setCreated((current) => (current?.id === id ? null : current));
			setNearby((current) => {
				if (current?.id !== id) return current;
				if (pending.current.nearby) {
					pending.current.clear();
					pendingCreations.delete(sessionKey);
				}
				return null;
			});
		},
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
	const visible = !!(
		bookmarks.created ||
		bookmarks.nearby ||
		bookmarks.error ||
		bookmarks.busy
	);
	useEffect(() => {
		if (!visible) {
			setHovered(false);
			setFocused(false);
		}
	}, [visible]);
	useEffect(() => {
		setFading(false);
		if (
			!(bookmarks.created || bookmarks.nearby) ||
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
	}, [
		bookmarks.created,
		bookmarks.nearby,
		bookmarks.error,
		bookmarks.busy,
		hovered,
		focused,
	]);
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
				{bookmarks.busy ? (
					"正在保存书签…"
				) : bookmarks.error ? (
					bookmarks.error
				) : bookmarks.nearby ? (
					<strong>附近已有书签</strong>
				) : (
					bookmarks.created && (
						<>
							<strong>已添加书签</strong>
							<span lang="ja">{bookmarkExcerpt(bookmarks.created)}</span>
						</>
					)
				)}
			</div>
			{bookmarks.created && (
				<button
					type="button"
					className="reader-bookmark-note-action"
					onClick={() => {
						if (bookmarks.created) bookmarks.edit(bookmarks.created);
						bookmarks.dismiss();
						onEdit();
					}}
				>
					添加备注
				</button>
			)}
			{bookmarks.nearby && (
				<>
					<button
						type="button"
						onClick={() => {
							if (bookmarks.nearby) bookmarks.edit(bookmarks.nearby, false);
							bookmarks.dismiss();
							onEdit();
						}}
					>
						查看已有
					</button>
					<button
						type="button"
						className="reader-bookmark-note-action"
						onClick={bookmarks.force}
					>
						仍然添加
					</button>
				</>
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

function BookmarkItem({
	bookmark,
	bookmarks,
	settings,
	onNavigate,
	restoreFocusId,
	onDeleted,
}: {
	bookmark: Bookmark;
	bookmarks: ReaderBookmarks;
	settings: Settings;
	onNavigate: (position: Position) => void;
	restoreFocusId: string;
	onDeleted: (id: string) => void;
}) {
	const [deleting, setDeleting] = useState(false);
	const selected = bookmarks.editing?.id === bookmark.id;
	return (
		<li
			className="reader-bookmark-item"
			data-selected={selected || deleting || undefined}
		>
			<button
				type="button"
				className="reader-bookmark-open"
				aria-haspopup="dialog"
				aria-expanded={selected}
				aria-label={`查看书签详情：${bookmark.chapter_title}`}
				onClick={() => bookmarks.edit(bookmark, false)}
			>
				<BookmarkChapter bookmark={bookmark} />
				<span className="reader-bookmark-excerpt" lang="ja">
					{bookmarkExcerpt(bookmark)}
				</span>
				{bookmark.note && (
					<span className="reader-bookmark-note">{bookmark.note}</span>
				)}
			</button>
			<div className="reader-bookmark-item-actions">
				<button
					type="button"
					className="reader-bookmark-quick-delete reader-bookmark-delete"
					aria-label={`删除书签：${bookmark.chapter_title}`}
					title="删除书签"
					onClick={() => setDeleting(true)}
				>
					<BookmarkIcon name="delete" />
				</button>
				<button
					type="button"
					className="reader-bookmark-jump"
					aria-label={`前往书签：${bookmark.chapter_title}`}
					onClick={() => {
						bookmarks.closeEditor();
						onNavigate({ ...bookmark.position, settings });
					}}
				>
					前往原文 <BookmarkIcon name="jump" />
				</button>
			</div>
			{deleting && (
				<BookmarkDeleteDialog
					bookmark={bookmark}
					bookmarks={bookmarks}
					restoreFocusId={restoreFocusId}
					onDeleted={onDeleted}
					onClose={() => setDeleting(false)}
				/>
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
	const listFocusId = useId();
	const list = useRef<HTMLOListElement>(null);
	const [deletedId, setDeletedId] = useState<string | null>(null);
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
	useEffect(() => {
		if (!deletedId) return;
		if (!active || !activity.active || query.isError) {
			setDeletedId(null);
			return;
		}
		// The stable owner restores focus after React removes the deleted row and its modal.
		if (items.some((item) => item.id === deletedId)) return;
		list.current?.focus({ preventScroll: true });
		setDeletedId(null);
	}, [deletedId, active, activity.active, query.isError, items]);
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
	const closeEditor = useRef(bookmarks.closeEditor);
	closeEditor.current = bookmarks.closeEditor;
	useEffect(() => {
		if (!active || query.isError) closeEditor.current();
	}, [active, query.isError]);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			queueMicrotask(() => {
				if (!mounted.current) closeEditor.current();
			});
		};
	}, []);
	return (
		<div className="reader-bookmarks-content">
			<p className="reader-bookmark-hint">
				{query.isError
					? "书签清单暂不可用"
					: `按书中顺序 · ${page?.pages[0]?.total ?? "—"} 个书签`}
			</p>
			{active && !query.isError && bookmarks.editing && (
				<ReaderBookmarkDetail
					key={`${bookmarks.editing.id}:${bookmarks.editorRequest}`}
					bookmark={bookmarks.editing}
					listUpdatedAt={query.dataUpdatedAt}
					bookmarks={bookmarks}
					settings={settings}
					onNavigate={onNavigate}
					restoreFocusId={listFocusId}
					onDeleted={setDeletedId}
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
			<ol
				id={listFocusId}
				ref={list}
				tabIndex={-1}
				aria-label="位置书签"
				className="reader-bookmarks-list"
			>
				{items.map((bookmark) => (
					<BookmarkItem
						key={bookmark.id}
						bookmark={bookmark}
						bookmarks={bookmarks}
						settings={settings}
						onNavigate={onNavigate}
						restoreFocusId={listFocusId}
						onDeleted={setDeletedId}
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
