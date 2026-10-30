import assert from "node:assert/strict";
import test from "node:test";
import type { Position } from "./api.ts";
import {
	BookmarkDrafts,
	bookmarkDraftSession,
	bookmarkNoteTooLong,
	freezeBookmarkPosition,
} from "./bookmark-drafts.ts";
import type { Bookmark } from "./bookmarks-api.ts";

const position: Position = {
	version_id: "version-1",
	chapter_id: "chapter-1",
	resource_id: "resource-1",
	part_index: 2,
	kind: "text",
	offset: 18,
	at_chapter_end: false,
	settings: { font_size: 20, line_height: 1.8, writing_mode: "horizontal-tb" },
};
const bookmark: Bookmark = {
	id: "bookmark-1",
	material_id: "material-1",
	position,
	note: "original note",
	excerpt: "原文",
	chapter_title: "第一章",
	revision: 4,
	created_at: "2026-10-29T00:00:00Z",
	updated_at: "2026-10-29T00:00:00Z",
};

test("bookmark capture requires an available sample from the exact material version", () => {
	assert.equal(freezeBookmarkPosition(null, "version-1"), null);
	assert.equal(freezeBookmarkPosition(position, "version-2"), null);
	const source = { ...position };
	const frozen = freezeBookmarkPosition(source, "version-1");
	source.offset = 99;
	assert.equal(frozen?.offset, 18);
	assert.equal(frozen && "settings" in frozen, false);
	const image = freezeBookmarkPosition(
		{
			...position,
			kind: "image",
			image_id: 7,
			image_progress: 0.4,
			offset: null,
		},
		"version-1",
	);
	assert.equal(image?.image_progress, 0.4);
	assert.equal(image?.image_id, 7);
});

test("clearing a note is a draft and cache refresh never replaces its revision baseline", () => {
	const drafts = new BookmarkDrafts();
	drafts.write(bookmark, "");
	const refreshed = { ...bookmark, note: "remote update", revision: 5 };
	assert.equal(drafts.read(refreshed).note, "");
	assert.equal(drafts.read(refreshed).base.revision, 4);
	drafts.markConflict(bookmark);
	assert.equal(drafts.read(refreshed).conflict, true);
	const rebased = drafts.rebase(refreshed);
	assert.equal(rebased.conflict, false);
	assert.equal(rebased.note, "");
	assert.equal(rebased.base.note, "remote update");
	assert.equal(rebased.base.revision, 5);
	drafts.clear(bookmark.id);
	assert.equal(drafts.read(refreshed).note, "remote update");
});

test("saving an earlier draft keeps edits made after the request began", () => {
	const drafts = new BookmarkDrafts();
	const submitted = drafts.write(bookmark, "submitted note");
	drafts.write(bookmark, "later edit");
	const saved = { ...bookmark, revision: 5, note: "submitted note" };
	assert.equal(drafts.acceptSaved(saved, submitted), false);
	assert.equal(drafts.read(saved).note, "later edit");
	assert.equal(drafts.read(saved).base.revision, 5);
	assert.equal(
		drafts.acceptSaved(
			{ ...saved, revision: 6, note: "later edit" },
			drafts.read(saved),
		),
		true,
	);
});

test("session drafts survive Reader replacement and remain isolated by material and version", () => {
	bookmarkDraftSession("material-1", "version-1").write(
		bookmark,
		"session draft",
	);
	assert.equal(
		bookmarkDraftSession("material-1", "version-1").read(bookmark).note,
		"session draft",
	);
	assert.equal(
		bookmarkDraftSession("material-2", "version-1").read(bookmark).note,
		"original note",
	);
	assert.equal(
		bookmarkDraftSession("material-1", "version-2").read(bookmark).note,
		"original note",
	);
});

test("note validation counts NFC Unicode code points and accepts an empty note", () => {
	assert.equal(bookmarkNoteTooLong(""), false);
	assert.equal(bookmarkNoteTooLong("𠮷".repeat(5000)), false);
	assert.equal(bookmarkNoteTooLong("か\u3099".repeat(5000)), false);
	assert.equal(bookmarkNoteTooLong("𠮷".repeat(5001)), true);
});
