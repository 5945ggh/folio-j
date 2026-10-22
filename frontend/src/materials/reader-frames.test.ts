import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter } from "./api.ts";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import { ReaderFrames } from "./reader-frames.ts";

function documentFixture(text = "") {
	let finishFonts: (() => void) | undefined;
	let selected = false;
	const image = Object.assign(new EventTarget(), { complete: false });
	const style = { setProperty: () => {} };
	const textNode = {
		data: text,
		length: text.length,
		parentElement: { closest: () => null },
	};
	const leaf = {
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
			selected ? { isCollapsed: false, toString: () => "選択" } : null,
		getElementById: () => ({ textContent: "" }),
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
		doc: doc as unknown as Document,
		event: doc,
		image,
		fonts: () => finishFonts?.(),
		textNode,
		select: () => {
			selected = true;
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

test("strict study validation requires every current part and snapshot without depending on painting support", () => {
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
		const element1 = {
			contentDocument: h1.doc,
			isConnected: true,
			style: {},
		} as unknown as HTMLIFrameElement;
		const element2 = {
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
		assert.throws(() => frames.validateStudyTarget(chapter, ranges), /完整/);
		const [firstRange, secondRange] = ranges;
		assert.ok(firstRange && secondRange);
		frames.register(1, element2);
		frames.load(1, element2, 0, context);
		assert.doesNotThrow(() => frames.validateStudyTarget(chapter, ranges));
		assert.throws(
			() => frames.validateStudyTarget({ ...chapter, id: "other" }, ranges),
			/完整/,
		);
		assert.throws(
			() =>
				frames.validateStudyTarget(chapter, [
					{ ...firstRange, exact: "錯" },
					secondRange,
				]),
			/快照/,
		);
		h2.textNode.data = "損壊";
		assert.throws(() => frames.validateStudyTarget(chapter, ranges), /投影/);
		frames.clear();
		h1.fonts();
		h2.fonts();
	} finally {
		if (original)
			Object.defineProperty(globalThis, "getComputedStyle", original);
		else Reflect.deleteProperty(globalThis, "getComputedStyle");
	}
});
