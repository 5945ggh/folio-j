import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter, Position, Settings } from "./api.ts";
import {
	adjacentChapters,
	ChapterSwitch,
	chapterDestination,
} from "./chapter-navigation.ts";

const settings: Settings = {
	font_size: 26,
	line_height: 2.2,
	writing_mode: "vertical-rl",
};
const chapter: Chapter = {
	id: "chapter",
	material_id: "book",
	version_id: "version",
	title: "Chapter",
	level: 1,
	parts: [
		{
			resource_id: "resource",
			spine_index: 8,
			start: 30,
			end: 60,
			leaf_start: 2,
			leaf_end: 3,
			html: '<img data-epub-image="7"><p>本文</p>',
		},
	],
	resources: [],
};
const saved: Position = {
	version_id: "version",
	chapter_id: "chapter",
	part_index: 2,
	resource_id: "remembered-resource",
	kind: "text",
	offset: 123,
	at_chapter_end: false,
	settings: { font_size: 18, line_height: 1.5, writing_mode: "horizontal-tb" },
};

test("adjacent chapters follow array order even when spine indices repeat or differ", () => {
	const chapters = [
		{ id: "first", spine_index: 12 },
		{ id: "middle", spine_index: 1 },
		{ id: "last", spine_index: 1 },
	] as const;
	assert.deepEqual(adjacentChapters(chapters, "middle"), {
		previous: chapters[0],
		next: chapters[2],
	});
	assert.deepEqual(adjacentChapters(chapters, "first"), {
		previous: null,
		next: chapters[1],
	});
	assert.deepEqual(adjacentChapters(chapters, "last"), {
		previous: chapters[1],
		next: null,
	});
});

test("unknown, empty and single-chapter books have no wrapping neighbours", () => {
	assert.deepEqual(adjacentChapters([{ id: "only" }], "unknown"), {
		previous: null,
		next: null,
	});
	assert.deepEqual(adjacentChapters([], "unknown"), {
		previous: null,
		next: null,
	});
	assert.deepEqual(adjacentChapters([{ id: "only" }], "only"), {
		previous: null,
		next: null,
	});
});

test("remembered text and image anchors retain their location and chapter-end flag", () => {
	for (const anchor of [
		saved,
		{ ...saved, at_chapter_end: true },
		{
			...saved,
			kind: "image" as const,
			offset: undefined,
			image_id: 9,
			image_progress: 0.7,
			at_chapter_end: true,
		},
	]) {
		const original = structuredClone(anchor);
		assert.deepEqual(chapterDestination(chapter, anchor, "version", settings), {
			target: { ...anchor, settings },
			beginning: false,
		});
		assert.deepEqual(anchor, original);
	}
});

test("a remembered anchor without settings also adopts the current presentation", () => {
	const { settings: _oldSettings, ...anchor } = saved;
	assert.deepEqual(
		chapterDestination(chapter, anchor, "version", settings).target.settings,
		settings,
	);
});

test("an explicit beginning replaces saved text or image anchors with the first part", () => {
	for (const anchor of [
		saved,
		{ ...saved, kind: "image" as const, image_id: 9, image_progress: 0.7 },
	]) {
		assert.deepEqual(
			chapterDestination(chapter, anchor, "current-version", settings, true),
			{
				target: {
					version_id: "current-version",
					chapter_id: "chapter",
					part_index: 0,
					resource_id: "resource",
					kind: "text",
					offset: 30,
					at_chapter_end: false,
					settings,
				},
				beginning: true,
			},
		);
	}
});

test("a new mixed chapter uses its text anchor and requests physical beginning restoration", () => {
	const destination = chapterDestination(
		chapter,
		undefined,
		"version",
		settings,
	);
	assert.equal(destination.beginning, true);
	assert.equal(destination.target.kind, "text");
	assert.equal(destination.target.offset, 30);
	assert.equal(destination.target.at_chapter_end, false);
});

test("a new image-only chapter starts at its first image", () => {
	const part = chapter.parts[0];
	assert.ok(part);
	const imageChapter: Chapter = {
		...chapter,
		parts: [{ ...part, start: 30, end: 30 }],
	};
	assert.deepEqual(
		chapterDestination(imageChapter, undefined, "version", settings),
		{
			target: {
				version_id: "version",
				chapter_id: "chapter",
				part_index: 0,
				resource_id: "resource",
				kind: "image",
				image_id: 7,
				image_progress: 0,
				at_chapter_end: false,
				settings,
			},
			beginning: true,
		},
	);
});

test("an empty chapter rejects navigation even with a remembered anchor", () => {
	for (const anchor of [undefined, saved]) {
		assert.throws(
			() =>
				chapterDestination(
					{ ...chapter, parts: [] },
					anchor,
					"version",
					settings,
				),
			/章节没有可阅读内容/,
		);
	}
});

test("a chapter switch locks repeated requests through fetching and presentation", () => {
	const switching = new ChapterSwitch();
	assert.equal(switching.busy, false);
	assert.equal(switching.begin(1), true);
	assert.equal(switching.busy, true);
	assert.equal(switching.begin(2), false);
	// Initial resource completion and old-chapter reflow cannot unlock fetching.
	assert.equal(switching.finish(0), false);
	assert.equal(switching.finish(1), false);
	assert.equal(switching.busy, true);
	switching.accept(1, 4);
	assert.equal(switching.busy, true);
	assert.equal(switching.begin(2), false);
	assert.equal(switching.finish(4), true);
	assert.equal(switching.busy, false);
	assert.equal(switching.finish(4), false);
});

test("stale tickets and old surface generations cannot finish an active switch", () => {
	const switching = new ChapterSwitch();
	switching.begin(2);
	switching.accept(1, 3);
	assert.equal(switching.finish(3), false);
	switching.accept(2, 4);
	switching.accept(1, 5);
	assert.equal(switching.finish(3), false);
	assert.equal(switching.finish(5), false);
	assert.equal(switching.busy, true);
	assert.equal(switching.finish(4), true);
});

test("conditional cancellation preserves a newer request and cancellation permits retry", () => {
	const switching = new ChapterSwitch();
	assert.equal(switching.cancel(), false);
	switching.begin(1);
	switching.accept(1, 3);
	assert.equal(switching.cancel(1), true);
	assert.equal(switching.busy, false);
	assert.equal(switching.finish(3), false);
	assert.equal(switching.begin(2), true);
	assert.equal(switching.cancel(1), false);
	switching.accept(1, 3);
	assert.equal(switching.finish(3), false);
	assert.equal(switching.busy, true);
	switching.accept(2, 4);
	assert.equal(switching.finish(3), false);
	assert.equal(switching.finish(4), true);
});

test("unconditional cancellation clears fetching or accepted requests", () => {
	const switching = new ChapterSwitch();
	switching.begin(1);
	assert.equal(switching.cancel(), true);
	assert.equal(switching.busy, false);
	switching.accept(1, 3);
	assert.equal(switching.finish(3), false);
	switching.begin(2);
	switching.accept(2, 4);
	assert.equal(switching.cancel(), true);
	assert.equal(switching.finish(4), false);
	assert.equal(switching.busy, false);
});
