import type { Position } from "./api.ts";
import type { Bookmark, BookmarkPosition } from "./bookmarks-api.ts";

export const BOOKMARK_NOTE_LIMIT = 5000;
export function bookmarkNoteTooLong(note: string): boolean {
	return Array.from(note.normalize("NFC")).length > BOOKMARK_NOTE_LIMIT;
}
/** A fresh DOM sample is mandatory; persisted or provisional positions never enter this seam. */
export function freezeBookmarkPosition(
	position: Position | null,
	versionId: string,
): BookmarkPosition | null {
	if (!position || position.version_id !== versionId) return null;
	const { settings: _settings, ...anchor } = position;
	return { ...anchor };
}
export type BookmarkDraft = { base: Bookmark; note: string; conflict: boolean };
/** Reader and its panel may unmount independently. Draft identity and revision survive both. */
export class BookmarkDrafts {
	private drafts = new Map<string, BookmarkDraft>();
	read(bookmark: Bookmark): BookmarkDraft {
		return (
			this.drafts.get(bookmark.id) ?? {
				base: bookmark,
				note: bookmark.note,
				conflict: false,
			}
		);
	}
	write(bookmark: Bookmark, note: string): BookmarkDraft {
		const draft = { ...this.read(bookmark), note };
		this.drafts.set(bookmark.id, draft);
		return draft;
	}
	rebase(bookmark: Bookmark): BookmarkDraft {
		const draft = {
			base: bookmark,
			note: this.read(bookmark).note,
			conflict: false,
		};
		this.drafts.set(bookmark.id, draft);
		return draft;
	}
	markConflict(bookmark: Bookmark): void {
		this.drafts.set(bookmark.id, { ...this.read(bookmark), conflict: true });
	}
	acceptSaved(saved: Bookmark, submitted: BookmarkDraft): boolean {
		const current = this.drafts.get(saved.id);
		if (!current) return true;
		if (
			current.base.revision === submitted.base.revision &&
			current.note === submitted.note
		) {
			this.drafts.delete(saved.id);
			return true;
		}
		this.drafts.set(saved.id, {
			base: saved,
			note: current.note,
			conflict: false,
		});
		return false;
	}
	clear(id: string): void {
		this.drafts.delete(id);
	}
}
const sessions = new Map<string, BookmarkDrafts>();
export function bookmarkDraftSession(
	materialId: string,
	versionId: string,
): BookmarkDrafts {
	const key = JSON.stringify([materialId, versionId]);
	let session = sessions.get(key);
	if (!session) {
		session = new BookmarkDrafts();
		sessions.set(key, session);
	}
	return session;
}
