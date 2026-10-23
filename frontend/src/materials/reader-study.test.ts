import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter } from "./api.ts";
import type { Projection } from "./dom.ts";
import { snapshotReaderFrameTargets } from "./focus.ts";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import { applyFramePresentation } from "./presentation.ts";
import { ReaderStudy, type StudyMark } from "./reader-study.ts";

function harness(
	beforeMount?: (doc: Document, leaf: Element) => void,
	viewport?: HTMLElement,
) {
	const highlights = new Map<string, unknown>();
	const styles = new Map<
		string,
		{ id: string; textContent: string; remove: () => void }
	>();
	let selected: Selection | null = null,
		valid = true;
	const leaf = {
		nodeType: 1,
		closest: (_selector: string): object | null => null,
	};
	const node = {
		nodeType: 3,
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
	let rects = (start: number, end: number) => [makeRect(start, end)];
	const doc = Object.assign(new EventTarget(), {
		querySelectorAll: (_selector: string) => [leaf],
		documentElement: { dataset: {} },
		defaultView: { Highlight, CSS: { highlights } },
		getSelection: () => selected,
		createRange: () => {
			let start = 0,
				end = 0;
			return {
				get startContainer() {
					return node;
				},
				get endContainer() {
					return node;
				},
				get startOffset() {
					return start;
				},
				get endOffset() {
					return end;
				},
				setStart: (_node: Node, offset: number) => {
					start = offset;
				},
				setEnd: (_node: Node, offset: number) => {
					end = offset;
				},
				getClientRects: () => rects(start, end),
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
	snapshotReaderFrameTargets(doc as unknown as Document);
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
		clientWidth: 300,
		clientHeight: 300,
	} as HTMLIFrameElement;
	const callbacks: { selection: unknown[]; marks: unknown[] } = {
		selection: [],
		marks: [],
	};
	beforeMount?.(doc as unknown as Document, leaf as unknown as Element);
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
		viewport,
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
		const e = new Event(type, { cancelable: true });
		const { target, ...props } = values;
		if (target) Object.defineProperty(e, "target", { value: target });
		Object.assign(e, {
			clientX: 15,
			clientY: 10,
			pointerId: 1,
			button: 0,
			isPrimary: true,
			detail: 1,
			...props,
		});
		if ("at" in values)
			Object.defineProperty(e, "timeStamp", { value: values.at });
		doc.dispatchEvent(e);
		return e;
	};
	const selection = () => {
		selected = {
			isCollapsed: false,
			rangeCount: 1,
			focusNode: node,
			focusOffset: 2,
			containsNode: () => true,
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
		doc,
		element,
		leaf,
		setRects: (value: typeof rects) => {
			rects = value;
		},
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

test("ordinary taps return exactly overlapping marked characters and their complete visible anchor", (t) => {
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
	assert.deepEqual(h.callbacks.marks.filter(Boolean), [
		{
			segmentIds: ["a", "b"],
			anchor: { left: 100, right: 140, top: 200, bottom: 220 },
		},
	]);
	assert.ok(h.highlights.has("folio-study-active"));
	h.event("pointerdown", { clientX: 5 });
	h.event("pointerup", { clientX: 5 });
	assert.deepEqual(
		(h.callbacks.marks.at(-1) as { segmentIds: string[] }).segmentIds,
		["a"],
	);
});

for (const mode of [
	"drag",
	"longpress",
	"selected",
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
		if (mode === "scroll") h.event("wheel");
		if (mode === "oldframe") h.invalid();
		h.event("pointerup", { at: mode === "longpress" ? 700 : 120 });
		h.event("click");
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

test("a consumed ordinary tap leaves pointerdown native and only consumes pointerup", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 3)], true, "white");
	assert.equal(h.event("pointerdown").defaultPrevented, false);
	assert.equal(h.event("pointerup").defaultPrevented, true);
	assert.equal(h.event("click").defaultPrevented, false);
	assert.equal(h.event("dblclick").defaultPrevented, false);
});

test("ordinary background taps let the latest page callback decide whether to consume", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 1)], true, "white");
	let dismissals = 0;
	h.study.bind({
		...h.binding,
		onBackgroundTap: () => {
			dismissals++;
			return true;
		},
	});
	h.event("pointerdown");
	assert.equal(h.event("pointerup").defaultPrevented, true);
	assert.equal(dismissals, 1);
	h.study.bind({ ...h.binding, onBackgroundTap: () => false });
	h.event("pointerdown");
	assert.equal(h.event("pointerup").defaultPrevented, false);
	h.event("pointerdown", { clientX: 5 });
	h.event("pointerup", { clientX: 5 });
	assert.equal(dismissals, 1);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 1);
});

test("hidden underlines have no hit data except the visibly emphasized segment", () => {
	const h = harness();
	h.study.setMarks(
		h.chapter,
		[h.mark("a", 0, 3), h.mark("b", 1, 4)],
		false,
		"white",
	);
	h.event("pointerdown");
	h.event("pointerup");
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	h.study.emphasize("a");
	h.event("pointerdown");
	h.event("pointerup");
	assert.deepEqual(
		(h.callbacks.marks.at(-1) as { segmentIds: string[] }).segmentIds,
		["a"],
	);
	h.study.geometryChanged(false);
	h.event("pointerdown");
	h.event("pointerup");
	assert.equal(h.callbacks.marks.filter(Boolean).length, 1);
});

for (const vertical of [false, true]) {
	test(`${vertical ? "vertical" : "multiline"} character rects reject gaps and adjacent range bounding-box false positives`, () => {
		const h = harness();
		h.doc.caretPositionFromPoint = (x: number) => ({
			offsetNode: h.node,
			offset: Math.floor(x / 10),
		});
		const characterRect = (offset: number) => {
			const column = offset >= 2 ? 0 : 40;
			const position = (offset % 2) * 10;
			const left = vertical ? column : position,
				top = vertical ? position : column;
			return {
				left,
				right: left + 10,
				top,
				bottom: top + 10,
				width: 10,
				height: 10,
			};
		};
		h.setRects((start, end) =>
			Array.from({ length: end - start }, (_, i) => characterRect(start + i)),
		);
		h.study.setMarks(
			h.chapter,
			[h.mark("a", 0, 3), h.mark("b", 3, 4)],
			true,
			"white",
		);
		const tap = (x: number, y: number, offset: number) => {
			h.doc.caretPositionFromPoint = () => ({ offsetNode: h.node, offset });
			h.event("pointerdown", { clientX: x, clientY: y });
			h.event("pointerup", { clientX: x, clientY: y });
		};
		// The second glyph in the next line/column is inside a's enclosing box, but belongs only to b.
		tap(vertical ? 5 : 15, vertical ? 15 : 5, 3);
		assert.deepEqual(
			(h.callbacks.marks.at(-1) as { segmentIds: string[] }).segmentIds,
			["b"],
		);
		const count = h.callbacks.marks.filter(Boolean).length;
		tap(vertical ? 25 : 5, vertical ? 5 : 25, 2);
		tap(vertical ? 45 : 20, vertical ? 20 : 45, 2);
		assert.equal(h.callbacks.marks.filter(Boolean).length, count);
		// Half-open rectangles assign a shared boundary to the glyph actually under the pointer.
		tap(vertical ? 5 : 10, vertical ? 10 : 5, 3);
		assert.deepEqual(
			(h.callbacks.marks.at(-1) as { segmentIds: string[] }).segmentIds,
			["b"],
		);
	});
}

for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
	for (const phase of ["down", "up"]) {
		test(`${modifier} on pointer${phase} preserves native behavior`, () => {
			const h = harness();
			h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
			h.event("pointerdown", phase === "down" ? { [modifier]: true } : {});
			assert.equal(
				h.event("pointerup", phase === "up" ? { [modifier]: true } : {})
					.defaultPrevented,
				false,
			);
			assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
		});
	}
}

for (const mode of [
	"cancel",
	"mismatch",
	"selection",
	"fold-selection",
	"invalidated",
	"drag-back",
	"selection-during-tap",
] as const) {
	test(`${mode} cannot accidentally open or consume a marked tap`, () => {
		const h = harness();
		h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
		if (mode === "fold-selection") h.selection();
		h.event("pointerdown");
		if (mode === "cancel") h.event("pointercancel");
		if (mode === "selection" || mode === "selection-during-tap") h.selection();
		if (mode === "selection-during-tap") {
			h.event("selectionchange");
			h.study.clearSelection();
		}
		if (mode === "fold-selection") h.study.clearSelection();
		if (mode === "invalidated") h.study.geometryChanged(false);
		if (mode === "drag-back") h.event("pointermove", { clientX: 30 });
		assert.equal(
			h.event("pointerup", mode === "mismatch" ? { pointerId: 2 } : {})
				.defaultPrevented,
			false,
		);
		assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	});
}

test("controls, ruby annotations, and extension injection keep pointer events native", () => {
	for (const selector of ["button", "rt", "rp"]) {
		const h = harness();
		h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
		h.leaf.closest = (query) =>
			query.split(",").includes(selector) ? {} : null;
		h.event("pointerdown", { target: h.leaf });
		assert.equal(
			h.event("pointerup", { target: h.leaf }).defaultPrevented,
			false,
		);
		assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	}
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	const injected = { nodeType: 1, closest: () => null };
	h.event("pointerdown", { target: injected });
	assert.equal(
		h.event("pointerup", { target: injected }).defaultPrevented,
		false,
	);
	h.event("pointerdown");
	assert.equal(
		h.event("pointerup", { target: injected }).defaultPrevented,
		false,
	);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
	// Ruby base glyphs still resolve through their existing locator text node.
	h.leaf.closest = (selector) => (selector === "ruby" ? {} : null);
	h.event("pointerdown", { target: h.leaf });
	h.event("pointerup", { target: h.leaf });
	assert.equal(h.callbacks.marks.filter(Boolean).length, 1);
});

test("caret fallback checks actual geometry and never trusts an injected text node", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 3)], true, "white");
	Object.assign(h.doc, {
		caretPositionFromPoint: undefined,
		caretRangeFromPoint: () => ({ startContainer: h.node, startOffset: 2 }),
	});
	h.event("pointerdown");
	h.event("pointerup");
	assert.deepEqual(
		(h.callbacks.marks.at(-1) as { segmentIds: string[] }).segmentIds,
		["a"],
	);
	Object.assign(h.doc, {
		caretRangeFromPoint: () => ({
			startContainer: { nodeType: 3, parentElement: h.leaf, data: "甲乙丙丁" },
			startOffset: 2,
		}),
	});
	h.event("pointerdown");
	h.event("pointerup");
	assert.equal(h.callbacks.marks.filter(Boolean).length, 1);
});

test("offscreen and visibility-hidden characters never become invisible hit targets", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	Object.assign(h.element, { clientWidth: 10 });
	h.event("pointerdown");
	assert.equal(h.event("pointerup").defaultPrevented, false);
	Object.assign(h.element, { clientWidth: 300 });
	Object.assign(h.doc.defaultView, {
		getComputedStyle: () => ({ visibility: "hidden" }),
	});
	h.event("pointerdown");
	assert.equal(h.event("pointerup").defaultPrevented, false);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
});

test("disposing an old frame twice cannot remove replacement mark hit data", () => {
	const h = harness();
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	h.study.mount({
		index: 0,
		doc: h.doc as unknown as Document,
		element: h.element,
		chapter: h.chapter,
		valid: () => true,
		projection: () => ({
			raw: h.node.data,
			entries: [{ node: h.node, start: 0, end: 4 }],
		}),
	});
	h.detach();
	assert.equal(h.highlights.has("folio-study"), true);
	h.event("pointerdown");
	h.event("pointerup");
	assert.equal(h.callbacks.marks.filter(Boolean).length, 1);
});

test("a selection in another current frame takes priority over marked taps", () => {
	const h = harness(),
		other = harness();
	h.study.mount({
		index: 1,
		doc: other.doc as unknown as Document,
		element: other.element,
		chapter: h.chapter,
		valid: () => true,
		projection: () => ({
			raw: other.node.data,
			entries: [{ node: other.node, start: 0, end: 4 }],
		}),
	});
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	other.selection();
	h.event("pointerdown");
	assert.equal(h.event("pointerup").defaultPrevented, false);
	assert.equal(h.callbacks.marks.filter(Boolean).length, 0);
});

for (const marked of [true, false]) {
	for (const longPress of [false, true]) {
		test(`${marked ? "marked" : "unmarked"} ruby touch ${longPress ? "selection" : "tap"} has exactly one effect when presentation mounts first`, (t) => {
			t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
			const attributes = new Set<string>(),
				mutations: string[] = [];
			let cleanup: (() => void) | undefined;
			const h = harness((doc, leaf) => {
				Object.assign(leaf, {
					closest: (selector: string) => (selector === "ruby" ? leaf : null),
					toggleAttribute: (name: string, value?: boolean) => {
						if (value ?? !attributes.has(name)) attributes.add(name);
						else attributes.delete(name);
						if (name === "data-reader-ruby-open") mutations.push(name);
					},
					removeAttribute: (name: string) => attributes.delete(name),
				});
				cleanup = applyFramePresentation(doc, "white", {
					...DEFAULT_BOOK_UI,
					ruby: "on-demand",
				});
			});
			h.study.setMarks(
				h.chapter,
				marked ? [h.mark("a", 0, 4)] : [],
				true,
				"white",
			);
			assert.equal(
				h.event("pointerdown", { pointerType: "touch", target: h.leaf, at: 0 })
					.defaultPrevented,
				false,
			);
			t.mock.timers.tick(longPress ? 600 : 50);
			if (longPress) {
				h.selection();
				h.event("selectionchange");
			}
			const up = h.event("pointerup", {
				pointerType: "touch",
				target: h.leaf,
				at: longPress ? 600 : 50,
			});
			t.mock.timers.tick(60);
			assert.equal(up.defaultPrevented, marked && !longPress);
			assert.equal(
				h.callbacks.marks.filter(Boolean).length,
				marked && !longPress ? 1 : 0,
			);
			assert.equal(
				attributes.has("data-reader-ruby-open"),
				!marked && !longPress,
			);
			assert.equal(mutations.length, !marked && !longPress ? 1 : 0);
			if (longPress) {
				assert.equal(h.doc.getSelection()?.isCollapsed, false);
				assert.equal(attributes.has("data-reader-ruby-selected"), true);
				assert.equal(h.callbacks.selection.filter(Boolean).length, 1);
			}
			cleanup?.();
		});
	}
}

for (const vertical of [false, true]) {
	test(`${vertical ? "vertical columns" : "two lines"} anchor protects every visible hit range while gaps remain unclickable`, () => {
		const h = harness();
		h.setRects((start, end) =>
			Array.from({ length: end - start }, (_, index) => {
				const offset = start + index;
				const line = offset < 2 ? 0 : 30,
					position = (offset % 2) * 10;
				const left = vertical ? line : position,
					top = vertical ? position : line;
				const width = vertical ? 20 : 10,
					height = vertical ? 10 : 20;
				return {
					left,
					right: left + width,
					top,
					bottom: top + height,
					width,
					height,
				};
			}),
		);
		h.study.setMarks(
			h.chapter,
			[h.mark("a", 0, 3), h.mark("b", 2, 4)],
			true,
			"white",
		);
		const x = vertical ? 35 : 5,
			y = vertical ? 5 : 35;
		h.doc.caretPositionFromPoint = () => ({ offsetNode: h.node, offset: 2 });
		h.event("pointerdown", { clientX: x, clientY: y });
		h.event("pointerup", { clientX: x, clientY: y });
		assert.deepEqual(h.callbacks.marks.at(-1), {
			segmentIds: ["a", "b"],
			anchor: {
				left: 100,
				right: vertical ? 150 : 120,
				top: 200,
				bottom: vertical ? 220 : 250,
			},
		});
		const count = h.callbacks.marks.filter(Boolean).length;
		// Expanded floating-card protection never becomes an expanded click target.
		const gap = { clientX: vertical ? 25 : 5, clientY: vertical ? 5 : 25 };
		h.event("pointerdown", gap);
		assert.equal(h.event("pointerup", gap).defaultPrevented, false);
		assert.equal(h.callbacks.marks.filter(Boolean).length, count);
	});
}

test("complete mark anchors clip each rectangle to the frame, reader viewport, and outer screen", () => {
	const viewport = Object.assign(new EventTarget(), {
		getBoundingClientRect: () => ({
			left: 112,
			right: 190,
			top: 205,
			bottom: 218,
		}),
	}) as HTMLElement;
	const h = harness(undefined, viewport);
	Object.assign(h.element, {
		clientWidth: 35,
		ownerDocument: { defaultView: { innerWidth: 132, innerHeight: 216 } },
	});
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	h.event("pointerdown");
	h.event("pointerup");
	assert.deepEqual(h.callbacks.marks.at(-1), {
		segmentIds: ["a"],
		anchor: { left: 112, right: 132, top: 205, bottom: 216 },
	});
	Object.assign(h.element, {
		ownerDocument: { defaultView: { innerWidth: 500, innerHeight: 500 } },
	});
	h.event("pointerdown");
	h.event("pointerup");
	assert.deepEqual(h.callbacks.marks.at(-1), {
		segmentIds: ["a"],
		anchor: { left: 112, right: 135, top: 205, bottom: 218 },
	});
});

test("ordinary scrolling does not measure or republish bookmark geometry", () => {
	const viewport = new EventTarget() as HTMLElement;
	const h = harness(undefined, viewport);
	const entries: unknown[] = [];
	h.study.bind({ ...h.binding, onEntries: (value) => entries.push(value) });
	h.study.setMarks(h.chapter, [h.mark("a", 0, 4)], true, "white");
	let measures = 0;
	h.setRects(() => {
		measures++;
		return [{ left: 0, right: 40, top: 0, bottom: 20, width: 40, height: 20 }];
	});
	const publications = entries.length;
	for (const type of ["wheel", "touchmove"]) h.event(type);
	viewport.dispatchEvent(new Event("scroll"));
	assert.equal(measures, 0);
	assert.equal(entries.length, publications);
});
