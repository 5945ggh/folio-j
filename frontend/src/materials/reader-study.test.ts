import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter } from "./api.ts";
import type { Projection } from "./dom.ts";
import { ReaderStudy, type StudyMark } from "./reader-study.ts";

function harness() {
	const highlights = new Map<string, unknown>();
	const styles = new Map<
		string,
		{ id: string; textContent: string; remove: () => void }
	>();
	let selected: Selection | null = null,
		valid = true;
	const leaf = { closest: () => null };
	const node = {
		data: "甲乙丙丁",
		length: 4,
		parentElement: leaf,
	} as unknown as Text;
	class Highlight {
		priority = 0;
		constructor(...ranges: Range[]) {
			this.ranges = ranges;
		}
		ranges: Range[];
	}
	const makeRect = (start: number, end: number) => ({
		left: start * 10,
		right: end * 10,
		top: 0,
		bottom: 20,
		width: (end - start) * 10,
		height: 20,
	});
	const doc = Object.assign(new EventTarget(), {
		defaultView: { Highlight, CSS: { highlights } },
		getSelection: () => selected,
		createRange: () => {
			let start = 0,
				end = 0;
			return {
				setStart: (_node: Node, offset: number) => {
					start = offset;
				},
				setEnd: (_node: Node, offset: number) => {
					end = offset;
				},
				getClientRects: () => [makeRect(start, end)],
				getBoundingClientRect: () => makeRect(start, end),
			};
		},
		caretPositionFromPoint: (x: number) => ({
			offsetNode: node,
			offset: Math.floor(x / 10),
		}),
		getElementById: (id: string) => styles.get(id),
		createElement: () => ({
			id: "",
			textContent: "",
			remove() {
				styles.delete(this.id);
			},
		}),
		head: {
			append: (style: {
				id: string;
				textContent: string;
				remove: () => void;
			}) => styles.set(style.id, style),
		},
		body: { contains: () => true },
	});
	Object.assign(node, { ownerDocument: doc });
	const chapter = {
		material_id: "m",
		version_id: "v",
		id: "c",
		title: "章",
		parts: [
			{ resource_id: "r", spine_index: 1, start: 0, end: 4, leaf_start: 0 },
		],
		resources: [{ id: "r", text: "甲乙丙丁", text_sha256: "a".repeat(64) }],
	} as Chapter;
	const projection: Projection = {
		raw: "甲乙丙丁",
		entries: [{ node, start: 0, end: 4 }],
	};
	const element = {
		getBoundingClientRect: () => ({ left: 100, top: 200 }),
		clientLeft: 0,
		clientTop: 0,
	} as HTMLIFrameElement;
	const callbacks: { selection: unknown[]; marks: unknown[] } = {
		selection: [],
		marks: [],
	};
	const study = new ReaderStudy();
	const binding = {
		materialId: "m",
		versionId: "v",
		chapterId: "c",
		onSelection: (value: unknown) => callbacks.selection.push(value),
		onMarks: (value: unknown) => callbacks.marks.push(value),
	};
	study.bind(binding);
	const detach = study.mount({
		index: 0,
		doc: doc as unknown as Document,
		element,
		chapter,
		valid: () => valid,
		projection: () => projection,
	});
	const mark = (id: string, start: number, end: number): StudyMark => ({
		segment_id: id,
		material_provenance: {
			contract_version: "1",
			material_id: "m",
			version_id: "v",
			ranges: [
				{
					resource_id: "r",
					spine_index: 1,
					start,
					end,
					exact: Array.from("甲乙丙丁").slice(start, end).join(""),
					text_sha256: "a".repeat(64),
					prefix: "",
					suffix: "",
				},
			],
		},
	});
	const event = (type: string, values: Record<string, unknown> = {}) => {
		const e = new Event(type);
		Object.assign(e, {
			clientX: 15,
			clientY: 10,
			pointerId: 1,
			button: 0,
			isPrimary: true,
			detail: 1,
			...values,
		});
		if ("at" in values)
			Object.defineProperty(e, "timeStamp", { value: values.at });
		doc.dispatchEvent(e);
	};
	const selection = () => {
		selected = {
			isCollapsed: false,
			rangeCount: 1,
			focusNode: node,
			focusOffset: 2,
			getRangeAt: () => ({
				startContainer: node,
				startOffset: 0,
				endContainer: node,
				endOffset: 2,
			}),
			removeAllRanges: () => {
				selected = null;
			},
		} as unknown as Selection;
	};
	return {
		study,
		binding,
		detach,
		chapter,
		highlights,
		styles,
		callbacks,
		mark,
		event,
		selection,
		invalid: () => {
			valid = false;
		},
		node,
	};
}

test("study underlines and emphasis leave search highlights and locator text intact; disabled removes drawing and hit data", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.highlights.set("folio-search", {});
	h.study.setMarks(
		h.chapter,
		[h.mark("a", 0, 3), h.mark("b", 1, 4)],
		true,
		"white",
	);
	assert.ok(h.highlights.has("folio-study"));
	assert.match(
		h.styles.get("folio-study-style")?.textContent ?? "",
		/text-decoration/,
	);
	assert.match(
		h.styles.get("folio-study-style")?.textContent ?? "",
		/under left/,
	);
	h.study.emphasize("a");
	assert.ok(h.highlights.has("folio-study-active"));
	h.study.setMarks(h.chapter, [h.mark("a", 0, 3)], false, "black");
	assert.equal(h.highlights.has("folio-study"), false);
	assert.equal(h.highlights.has("folio-study-active"), true);
	h.study.emphasize(null);
	assert.equal(h.highlights.has("folio-study-active"), false);
	assert.equal(h.highlights.has("folio-search"), true);
	assert.equal(h.node.data, "甲乙丙丁");
	h.event("pointerdown");
	h.event("pointerup");
	h.event("click");
	t.mock.timers.tick(300);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
});

test("body clicks never open a study popup or clear active emphasis", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.study.setMarks(
		h.chapter,
		[h.mark("a", 0, 3), h.mark("b", 1, 4)],
		true,
		"white",
	);
	h.study.emphasize("a");
	h.event("pointerdown");
	h.event("pointerup");
	h.event("click");
	t.mock.timers.tick(300);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	assert.ok(h.highlights.has("folio-study-active"));
});

for (const mode of [
	"drag",
	"longpress",
	"selected",
	"doubleclick",
	"scroll",
	"oldframe",
] as const) {
	test(`${mode} does not open a mark popup`, (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = harness();
		h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
		if (mode === "selected") h.selection();
		h.event("pointerdown", { at: 100 });
		if (mode === "drag") h.event("pointermove", { clientX: 30 });
		h.event("pointerup", { at: mode === "longpress" ? 700 : 120 });
		h.event("click");
		if (mode === "doubleclick") {
			h.event("pointerdown");
			h.event("pointerup");
			h.event("click", { detail: 2 });
		}
		if (mode === "scroll") h.event("wheel");
		if (mode === "oldframe") h.invalid();
		t.mock.timers.tick(300);
		assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	});
}

test("selection notification waits for drag/keyboard completion, keeps native selection, and clear is explicit", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.event("pointerdown");
	h.selection();
	h.event("selectionchange");
	t.mock.timers.tick(100);
	assert.equal(h.callbacks.selection.filter(Boolean).length, 0);
	h.event("pointerup");
	t.mock.timers.tick(60);
	const value = h.callbacks.selection.filter(Boolean).at(-1) as {
		target: { reference: { ranges: { exact: string }[] } };
		anchor: unknown;
	};
	assert.equal(value.target.reference.ranges[0]?.exact, "甲乙");
	assert.deepEqual(value.anchor, {
		left: 100,
		right: 120,
		top: 200,
		bottom: 220,
	});
	h.study.clearSelection();
	assert.equal(h.callbacks.selection.at(-1), null);
	h.event("keydown", { key: "ArrowRight", shiftKey: true });
	h.selection();
	h.event("selectionchange");
	t.mock.timers.tick(100);
	assert.equal(h.callbacks.selection.at(-1), null);
	h.event("keyup", { key: "ArrowRight", shiftKey: true });
	t.mock.timers.tick(60);
	assert.ok(h.callbacks.selection.at(-1));
});

test("chapter/frame invalidation cancels queued selection and click notifications", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.event("pointerdown");
	h.selection();
	h.event("pointerup");
	h.study.bind({ ...h.binding, chapterId: "new" });
	t.mock.timers.tick(300);
	assert.equal(h.callbacks.selection.filter(Boolean).length, 0);
	h.detach();
	assert.equal(h.highlights.has("folio-study"), false);
});

test("old chapter keyboard and scroll events cannot clear the new chapter toolbar", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.study.bind({ ...h.binding, chapterId: "other" });
	const counts = [h.callbacks.selection.length, h.callbacks.marks.length];
	h.event("keydown", { key: "ArrowRight", shiftKey: true });
	h.event("wheel");
	h.event("keyup", { key: "ArrowRight", shiftKey: true });
	t.mock.timers.tick(300);
	assert.deepEqual(
		[h.callbacks.selection.length, h.callbacks.marks.length],
		counts,
	);
});

test("a multi-part mark stays wholly absent while another required frame is unavailable", () => {
	const h = harness();
	const part = h.chapter.parts[0];
	assert.ok(part);
	h.chapter.parts.push({ ...part, spine_index: 2 });
	const mark = h.mark("multiple", 2, 4);
	const range = mark.material_provenance.ranges[0];
	assert.ok(range);
	mark.material_provenance.ranges.push({
		...range,
		spine_index: 2,
		start: 0,
		end: 2,
		exact: "甲乙",
	});
	h.study.setMarks(h.chapter, [mark], true, "white");
	assert.equal(h.highlights.has("folio-study"), false);
});

test("caret points in line-end whitespace and rt never resolve guessed mark records", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	h.event("pointerdown", { clientX: 80 });
	h.event("pointerup", { clientX: 80 });
	h.event("click", { clientX: 80 });
	t.mock.timers.tick(300);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	assert.ok(h.node.parentElement);
	Object.assign(h.node.parentElement, { closest: () => ({ tagName: "RT" }) });
	h.event("pointerdown");
	h.event("pointerup");
	h.event("click");
	t.mock.timers.tick(300);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
});

test("rerendered bindings deliver completed selection only to the latest callback", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.event("pointerdown");
	h.selection();
	h.event("pointerup");
	const latest: unknown[] = [];
	h.study.bind({ ...h.binding, onSelection: (value) => latest.push(value) });
	t.mock.timers.tick(60);
	assert.equal(h.callbacks.selection.filter(Boolean).length, 0);
	assert.equal(latest.filter(Boolean).length, 1);
});

test("same chapter id in a different material/version never paints stale records", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("old", 0, 4)], true, "white");
	assert.ok(h.highlights.has("folio-study"));
	h.study.bind({ ...h.binding, versionId: "replacement" });
	h.study.refresh();
	assert.equal(h.highlights.has("folio-study"), false);
	h.study.bind(null);
	h.study.refresh();
	assert.equal(h.highlights.has("folio-study"), false);
});

test("scrolling and layout invalidate temporary emphasis; native body interaction preserves it", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	h.study.emphasize("a");
	assert.ok(h.highlights.has("folio-study-active"));
	h.event("wheel");
	assert.equal(h.highlights.has("folio-study-active"), false);
	h.study.emphasize("a");
	h.event("pointerdown");
	assert.equal(h.highlights.has("folio-study-active"), true);
	h.study.emphasize("a");
	h.study.geometryChanged();
	assert.equal(h.highlights.has("folio-study-active"), false);
});

test("chapter candidates can emphasize exact ranges while persistent underlines are hidden", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 3)], false, "white");
	h.study.emphasize("a");
	assert.equal(h.highlights.has("folio-study"), false);
	assert.ok(h.highlights.has("folio-study-active"));
});

test("layout invalidation removes old entry geometry and emphasis before a no-scroll refresh", () => {
	const h = harness();
	const entries: unknown[] = [];
	h.study.bind({ ...h.binding, onEntries: (value) => entries.push(value) });
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	h.study.emphasize("a");
	h.study.geometryChanged(false);
	assert.deepEqual(entries.at(-1), []);
	assert.equal(h.highlights.has("folio-study-active"), false);
	assert.equal(h.highlights.has("folio-study"), false);
	h.study.refresh();
	assert.equal(h.highlights.has("folio-study"), true);
	assert.equal(h.highlights.has("folio-study-active"), false);
});
