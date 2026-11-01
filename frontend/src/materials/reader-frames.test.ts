import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Chapter } from "./api.ts";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import { ReaderFrames } from "./reader-frames.ts";

function documentFixture(text = "") {
	let finishFonts: (() => void) | undefined;
	let selected = false;
	let selectionTarget: Node | null = null;
	const image = Object.assign(new EventTarget(), { complete: false });
	const style = { setProperty: () => {} };
	const textNode = {
		data: text,
		length: text.length,
		parentElement: { closest: () => null },
	};
	const leaf = {
		nodeType: 1,
		dataset: { locatorLeaf: "0" },
		closest: () => null,
		children: [],
	};
	const doc = Object.assign(new EventTarget(), {
		querySelectorAll: (selector: string) =>
			text && (selector === "[data-locator-leaf]" || selector === "*")
				? [leaf]
				: [],
		createTreeWalker: () => {
			let first = true;
			return {
				nextNode: () => {
					if (!first) return null;
					first = false;
					return textNode;
				},
			};
		},
		createRange: () => ({ setStart: () => {}, setEnd: () => {} }),
		getSelection: () =>
			selected
				? {
						isCollapsed: false,
						anchorNode: selectionTarget,
						focusNode: selectionTarget,
						toString: () => "選択",
					}
				: null,
		getElementById: () => ({ textContent: "" }),
		head: { prepend: () => {} },
		documentElement: { dataset: {}, scrollWidth: 100, scrollHeight: 100 },
		body: { style, scrollWidth: 100, scrollHeight: 100 },
		defaultView: null,
		fonts: {
			ready: new Promise<void>((resolve) => {
				finishFonts = resolve;
			}),
		},
		images: [image],
	});
	return {
		outerDocument: Object.assign(new EventTarget(), {
			defaultView: new EventTarget(),
		}),
		doc: doc as unknown as Document,
		event: doc,
		image,
		fonts: () => finishFonts?.(),
		textNode,
		leaf: leaf as unknown as Node,
		select: (target = leaf as unknown as Node) => {
			selected = true;
			selectionTarget = target;
		},
	};
}
const chapter = {
	id: "chapter",
	resources: [{ id: "r", text: "" }],
	parts: [
		{ resource_id: "r", spine_index: 0, start: 0, end: 0, leaf_start: 0 },
	],
} as Chapter;

for (const change of [
	"dispose",
	"generation",
	"replacement",
	"detach",
] as const) {
	test(`frame ${change} rejects late resource readiness, selection and stale events`, async () => {
		const previousStyle = Object.getOwnPropertyDescriptor(
			globalThis,
			"getComputedStyle",
		);
		Object.defineProperty(globalThis, "getComputedStyle", {
			configurable: true,
			value: () => ({
				paddingTop: "0",
				paddingBottom: "0",
				paddingLeft: "0",
				paddingRight: "0",
			}),
		});
		try {
			const frames = new ReaderFrames();
			const h = documentFixture();
			let generation = 2,
				keys = 0,
				unbound = 0,
				ready = 0;
			const element = {
				ownerDocument: h.outerDocument,
				contentDocument: h.doc,
				isConnected: true,
				style: {},
			} as unknown as HTMLIFrameElement;
			const root = Object.assign(new EventTarget(), {
				contains: () => true,
				clientWidth: 0,
				clientHeight: 0,
				getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
			}) as unknown as HTMLElement;
			frames.register(0, element);
			const context = {
				chapter,
				readingGeneration: "g",
				readings: undefined,
				current: () => ({
					settings: {
						font_size: 22,
						line_height: 2,
						writing_mode: "horizontal-tb" as const,
					},
					theme: "white" as const,
					bookUi: DEFAULT_BOOK_UI,
				}),
				generation: () => generation,
				root: () => root,
				bindFocus: () => () => {
					unbound++;
				},
				key: () => {
					keys++;
				},
				wheel: () => {},
				touch: () => {},
				image: () => {},
				ready: () => {
					ready++;
				},
				error: (error: Error) => assert.fail(error.message),
			};
			frames.load(0, element, 2, context);
			assert.ok(frames.get(0));
			h.event.dispatchEvent(
				Object.assign(new Event("keydown"), { key: "ArrowDown" }),
			);
			assert.equal(keys, 1);
			h.select();
			const mounted = frames.get(0);
			const rubyCleanup = mounted?.presentationCleanup;
			frames.presentation("black", DEFAULT_BOOK_UI);
			assert.equal(
				frames.get(0),
				mounted,
				"Palette changes keep the iframe instance",
			);
			assert.equal(
				mounted?.presentationCleanup,
				rubyCleanup,
				"Palette changes keep ruby listeners bound",
			);
			assert.equal(
				h.doc.getSelection()?.isCollapsed,
				false,
				"Palette changes preserve native selection",
			);
			assert.equal(unbound, 0);
			if (change === "dispose") frames.clear();
			if (change === "generation") generation++;
			if (change === "replacement")
				Object.assign(element, { contentDocument: documentFixture().doc });
			if (change === "detach") Object.assign(element, { isConnected: false });
			h.event.dispatchEvent(
				Object.assign(new Event("keydown"), { key: "ArrowDown" }),
			);
			assert.equal(keys, 1);
			assert.throws(
				() => frames.captureStudyTarget("m", "v", chapter),
				/重新选择|连续原文/,
			);
			h.fonts();
			h.image.dispatchEvent(new Event("load"));
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(ready, 0);
			frames.clear();
			assert.equal(unbound, 1);
		} finally {
			if (previousStyle)
				Object.defineProperty(globalThis, "getComputedStyle", previousStyle);
			else Reflect.deleteProperty(globalThis, "getComputedStyle");
		}
	});
}

test("current frame resources become ready once and frame replacement releases the old bindings", async () => {
	const previousStyle = Object.getOwnPropertyDescriptor(
		globalThis,
		"getComputedStyle",
	);
	Object.defineProperty(globalThis, "getComputedStyle", {
		configurable: true,
		value: () => ({
			paddingTop: "0",
			paddingBottom: "0",
			paddingLeft: "0",
			paddingRight: "0",
		}),
	});
	try {
		const frames = new ReaderFrames();
		const first = documentFixture(),
			next = documentFixture();
		const element = {
			ownerDocument: first.outerDocument,
			contentDocument: first.doc,
			isConnected: true,
			style: {},
		} as unknown as HTMLIFrameElement;
		const root = Object.assign(new EventTarget(), {
			contains: () => true,
			clientWidth: 0,
			clientHeight: 0,
			getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
		}) as unknown as HTMLElement;
		let unbound = 0,
			ready = 0;
		const context = {
			chapter,
			readingGeneration: "g",
			readings: undefined,
			current: () => ({
				settings: {
					font_size: 22,
					line_height: 2,
					writing_mode: "horizontal-tb" as const,
				},
				theme: "white" as const,
				bookUi: DEFAULT_BOOK_UI,
			}),
			generation: () => 2,
			root: () => root,
			bindFocus: () => () => {
				unbound++;
			},
			key: () => {},
			wheel: () => {},
			touch: () => {},
			image: () => {},
			ready: () => {
				ready++;
			},
			error: (error: Error) => assert.fail(error.message),
		};
		frames.register(0, element);
		frames.load(0, element, 2, context);
		Object.assign(element, { contentDocument: next.doc });
		frames.load(0, element, 2, context);
		assert.equal(unbound, 1);
		first.fonts();
		first.image.dispatchEvent(new Event("load"));
		next.fonts();
		next.image.dispatchEvent(new Event("error"));
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(ready, 1);
		frames.clear();
		assert.equal(unbound, 2);
	} finally {
		if (previousStyle)
			Object.defineProperty(globalThis, "getComputedStyle", previousStyle);
		else Reflect.deleteProperty(globalThis, "getComputedStyle");
	}
});

test("navigation highlights validate every current part and snapshot before painting", () => {
	const original = Object.getOwnPropertyDescriptor(
		globalThis,
		"getComputedStyle",
	);
	Object.defineProperty(globalThis, "getComputedStyle", {
		configurable: true,
		value: () => ({
			paddingTop: "0",
			paddingBottom: "0",
			paddingLeft: "0",
			paddingRight: "0",
		}),
	});
	try {
		const frames = new ReaderFrames();
		const resource = (id: string, text: string) => ({
			id,
			text,
			text_sha256: "a".repeat(64),
		});
		const chapter = {
			material_id: "m",
			version_id: "v",
			id: "c",
			resources: [resource("r", "甲乙"), resource("s", "丙丁")],
			parts: [
				{ resource_id: "r", spine_index: 0, start: 0, end: 2, leaf_start: 0 },
				{ resource_id: "s", spine_index: 1, start: 0, end: 2, leaf_start: 0 },
			],
		} as Chapter;
		const root = Object.assign(new EventTarget(), {
			contains: () => true,
			clientWidth: 0,
			clientHeight: 0,
			getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
		}) as unknown as HTMLElement;
		const context = {
			chapter,
			readingGeneration: "g",
			readings: undefined,
			current: () => ({
				settings: {
					font_size: 22,
					line_height: 2,
					writing_mode: "horizontal-tb" as const,
				},
				theme: "white" as const,
				bookUi: DEFAULT_BOOK_UI,
			}),
			generation: () => 0,
			root: () => root,
			bindFocus: () => undefined,
			key: () => {},
			wheel: () => {},
			touch: () => {},
			image: () => {},
			ready: () => {},
			error: (error: Error) => assert.fail(error.message),
		};
		const h1 = documentFixture("甲乙"),
			h2 = documentFixture("丙丁");
		const highlights = [new Map<string, unknown>(), new Map<string, unknown>()];
		for (const [index, fixture] of [h1, h2].entries())
			Object.assign(fixture.doc, {
				defaultView: {
					Highlight: class {},
					CSS: { highlights: highlights[index] },
				},
			});
		const element1 = {
			ownerDocument: h1.outerDocument,
			contentDocument: h1.doc,
			isConnected: true,
			style: {},
		} as unknown as HTMLIFrameElement;
		const element2 = {
			ownerDocument: h2.outerDocument,
			contentDocument: h2.doc,
			isConnected: true,
			style: {},
		} as unknown as HTMLIFrameElement;
		frames.register(0, element1);
		frames.load(0, element1, 0, context);
		const ranges = [
			{
				resource_id: "r",
				spine_index: 0,
				start: 0,
				end: 2,
				exact: "甲乙",
				text_sha256: "a".repeat(64),
			},
			{
				resource_id: "s",
				spine_index: 1,
				start: 0,
				end: 1,
				exact: "丙",
				text_sha256: "a".repeat(64),
			},
		];
		assert.throws(() => frames.highlight(chapter, ranges), /完整/);
		assert.equal(highlights[0]?.has("folio-search"), false);
		const [firstRange, secondRange] = ranges;
		assert.ok(firstRange && secondRange);
		frames.register(1, element2);
		frames.load(1, element2, 0, context);
		assert.doesNotThrow(() => frames.highlight(chapter, ranges));
		for (const painted of highlights) assert.ok(painted.has("folio-search"));
		frames.clearSearchHighlights();
		assert.throws(
			() => frames.highlight({ ...chapter, id: "other" }, ranges),
			/完整/,
		);
		assert.throws(
			() =>
				frames.highlight(chapter, [
					{ ...firstRange, exact: "錯" },
					secondRange,
				]),
			/快照/,
		);
		h2.textNode.data = "損壊";
		assert.throws(() => frames.highlight(chapter, ranges), /投影/);
		for (const painted of highlights)
			assert.equal(painted.has("folio-search"), false);
		frames.clear();
		h1.fonts();
		h2.fonts();
	} finally {
		if (original)
			Object.defineProperty(globalThis, "getComputedStyle", original);
		else Reflect.deleteProperty(globalThis, "getComputedStyle");
	}
});

function feedbackFixture(t: TestContext) {
	const original = Object.getOwnPropertyDescriptor(
		globalThis,
		"getComputedStyle",
	);
	Object.defineProperty(globalThis, "getComputedStyle", {
		configurable: true,
		value: () => ({
			paddingTop: "0",
			paddingBottom: "0",
			paddingLeft: "0",
			paddingRight: "0",
		}),
	});
	t.after(() => {
		if (original)
			Object.defineProperty(globalThis, "getComputedStyle", original);
		else Reflect.deleteProperty(globalThis, "getComputedStyle");
	});
	const frames = new ReaderFrames();
	t.after(() => frames.clear());
	const h = documentFixture("甲乙");
	const element = {
		ownerDocument: h.outerDocument,
		contentDocument: h.doc,
		isConnected: true,
		style: {},
	} as unknown as HTMLIFrameElement;
	const root = Object.assign(new EventTarget(), {
		contains: () => true,
		clientWidth: 0,
		clientHeight: 0,
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
	}) as unknown as HTMLElement;
	const currentChapter = {
		...chapter,
		resources: [{ id: "r", text: "甲乙" }],
		parts: [{ ...chapter.parts[0], end: 2 }],
	} as Chapter;
	let generation = 0;
	const interactions: string[] = [];
	const context = {
		chapter: currentChapter,
		readingGeneration: "g",
		readings: undefined,
		current: () => ({
			settings: {
				font_size: 22,
				line_height: 2,
				writing_mode: "horizontal-tb" as const,
			},
			theme: "white" as const,
			bookUi: DEFAULT_BOOK_UI,
		}),
		generation: () => generation,
		root: () => root,
		bindFocus: () => undefined,
		key: () => {},
		wheel: () => {},
		touch: () => {},
		interaction: (event: Event) => interactions.push(event.type),
		image: () => {},
		ready: () => {},
		error: (error: Error) => assert.fail(error.message),
	};
	frames.register(0, element);
	frames.load(0, element, 0, context);
	return {
		frames,
		h,
		element,
		context,
		interactions,
		invalidate: () => generation++,
	};
}

function pointerdown(h: ReturnType<typeof documentFixture>, target: Node) {
	const event = new Event("pointerdown");
	Object.defineProperty(event, "target", { value: target });
	h.event.dispatchEvent(event);
}

test("navigation feedback clears across frames and releases the old document on replacement and teardown", (t) => {
	const { frames, h, element, context } = feedbackFixture(t);
	const next = documentFixture("甲乙");
	const firstMarks = new Map([
		["folio-search", {}],
		["folio-study", {}],
		["folio-translation", {}],
	]);
	const nextMarks = new Map(firstMarks);
	Object.assign(h.event, { defaultView: { CSS: { highlights: firstMarks } } });
	Object.assign(next.event, {
		defaultView: { CSS: { highlights: nextMarks } },
	});
	const other = { ...element, contentDocument: next.doc };
	frames.register(1, other);
	frames.load(1, other, 0, {
		...context,
		chapter: {
			...context.chapter,
			parts: [context.chapter.parts[0], context.chapter.parts[0]],
		} as Chapter,
	});
	for (const marks of [firstMarks, nextMarks]) {
		marks.set("folio-search", {});
		marks.set("folio-study", {});
		marks.set("folio-translation", {});
	}
	frames.clearSearchHighlights();
	assert.deepEqual(
		[...firstMarks.keys()],
		["folio-study", "folio-translation"],
	);
	assert.deepEqual([...nextMarks.keys()], ["folio-study", "folio-translation"]);
	firstMarks.set("folio-search", {});
	nextMarks.set("folio-search", {});
	Object.assign(element, { contentDocument: next.doc });
	frames.load(0, element, 0, context);
	assert.equal(firstMarks.has("folio-search"), false);
	assert.equal(nextMarks.has("folio-search"), true);
	frames.clear();
	assert.equal(nextMarks.has("folio-search"), false);
});

test("only current original reader targets and noncollapsed reader selections notify interaction", (t) => {
	const f = feedbackFixture(t);
	const foreign = { nodeType: 1 } as Node;
	pointerdown(f.h, f.h.leaf);
	pointerdown(f.h, foreign);
	f.h.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, ["pointerdown"]);
	f.h.select(foreign);
	f.h.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, ["pointerdown"]);
	f.h.select();
	f.h.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, ["pointerdown", "selectionchange"]);
	f.invalidate();
	pointerdown(f.h, f.h.leaf);
	f.h.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, ["pointerdown", "selectionchange"]);
});

test("replaced frame documents release pointer and selection listeners", (t) => {
	const f = feedbackFixture(t);
	const next = documentFixture("甲乙");
	Object.assign(f.element, { contentDocument: next.doc });
	f.frames.load(0, f.element, 0, f.context);
	pointerdown(f.h, f.h.leaf);
	f.h.select();
	f.h.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, []);
	pointerdown(next, next.leaf);
	next.select();
	next.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, ["pointerdown", "selectionchange"]);
	f.frames.clear();
	pointerdown(next, next.leaf);
	next.event.dispatchEvent(new Event("selectionchange"));
	assert.deepEqual(f.interactions, ["pointerdown", "selectionchange"]);
});

test("reader reflows retain the current navigation fade and clearing restores a fresh target", (t) => {
	const { frames, h, context } = feedbackFixture(t);
	const style = { textContent: "" };
	const marks = new Map<string, unknown>();
	Object.assign(h.event, {
		getElementById: () => style,
		defaultView: { Highlight: class {}, CSS: { highlights: marks } },
	});
	const ranges = [{ resource_id: "r", spine_index: 0, start: 0, end: 2 }];
	frames.highlight(context.chapter, ranges);
	frames.setSearchHighlightOpacity(0.5);
	assert.match(style.textContent, /\/ 0.5\)/);
	frames.highlight(context.chapter, ranges);
	assert.match(style.textContent, /\/ 0.5\)/);
	assert.ok(marks.has("folio-search"));
	frames.clearSearchHighlights();
	assert.equal(marks.has("folio-search"), false);
	frames.highlight(context.chapter, ranges);
	assert.match(style.textContent, /\/ 1\)/);
});
