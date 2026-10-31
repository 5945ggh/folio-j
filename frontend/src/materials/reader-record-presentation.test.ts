import assert from "node:assert/strict";
import test from "node:test";
import type { TranslationResult } from "../translation/api.ts";
import type { Chapter } from "./api.ts";
import type { ChapterTranslation } from "./chapter-translations-query.ts";
import { closeReaderPanel } from "./reader-panel-logic.ts";
import {
	type ReaderRecordContext,
	ReaderRecordPresentation,
} from "./reader-record-presentation.ts";
import type { StudyMarkHit, StudySelection } from "./reader-study.ts";
import type { ChapterSegment, MaterialProvenance } from "./study-api.ts";

const anchor = { left: 20, right: 80, top: 40, bottom: 60 };
const createdAt = "2026-10-31T00:00:00Z";

function reference(start: number): MaterialProvenance {
	return {
		contract_version: "1",
		material_id: "book",
		version_id: "version",
		ranges: [
			{
				resource_id: "resource",
				spine_index: 0,
				start,
				end: start + 3,
				exact: "日本語",
				text_sha256: "hash",
				prefix: "",
				suffix: "",
			},
		],
	};
}

function translation(id: string, start: number): ChapterTranslation {
	return {
		identity_sha256: id,
		result_id: `result-${id}`,
		material_provenance: reference(start),
		excerpt: "日本語",
		translation_excerpt: `译文${id}`,
		target_language: "中文",
		result_count: 1,
		created_at: createdAt,
	};
}

function segment(id: string, start: number): ChapterSegment {
	return {
		segment_id: id,
		material_provenance: reference(start),
		excerpt: "日本語",
		created_at: createdAt,
	};
}

function hit(
	id: string,
	kind: "segment" | "translation" = "segment",
	changes: Partial<StudyMarkHit> = {},
): StudyMarkHit {
	return {
		segmentIds: kind === "segment" ? [id] : [],
		translationIds: kind === "translation" ? [id] : [],
		anchor,
		...changes,
	};
}

function result(item: ChapterTranslation): TranslationResult {
	return {
		id: item.result_id,
		identity_sha256: item.identity_sha256,
		material_id: "book",
		material_provenance: item.material_provenance,
		chapter_id: "chapter",
		source_id: "source",
		task_id: "task",
		run_id: "run",
		text: item.excerpt,
		translation: item.translation_excerpt,
		context_before: "",
		context_after: "",
		target_language: item.target_language,
		parts: [],
		adopted_segment_ids: [],
		material_deleted: false,
		reader_deleted: false,
		created_at: createdAt,
		model_id: "model",
		provider_name: "offline",
		protocol: "responses",
		prompt_version: "test",
		scheme_id: "scheme",
		scheme_name: "scheme",
		scheme_revision: 0,
		max_output_tokens: null,
		reasoning_effort: null,
		temperature: null,
	};
}

function harness() {
	const chapter: Chapter = {
		id: "chapter",
		material_id: "book",
		version_id: "version",
		title: "章",
		level: 0,
		parts: [],
		resources: [],
	};
	const first = translation("first", 10);
	const second = translation("second", 20);
	const context: ReaderRecordContext = {
		active: true,
		alive: true,
		materialId: chapter.material_id,
		versionId: chapter.version_id,
		chapterId: chapter.id,
		chapter,
		direction: "horizontal-tb",
		panels: { left: null, right: null, activeSide: null },
		compactPanels: false,
		studyTargetActive: false,
		segments: [segment("segment", 0)],
		translations: [first, second],
		settled: true,
	};
	let nativeSelection = false;
	let emphasis: { id: string; kind: "segment" | "translation" } | null = null;
	let inlineText: string | null = null;
	let inlineAvailable = true;
	let translationVisible = true;
	let owner: ReaderRecordPresentation;
	owner = new ReaderRecordPresentation({
		current: () => context,
		frames: {
			clearStudySelection: () => {
				const hadSelection = nativeSelection;
				nativeSelection = false;
				// ReaderStudy calls this before clearStudySelection returns.
				owner.selectionChanged(null);
				return hadSelection;
			},
			emphasizeStudyMark: (id, kind = "segment") => {
				emphasis = id === null ? null : { id, kind };
			},
			setInlineTranslation: (_chapter, value, mutate) => {
				if (value && !inlineAvailable) return false;
				mutate(() => {
					inlineText = value?.text ?? null;
				});
				return true;
			},
		},
		closeStudyPanel: () => {
			if (context.panels.right === "study")
				context.panels = closeReaderPanel(context.panels, "right");
		},
		hideTranslation: () => {
			translationVisible = false;
		},
		showTools: () => {},
		changed: () => {},
	});
	owner.reconcile();
	return {
		owner,
		context,
		first,
		second,
		get nativeSelection() {
			return nativeSelection;
		},
		get emphasis() {
			return emphasis;
		},
		get inlineText() {
			return inlineText;
		},
		get translationVisible() {
			return translationVisible;
		},
		setInlineAvailable(value: boolean) {
			inlineAvailable = value;
		},
		select() {
			nativeSelection = true;
			const selection: StudySelection = {
				target: { chapter, reference: reference(30) },
				anchor,
			};
			owner.selectionChanged(selection);
			return selection;
		},
	};
}

const mutate = (update: () => void) => update();

test("new selection dismisses a temporary preview; hiding its toolbar preserves the native selection", () => {
	const h = harness();
	h.owner.openPreview(hit("segment"));
	const selection = h.select();
	assert.equal(h.owner.state.markHit, null);
	assert.equal(h.owner.state.selection, selection);
	assert.equal(h.nativeSelection, true);

	assert.equal(h.owner.escape(), true);
	assert.equal(h.owner.state.selection, null);
	assert.equal(h.nativeSelection, true);
	assert.equal(h.owner.dismissBackground(), true);
	assert.equal(h.nativeSelection, false);
	assert.equal(h.owner.dismissBackground(), false);
});

test("selection and background dismissal retain fixed, manually parked, expanded and inline reading", () => {
	for (const mode of ["fixed", "manual", "expanded", "inline"] as const) {
		const h = harness();
		if (mode === "inline") h.owner.openTextMark(hit("first", "translation"));
		else {
			h.owner.openPreview(
				hit("segment", "segment", { fixed: mode === "fixed" }),
			);
			if (mode === "manual") h.owner.setManualPosition({ left: 90, top: 120 });
			if (mode === "expanded")
				h.context.panels = { left: null, right: "study", activeSide: "right" };
			h.owner.emphasizePreview(h.owner.state.previewSerial, "segment");
		}
		const reading = h.owner.state.markHit ?? h.owner.state.inlineRequest;
		const emphasis = h.emphasis;
		h.select();
		h.owner.markChanged(null);
		assert.equal(
			h.owner.state.markHit ?? h.owner.state.inlineRequest,
			reading,
			mode,
		);
		assert.deepEqual(h.emphasis, emphasis, mode);
		assert.equal(h.nativeSelection, true, mode);
		assert.equal(h.owner.dismissBackground(), true, mode);
		assert.equal(h.nativeSelection, false, mode);
		assert.equal(
			h.owner.state.markHit ?? h.owner.state.inlineRequest,
			reading,
			mode,
		);
		assert.equal(h.owner.state.selection, null, mode);
	}
});

test("opening a new preview or inline translation survives synchronous selection clearing", () => {
	const h = harness();
	h.select();
	const next = hit("segment");
	h.owner.openPreview(next);
	assert.equal(h.owner.state.markHit, next);
	assert.equal(h.owner.state.selection, null);
	assert.equal(h.nativeSelection, false);
	assert.equal(h.translationVisible, false);

	h.select();
	h.owner.openTextMark(hit("first", "translation"));
	assert.equal(h.owner.state.markHit, null);
	assert.equal(h.owner.state.inlineRequest?.item.identity_sha256, "first");
	assert.equal(h.owner.state.selection, null);
	assert.equal(h.nativeSelection, false);
	assert.deepEqual(h.emphasis, { id: "first", kind: "translation" });
});

test("cleanup from an old preview cannot remove a new preview or inline target emphasis", () => {
	const h = harness();
	h.owner.openPreview(hit("segment"));
	const oldPreview = h.owner.state.previewSerial;
	h.owner.emphasizePreview(oldPreview, "segment");
	h.owner.openPreview(hit("first", "translation"));
	const newPreview = h.owner.state.previewSerial;
	h.owner.emphasizePreview(newPreview, "first", "translation");
	h.owner.emphasizePreview(oldPreview, null);
	h.owner.emphasizePreview(oldPreview, "segment");
	assert.deepEqual(h.emphasis, { id: "first", kind: "translation" });

	h.owner.openTextMark(hit("second", "translation"));
	h.owner.emphasizePreview(newPreview, null, "translation");
	assert.deepEqual(h.emphasis, { id: "second", kind: "translation" });
	h.owner.closeInline();
	assert.equal(h.emphasis, null);
});

test("repeated inline hits toggle, while margin, vertical, mixed and manually parked targets use records", () => {
	const h = harness();
	h.owner.openTextMark(hit("first", "translation"));
	h.owner.openTextMark(hit("second", "translation"));
	assert.equal(h.owner.state.inlineRequest?.item.identity_sha256, "second");
	h.owner.openTextMark(hit("second", "translation"));
	assert.equal(h.owner.state.inlineRequest, null);
	assert.equal(h.emphasis, null);

	for (const mode of ["margin", "vertical", "mixed", "manual"] as const) {
		const c = harness();
		const target = hit("first", "translation");
		if (mode === "margin") target.anchorPlacement = "margin-right";
		if (mode === "vertical") c.context.direction = "vertical-rl";
		if (mode === "mixed") c.context.segments = [segment("overlap", 11)];
		if (mode === "manual") {
			c.owner.openPreview(hit("segment"));
			c.owner.setManualPosition({ left: 100, top: 100 });
		}
		c.owner.openTextMark(target);
		assert.equal(c.owner.state.markHit, target, mode);
		assert.equal(c.owner.state.inlineRequest, null, mode);
	}
});

test("study reading survives navigation panels, and Escape respects the covered compact panel", () => {
	const h = harness();
	const preview = hit("segment");
	h.owner.openPreview(preview);
	h.owner.setManualPosition({ left: 90, top: 120 });
	h.context.panels = { left: null, right: "study", activeSide: "right" };
	for (const panel of ["toc", "bookmarks", "search"] as const) {
		h.owner.panelSelected(panel);
		assert.equal(h.owner.state.markHit, preview);
		assert.deepEqual(h.owner.state.manualPosition, { left: 90, top: 120 });
	}
	h.context.panels = { left: "toc", right: "study", activeSide: "left" };
	h.context.compactPanels = true;
	assert.equal(h.owner.escape(), false);
	h.owner.panelClosed("left");
	assert.equal(h.owner.state.markHit, preview);
	h.context.panels = closeReaderPanel(h.context.panels, "left");
	assert.equal(h.owner.escape(), true);
	assert.equal(h.owner.state.markHit, null);
	assert.equal(h.owner.state.manualPosition, null);
	assert.equal(h.context.panels.right, null);

	h.owner.openPreview(hit("segment"));
	h.owner.panelSelected("settings");
	assert.equal(h.owner.state.markHit, null);
});

test("active study drafts and inactive readers reject new native presentation notifications", () => {
	const h = harness();
	h.context.studyTargetActive = true;
	h.owner.markChanged(hit("first", "translation"));
	assert.equal(h.owner.state.markHit, null);
	assert.equal(h.owner.state.inlineRequest, null);
	h.context.studyTargetActive = false;
	const preview = hit("segment");
	h.owner.openPreview(preview);
	for (const disabled of ["active", "alive"] as const) {
		h.context[disabled] = false;
		h.owner.markChanged(hit("first", "translation"));
		h.select();
		assert.equal(h.owner.state.markHit, preview, disabled);
		assert.equal(h.owner.state.selection, null, disabled);
		h.context[disabled] = true;
	}
});

test("refreshing an empty page retains a preview until settled; fixed lists stay available when empty", () => {
	const h = harness();
	const preview = hit("segment");
	h.owner.openPreview(preview);
	h.context.settled = false;
	h.context.segments = [];
	h.context.translations = [];
	h.owner.reconcile();
	assert.equal(h.owner.state.markHit, preview);
	h.context.settled = true;
	h.owner.reconcile();
	assert.equal(h.owner.state.markHit, null);
	const fixed = hit("", "segment", { fixed: true, segmentIds: [] });
	h.owner.openPreview(fixed);
	h.owner.reconcile();
	assert.equal(h.owner.state.markHit, fixed);
	assert.deepEqual(h.owner.hitRecords, { segments: [], translations: [] });
});

test("late A results, loading and failures cannot replace B or resurrect a dismissed target", () => {
	const h = harness();
	h.owner.openTextMark(hit("first", "translation"));
	const firstRequest = h.owner.state.inlineRequest;
	assert.ok(firstRequest);
	h.owner.openTextMark(hit("second", "translation"));
	const secondRequest = h.owner.state.inlineRequest;
	assert.ok(secondRequest);
	h.owner.presentInline(secondRequest, result(h.second), false, mutate);
	assert.equal(h.inlineText, h.second.translation_excerpt);
	for (const [value, failed] of [
		[result(h.first), false],
		[undefined, false],
		[undefined, true],
	] as const) {
		h.owner.presentInline(firstRequest, value, failed, mutate);
		assert.equal(h.inlineText, h.second.translation_excerpt);
		assert.equal(h.owner.state.inlineRequest, secondRequest);
		assert.equal(h.owner.state.markHit, null);
	}
	h.owner.openTextMark(hit("first", "translation"));
	const reopened = h.owner.state.inlineRequest;
	assert.ok(reopened);
	h.owner.presentInline(reopened, result(h.first), false, mutate);
	h.owner.presentInline(firstRequest, undefined, true, mutate);
	assert.equal(h.owner.state.inlineRequest, reopened);
	assert.equal(h.inlineText, h.first.translation_excerpt);
	h.owner.closePreview();
	h.owner.presentInline(null, undefined, false, mutate);
	h.owner.presentInline(reopened, result(h.first), false, mutate);
	assert.equal(h.owner.state.inlineRequest, null);
	assert.equal(h.owner.state.markHit, null);
	assert.equal(h.inlineText, null);
});

test("deleting another translation preserves the current target and segment emphasis namespace", () => {
	const h = harness();
	h.owner.openTextMark(hit("second", "translation"));
	const request = h.owner.state.inlineRequest;
	assert.ok(request);
	h.owner.translationRemoved("first");
	assert.equal(h.owner.state.inlineRequest, request);
	assert.deepEqual(h.emphasis, { id: "second", kind: "translation" });
	h.owner.translationRemoved("second");
	h.owner.presentInline(request, result(h.second), false, mutate);
	assert.equal(h.owner.state.inlineRequest, null);
	assert.equal(h.owner.state.markHit, null);
	assert.equal(h.emphasis, null);

	h.owner.openPreview(hit("segment"));
	h.owner.emphasizePreview(h.owner.state.previewSerial, "second", "segment");
	h.owner.translationRemoved("second");
	assert.deepEqual(h.emphasis, { id: "second", kind: "segment" });
});

test("inline failures return to a record, while chapter changes and inactivity fence old results", () => {
	const h = harness();
	h.owner.openTextMark(hit("first", "translation"));
	const failedRequest = h.owner.state.inlineRequest;
	assert.ok(failedRequest);
	h.setInlineAvailable(false);
	h.owner.presentInline(failedRequest, result(h.first), false, mutate);
	assert.equal(h.owner.state.markHit, failedRequest.hit);
	assert.equal(h.owner.state.inlineRequest, null);

	h.owner.openTextMark(hit("second", "translation"));
	const oldRequest = h.owner.state.inlineRequest;
	assert.ok(oldRequest);
	h.setInlineAvailable(true);
	h.context.active = false;
	h.owner.presentInline(oldRequest, result(h.second), false, mutate);
	assert.equal(h.inlineText, null);
	assert.equal(h.owner.state.inlineRequest, oldRequest);
	h.context.active = true;
	h.context.chapterId = "next-chapter";
	h.context.chapter = {
		id: "next-chapter",
		material_id: "book",
		version_id: "version",
		title: "次章",
		level: 0,
		parts: [],
		resources: [],
	};
	h.owner.reconcile();
	h.owner.openPreview(hit("next-segment"));
	h.owner.emphasizePreview(h.owner.state.previewSerial, "next-segment");
	h.owner.presentInline(oldRequest, result(h.second), false, mutate);
	assert.deepEqual(h.owner.state.markHit?.segmentIds, ["next-segment"]);
	assert.deepEqual(h.emphasis, { id: "next-segment", kind: "segment" });
	assert.equal(h.inlineText, null);
});
