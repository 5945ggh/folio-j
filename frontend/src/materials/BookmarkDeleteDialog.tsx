import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { RequestError } from "../content";
import { ConfirmDialog } from "../Shared";
import { bookmarkExcerpt } from "./BookmarkPresentation";
import {
	type Bookmark,
	bookmarkKeys,
	deleteBookmark,
	getBookmark,
} from "./bookmarks-api";
import type { ReaderBookmarks } from "./ReaderBookmarks";

/** The confirmation owns its snapshot; only an explicit reload may raise its revision. */
export function BookmarkDeleteDialog({
	bookmark,
	bookmarks,
	onClose,
	onDeleted,
	restoreFocusId,
}: {
	bookmark: Bookmark;
	bookmarks: ReaderBookmarks;
	onClose: () => void;
	onDeleted: (id: string) => void;
	restoreFocusId?: string;
}) {
	const titleId = useId();
	const client = useQueryClient();
	const [current, setCurrent] = useState(bookmark);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const deletion = useMutation({
		mutationFn: () =>
			deleteBookmark(bookmarks.materialId, current.id, current.revision),
		onSuccess: async () => {
			bookmarks.forgetCreated(current.id);
			bookmarks.drafts.clear(current.id);
			bookmarks.closeEditor(current.id);
			client.removeQueries({
				queryKey: bookmarkKeys.item(bookmarks.materialId, current.id),
			});
			await bookmarks.invalidate();
			onClose();
			onDeleted(current.id);
		},
		onError: (failure) => {
			const changed = failure instanceof RequestError && failure.status === 409;
			setConflict(changed);
			setError(
				changed
					? "书签已更新，请读取最新书签后重试删除。"
					: `删除失败：${failure instanceof Error ? failure.message : String(failure)}`,
			);
		},
	});
	const reload = useMutation({
		mutationFn: () => getBookmark(bookmarks.materialId, current.id),
		onSuccess: (latest) => {
			setCurrent(latest);
			client.setQueryData(
				bookmarkKeys.item(bookmarks.materialId, latest.id),
				latest,
			);
			setConflict(false);
			setError(null);
			void bookmarks.invalidate();
		},
		onError: (failure) =>
			setError(
				`无法读取最新书签：${failure instanceof Error ? failure.message : String(failure)}`,
			),
	});
	const busy = deletion.isPending || reload.isPending;
	return (
		<ConfirmDialog
			titleId={titleId}
			className="reader-bookmark-confirm"
			restoreFocusId={restoreFocusId}
			onClose={() => {
				if (!busy) onClose();
			}}
		>
			<h2 id={titleId}>删除这个书签？</h2>
			<p className="reader-bookmark-delete-source" lang="ja">
				{current.chapter_title} · {bookmarkExcerpt(current)}
			</p>
			<p>会同时删除备注，此操作无法撤销。</p>
			{current.note && (
				<p className="reader-bookmark-delete-source">备注：{current.note}</p>
			)}
			{error && <p role="alert">{error}</p>}
			{error && (
				<button type="button" disabled={busy} onClick={() => reload.mutate()}>
					读取最新书签
				</button>
			)}
			<div className="actions">
				<button
					type="button"
					className="button secondary"
					data-dialog-cancel
					disabled={busy}
					onClick={onClose}
				>
					取消
				</button>
				<button
					type="button"
					className="button danger reader-bookmark-delete"
					disabled={busy || conflict}
					onClick={() => {
						setError(null);
						deletion.mutate();
					}}
				>
					{deletion.isPending ? "正在删除…" : "删除书签"}
				</button>
			</div>
		</ConfirmDialog>
	);
}
