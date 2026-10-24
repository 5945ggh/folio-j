import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter } from "./api.ts";
import type { Projection } from "./dom.ts";
import {
	InlineTranslation,
	inlineTranslationInRange,
} from "./inline-translation.ts";
import { copyReaderSelection } from "./reader-clipboard.ts";
import { captureNativeSelection } from "./reader-selection.ts";

class ElementFixture {
	nodeType = 1;
	parentElement: ElementFixture | null = null;
	childNodes: (ElementFixture | TextFixture)[] = [];
	dataset: Record<string, string> = {};
	css: Record<string, string> = {};
	declarations = new Map<string, string>();
	style = {
		setProperty: (key: string, value: string, priority: string) => {
			assert.equal(priority, "important");
			this.declarations.set(key, value);
		},
	};
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	get children() {
		return this.childNodes.filter((node) => node.nodeType === 1);
	}
	get nextSibling(): ElementFixture | TextFixture | null {
		const siblings = this.parentElement?.childNodes ?? [];
		return siblings[siblings.indexOf(this) + 1] ?? null;
	}
	get isConnected(): boolean {
		return this.tagName === "BODY" || !!this.parentElement?.isConnected;
	}
	get textContent(): string {
		return this.childNodes.map((node) => node.textContent).join("");
	}
	set textContent(value: string) {
		this.childNodes = [];
		this.append(new TextFixture(value));
	}
	append(node: ElementFixture | TextFixture) {
		node.parentElement = this;
		this.childNodes.push(node);
	}
	insertBefore(
		node: ElementFixture,
		before: ElementFixture | TextFixture | null,
	) {
		node.parentElement = this;
		const index = before
			? this.childNodes.indexOf(before)
			: this.childNodes.length;
		this.childNodes.splice(index, 0, node);
	}
	remove() {
		const parent = this.parentElement;
		if (parent) parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
		this.parentElement = null;
	}
	contains(node: ElementFixture | TextFixture): boolean {
		return (
			node === this ||
			this.childNodes.some(
				(child) =>
					child === node ||
					(child.nodeType === 1 && (child as ElementFixture).contains(node)),
			)
		);
	}
	closest(selector: string): ElementFixture | null {
		const matches = selector
			.split(",")
			.some((part) =>
				part === "[data-locator-leaf]"
					? this.dataset.locatorLeaf !== undefined
					: part.toUpperCase() === this.tagName,
			);
		return matches ? this : (this.parentElement?.closest(selector) ?? null);
	}
	setAttribute() {}
	getBoundingClientRect() {
		return { height: 40 };
	}
	get scrollHeight() {
		return 40;
	}
}
class TextFixture {
	nodeType = 3;
	parentElement: ElementFixture | null = null;
	readonly data: string;
	constructor(data: string) {
		this.data = data;
	}
	get textContent() {
		return this.data;
	}
	get length() {
		return this.data.length;
	}
}
function fixture() {
	const body = new ElementFixture("BODY");
	const defaultStyle = {
		display: "block",
		position: "static",
		float: "none",
		writingMode: "horizontal-tb",
		columnCount: "auto",
		columnWidth: "auto",
		overflowX: "visible",
		overflowY: "visible",
		fontSize: "22px",
	};
	let queued: FrameRequestCallback | null = null;
	const doc = {
		body,
		defaultView: {
			getComputedStyle: (element: ElementFixture) => ({
				...defaultStyle,
				...(element.tagName === "SPAN" || element.tagName === "RUBY"
					? { display: "inline" }
					: {}),
				...element.css,
			}),
			matchMedia: () => ({ matches: true }),
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				queued = callback;
				return 1;
			},
			cancelAnimationFrame: () => {
				queued = null;
			},
		},
		querySelectorAll: () => [],
		createElement: (tag: string) => new ElementFixture(tag.toUpperCase()),
	} as unknown as Document;
	const entries: Projection["entries"] = [];
	let raw = "";
	const block = (tag: string, parent = body) => {
		const node = new ElementFixture(tag.toUpperCase());
		parent.append(node);
		return node;
	};
	const leaf = (text: string, parent: ElementFixture) => {
		const node = block("span", parent);
		node.dataset.locatorLeaf = String(entries.length);
		const textNode = new TextFixture(text);
		node.append(textNode);
		entries.push({
			node: textNode as unknown as Text,
			start: raw.length,
			end: raw.length + text.length,
		});
		raw += text;
		return node;
	};
	return {
		doc,
		body,
		block,
		leaf,
		projection: () => ({ raw, entries }),
		animation: () => {
			const callback = queued;
			queued = null;
			return callback;
		},
	};
}
const mutate = (update: () => void) => update();

test("translation follows the whole ending paragraph without touching original nodes or locator projection", () => {
	const h = fixture(),
		panel = new InlineTranslation();
	const first = h.block("p"),
		last = h.block("p");
	h.leaf("前段。", first);
	h.leaf("漢字", h.block("ruby", last));
	h.leaf("の後半。", last);
	const projection = h.projection(),
		entries = [...projection.entries];
	assert.equal(panel.set(h.doc, projection, 5, "訳文", mutate), true);
	assert.equal(h.body.childNodes[0], first);
	assert.equal(h.body.childNodes[1], last);
	assert.equal(h.body.childNodes[2]?.textContent, "訳文");
	assert.equal(h.body.childNodes.length, 3);
	assert.deepEqual(projection.entries, entries);
	assert.equal(projection.raw, "前段。漢字の後半。");
	panel.clear();
	assert.deepEqual(h.body.childNodes, [first, last]);
});

test("compiled br-only paragraphs end at a complete newline leaf and simple div paragraphs remain supported", () => {
	for (const tag of ["body", "div"]) {
		const h = fixture(),
			panel = new InlineTranslation();
		const parent = tag === "body" ? h.body : h.block(tag);
		h.leaf("最初の段落。", parent);
		const newline = h.leaf("\n", parent);
		const second = h.leaf("次の段落。", parent);
		assert.equal(panel.set(h.doc, h.projection(), 2, "first", mutate), true);
		assert.equal(parent.childNodes[1], newline);
		assert.equal(parent.childNodes[2]?.textContent, "first");
		assert.equal(parent.childNodes[3], second);
		panel.clear();
	}
});

test("unsafe parent layout, vertical source, and unsplittable inline line breaks fall back without mutation", () => {
	for (const css of [
		{ display: "flex" },
		{ display: "grid" },
		{ display: "table" },
		{ writingMode: "vertical-rl" },
		{ columnCount: "2" },
	] as Record<string, string>[]) {
		const h = fixture(),
			panel = new InlineTranslation();
		h.body.css = css;
		const p = h.block("p");
		h.leaf("原文", p);
		assert.equal(panel.set(h.doc, h.projection(), 1, "訳", mutate), false);
		assert.deepEqual(h.body.childNodes, [p]);
	}
	const h = fixture();
	h.leaf("一行。\n二行。", h.body);
	assert.equal(
		new InlineTranslation().set(h.doc, h.projection(), 1, "訳", mutate),
		false,
	);
	assert.equal(h.body.childNodes.length, 1);
});

test("fade feedback lays out once per open or close and never mutates layout per frame", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = fixture(),
		panel = new InlineTranslation();
	assert.ok(h.doc.defaultView);
	Object.assign(h.doc.defaultView, { matchMedia: () => ({ matches: false }) });
	h.leaf("原文", h.block("p"));
	let mutations = 0;
	const apply = (update: () => void) => {
		mutations++;
		update();
	};
	panel.set(h.doc, h.projection(), 1, "訳", apply);
	const node = h.body.childNodes[1] as ElementFixture;
	assert.equal(node.declarations.get("height"), "auto");
	assert.equal(node.declarations.get("opacity"), "0");
	h.animation()?.(0);
	assert.equal(node.declarations.get("opacity"), ".8");
	assert.equal(h.animation(), null);
	assert.equal(mutations, 1);
	panel.hide(apply);
	assert.equal(node.declarations.get("height"), "auto");
	assert.equal(node.declarations.get("opacity"), "0");
	assert.equal(mutations, 1);
	t.mock.timers.tick(159);
	assert.equal(h.body.childNodes.length, 2);
	t.mock.timers.tick(1);
	assert.equal(h.body.childNodes.length, 1);
	assert.equal(mutations, 2);
});

test("cancelled fade completion cannot remove a replacement or reenter a disposed reader", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = fixture(),
		panel = new InlineTranslation();
	assert.ok(h.doc.defaultView);
	Object.assign(h.doc.defaultView, { matchMedia: () => ({ matches: false }) });
	h.leaf("原文", h.block("p"));
	panel.set(h.doc, h.projection(), 1, "old", mutate);
	panel.hide(mutate);
	panel.set(h.doc, h.projection(), 1, "new", mutate);
	t.mock.timers.tick(200);
	assert.equal(h.body.childNodes[1]?.textContent, "new");
	panel.hide(() => {
		throw new Error("disposed callback");
	});
	panel.clear(false);
	t.mock.timers.tick(200);
	assert.equal(h.body.childNodes.length, 1);
	assert.equal(h.animation(), null);
});

test("generated translation copies separately, mixed source copy stays canonical, and study capture rejects translation", () => {
	const h = fixture(),
		panel = new InlineTranslation();
	h.leaf("原文", h.block("p"));
	panel.set(h.doc, h.projection(), 1, "完整译文", mutate);
	const generated = h.body.childNodes[1] as ElementFixture;
	const translated = generated.childNodes[0];
	assert.ok(translated);
	const original = h.projection().entries[0]?.node;
	assert.ok(original);
	for (const mixed of [false, true]) {
		const range = {
			startContainer: mixed ? original : translated,
			endContainer: translated,
			startOffset: 0,
			endOffset: translated.textContent.length,
			intersectsNode: () => true,
		} as unknown as Range;
		Object.assign(h.doc, {
			getSelection: () => ({
				isCollapsed: false,
				rangeCount: 1,
				getRangeAt: () => range,
				toString: () => "完整译文",
			}),
		});
		assert.equal(
			inlineTranslationInRange(h.doc, range),
			generated as unknown as HTMLElement,
		);
		const data = new Map<string, string>([["text/html", "unwanted"]]);
		const event = Object.assign(new Event("copy", { cancelable: true }), {
			clipboardData: {
				clearData: () => data.clear(),
				setData: (key: string, value: string) => data.set(key, value),
			},
		});
		copyReaderSelection(
			h.doc,
			h.projection(),
			event as unknown as ClipboardEvent,
		);
		assert.equal(event.defaultPrevented, true);
		assert.equal(data.get("text/plain"), mixed ? "原文" : "完整译文");
		assert.equal(data.has("text/html"), false);
		assert.throws(
			() =>
				captureNativeSelection(
					h.doc,
					h.projection(),
					{} as Chapter["parts"][number],
					{} as Chapter["resources"][number],
					"m",
					"v",
				),
			/包含译文/,
		);
	}
	panel.clear();
	assert.equal(
		inlineTranslationInRange(h.doc, {
			intersectsNode: () => true,
		} as unknown as Range),
		null,
	);
});

test("same target and text are idempotent; replacement and clear release the sole generated node", () => {
	const h = fixture(),
		panel = new InlineTranslation();
	h.leaf("原文", h.block("p"));
	let mutations = 0;
	const apply = (update: () => void) => {
		mutations++;
		update();
	};
	assert.equal(panel.set(h.doc, h.projection(), 1, "訳", apply), true);
	const node = h.body.childNodes[1];
	assert.equal(panel.set(h.doc, h.projection(), 1, "訳", apply), true);
	assert.equal(mutations, 1);
	assert.equal(h.body.childNodes[1], node);
	assert.equal(h.animation(), null);
	assert.equal(panel.set(h.doc, h.projection(), 1, "new", apply), true);
	assert.equal(h.body.childNodes.length, 2);
	assert.equal(h.body.childNodes[1]?.textContent, "new");
	panel.clear();
	panel.clear();
	assert.equal(h.body.childNodes.length, 1);
});

test("lifecycle disposal removes immediately after its mutation wrapper is invalidated", () => {
	const h = fixture(),
		panel = new InlineTranslation();
	h.leaf("原文", h.block("p"));
	let disposed = false;
	panel.set(h.doc, h.projection(), 1, "訳文", (update) => {
		assert.equal(disposed, false, "disposal must not reenter reflow");
		update();
	});
	disposed = true;
	panel.clear(false);
	assert.equal(h.body.childNodes.length, 1);
});

test("a whole plain div stays intact and translation typography follows body font size", () => {
	const h = fixture(),
		panel = new InlineTranslation();
	const paragraph = h.block("div");
	h.leaf("原文の続き。", paragraph);
	panel.set(h.doc, h.projection(), 1, "訳文", mutate);
	assert.equal(h.body.childNodes[0], paragraph);
	assert.equal(paragraph.childNodes.length, 1);
	const translated = h.body.childNodes[1] as ElementFixture;
	assert.equal(
		translated.declarations.get("font-family"),
		"system-ui, sans-serif",
	);
	assert.equal(translated.declarations.get("font-size"), "18.7px");
	h.body.css.fontSize = "10px";
	panel.refresh();
	assert.equal(translated.declarations.get("font-size"), "14px");
	panel.clear();
});

test("whole paragraph spacing moves after translation and refresh follows author margin changes", () => {
	for (const tag of ["p", "div"]) {
		const h = fixture(),
			panel = new InlineTranslation(),
			paragraph = h.block(tag);
		paragraph.css.marginBottom = "220px";
		h.leaf("原文", paragraph);
		const declarations = [...paragraph.declarations];
		panel.set(h.doc, h.projection(), 1, "译文", mutate);
		const translated = h.body.childNodes[1] as ElementFixture;
		assert.equal(translated.declarations.get("margin-block-start"), "-220px");
		assert.equal(translated.declarations.get("margin-block-end"), "220px");
		assert.deepEqual([...paragraph.declarations], declarations);
		paragraph.css.marginBottom = "260px";
		panel.refresh();
		assert.equal(translated.declarations.get("margin-block-start"), "-260px");
		assert.equal(translated.declarations.get("margin-block-end"), "260px");
		paragraph.css.marginBottom = "-10px";
		panel.refresh();
		assert.equal(translated.declarations.get("margin-block-start"), "0px");
		assert.equal(translated.declarations.get("margin-block-end"), "0px");
		panel.clear();
	}
});

test("spacing compensation stays balanced throughout collapse and does not apply inside br paragraphs", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = fixture(),
		panel = new InlineTranslation(),
		paragraph = h.block("p");
	paragraph.css.marginBottom = "220px";
	h.leaf("原文", paragraph);
	assert.ok(h.doc.defaultView);
	Object.assign(h.doc.defaultView, { matchMedia: () => ({ matches: false }) });
	panel.set(h.doc, h.projection(), 1, "译文", mutate);
	const translated = h.body.childNodes[1] as ElementFixture;
	const balanced = () =>
		assert.equal(
			Number.parseFloat(
				translated.declarations.get("margin-block-start") ?? "NaN",
			) +
				Number.parseFloat(
					translated.declarations.get("margin-block-end") ?? "NaN",
				),
			0,
		);
	balanced();
	h.animation()?.(0);
	panel.hide(mutate);
	balanced();
	t.mock.timers.tick(159);
	balanced();
	assert.equal(translated.declarations.get("height"), "auto");
	t.mock.timers.tick(1);
	assert.equal(h.body.childNodes.length, 1);
	assert.equal(paragraph.css.marginBottom, "220px");

	const br = fixture(),
		inner = br.block("div");
	inner.css.marginBottom = "220px";
	br.leaf("前段", inner);
	br.leaf("\n", inner);
	br.leaf("後段", inner);
	panel.set(br.doc, br.projection(), 1, "译文", mutate);
	const inside = inner.childNodes[2] as ElementFixture;
	assert.equal(inside.declarations.get("margin-block-start"), "0px");
	assert.equal(inside.declarations.get("margin-block-end"), "0px");
	panel.clear();
});
