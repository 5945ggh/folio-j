import type { Bookmark } from "./bookmarks-api";

export function bookmarkExcerpt(bookmark: Bookmark): string {
	return (
		bookmark.excerpt ||
		(bookmark.position.kind === "image" ? "图片位置" : "此处暂无原文摘要")
	);
}
export function BookmarkChapter({ bookmark }: { bookmark: Bookmark }) {
	return (
		<span className="reader-bookmark-chapter" lang="ja">
			{bookmark.chapter_title}
			{bookmark.chapter_progress != null && (
				<span> · 章内约 {Math.round(bookmark.chapter_progress * 100)}%</span>
			)}
		</span>
	);
}

export function BookmarkCreatedAt({ bookmark }: { bookmark: Bookmark }) {
	return (
		<span className="reader-bookmark-created">
			添加于{" "}
			<time dateTime={bookmark.created_at}>
				{new Date(bookmark.created_at).toLocaleString("zh-CN", {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23",
				})}
			</time>
		</span>
	);
}

export function BookmarkIcon({ name }: { name: "delete" | "note" | "jump" }) {
	return (
		<svg
			className="reader-bookmark-icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path
				d={
					name === "delete"
						? "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"
						: name === "note"
							? "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"
							: "M7 17 17 7M7 7h10v10"
				}
			/>
		</svg>
	);
}
