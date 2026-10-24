import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import {
	applyFramePresentation,
	fitReaderImage,
	normalizeFrameImages,
} from "./presentation.ts";

test("theme paint owns the first cascade layer and updates without moving layout rules or author styles", () => {
	const author = {
		id: "author",
		textContent:
			"@layer publisher { .ink { color: #000 !important; background-image: linear-gradient(white, white) !important; -webkit-text-fill-color: #000 !important; text-shadow: 0 0 2px white !important; } }",
	};
	const authorCss = author.textContent;
	const presentation = { id: "folio-reader-presentation", textContent: "" };
	const head = [author, presentation];
	const move = (style: (typeof head)[number], first: boolean) => {
		const previous = head.indexOf(style);
		if (previous !== -1) head.splice(previous, 1);
		if (first) head.unshift(style);
		else head.push(style);
	};
	const doc = Object.assign(new EventTarget(), {
		getElementById: (id: string) => head.find((style) => style.id === id),
		createElement: () => ({ id: "", textContent: "" }),
		head: {
			prepend: (style: (typeof head)[number]) => move(style, true),
			append: (style: (typeof head)[number]) => move(style, false),
		},
		documentElement: { dataset: {} },
		querySelectorAll: () => [],
		getSelection: () => null,
	});
	let firstPaint: (typeof head)[number] | undefined;
	for (const theme of ["black", "white", "black"] as const) {
		const cleanup = applyFramePresentation(
			doc as unknown as Document,
			theme,
			DEFAULT_BOOK_UI,
		);
		const paint = head[0];
		assert.ok(paint);
		assert.notEqual(paint, author);
		assert.notEqual(paint, presentation);
		firstPaint ??= paint;
		assert.equal(paint, firstPaint);
		assert.match(paint.textContent, /^\s*@layer folio-reader-theme\s*\{/);
		assert.match(
			paint.textContent,
			new RegExp(
				`color:\\s*${theme === "black" ? "#e5e5e5" : "#282828"}\\s*!important`,
			),
		);
		assert.match(
			paint.textContent,
			new RegExp(
				`background-color:\\s*${theme === "black" ? "#191919" : "#fff"}\\s*!important`,
			),
		);
		assert.match(
			paint.textContent,
			/body :not\(img\):not\(svg\):not\(svg \*\)/,
		);
		for (const declaration of [
			/color:\s*inherit\s*!important/,
			/background-color:\s*transparent\s*!important/,
			/background-image:\s*none\s*!important/,
			/-webkit-text-fill-color:\s*currentColor\s*!important/,
			/text-shadow:\s*none\s*!important/,
		])
			assert.match(paint.textContent, declaration);
		assert.doesNotMatch(
			paint.textContent,
			/font-|display:|visibility:|opacity:|writing-mode:|line-height:|filter:|\bfill:/,
		);
		assert.deepEqual(head.slice(1), [author, presentation]);
		assert.match(presentation.textContent, /font-family:/);
		assert.match(presentation.textContent, /@media \(hover:hover\)/);
		cleanup();
		// A later stylesheet insertion must not take ownership of the first layer.
		move(author, true);
	}
	assert.equal(head.length, 3);
	assert.equal(author.textContent, authorCss);
});

test("ruby selection reveals original readings while preserving the original DOM and releasing listeners", () => {
	const marks = new Set<string>();
	const ruby = {
		nodeType: 1,
		toggleAttribute: (name: string, on?: boolean) => {
			const value = on ?? !marks.has(name);
			if (value) marks.add(name);
			else marks.delete(name);
		},
		removeAttribute: (name: string) => marks.delete(name),
	};
	const style = { textContent: "" };
	let selection = false;
	const doc = Object.assign(new EventTarget(), {
		getElementById: () => style,
		head: { prepend: () => {} },
		documentElement: { dataset: {} },
		querySelectorAll: (query: string) =>
			query === "ruby" || query === "*" ? [ruby] : [],
		getSelection: () => ({
			isCollapsed: !selection,
			toString: () => (selection ? "base" : ""),
			containsNode: () => true,
		}),
	});
	const cleanup = applyFramePresentation(doc as unknown as Document, "black", {
		...DEFAULT_BOOK_UI,
		ruby: "on-demand",
	});
	selection = true;
	doc.dispatchEvent(new Event("selectionchange"));
	assert.equal(marks.has("data-reader-ruby-selected"), true);
	selection = false;
	doc.dispatchEvent(new Event("selectionchange"));
	assert.equal(marks.has("data-reader-ruby-selected"), false);
	assert.match(style.textContent, /@media \(hover:hover\)/);
	assert.doesNotMatch(
		style.textContent,
		/display:\s*none|visibility:\s*hidden|filter:/,
	);
	cleanup();
	selection = true;
	doc.dispatchEvent(new Event("selectionchange"));
	assert.equal(marks.has("data-reader-ruby-selected"), false);
});

test("image fit preserves author small images and whole natural ratios under both viewport bounds", () => {
	assert.deepEqual(
		fitReaderImage(
			{ width: 1000, height: 2000 },
			{ width: 1000, height: 2000 },
			{ width: 800, height: 600 },
		),
		{ width: 300, height: 600 },
	);
	assert.deepEqual(
		fitReaderImage(
			{ width: 2000, height: 1000 },
			{ width: 2000, height: 1000 },
			{ width: 600, height: 800 },
		),
		{ width: 600, height: 300 },
	);
	assert.deepEqual(
		fitReaderImage(
			{ width: 200, height: 200 },
			{ width: 22, height: 22 },
			{ width: 760, height: 600 },
		),
		{ width: 22, height: 22 },
	);
	assert.deepEqual(
		fitReaderImage(
			{ width: 400, height: 800 },
			{ width: 500, height: 500 },
			{ width: 760, height: 600 },
		),
		{ width: 250, height: 500 },
	);
	assert.equal(
		fitReaderImage(
			{ width: 0, height: 800 },
			{ width: 500, height: 500 },
			{ width: 760, height: 600 },
		),
		null,
	);
});

test("image resize restores author declarations and measures viewport rather than its previous tiny frame", () => {
	const properties = new Map<string, [string, string]>([
		["width", ["50%", ""]],
	]);
	const imageStyle = {
		getPropertyValue: (name: string) => properties.get(name)?.[0] ?? "",
		getPropertyPriority: (name: string) => properties.get(name)?.[1] ?? "",
		setProperty: (name: string, value: string, priority = "") =>
			properties.set(name, [value, priority]),
		removeProperty: (name: string) => properties.delete(name),
	};
	const frame = { style: { width: "1px", height: "1px" } };
	const image = {
		style: imageStyle,
		naturalWidth: 1000,
		naturalHeight: 2000,
		parentElement: null,
	};
	const originalWidths: string[] = [];
	const win = {
		frameElement: frame,
		getComputedStyle: () => {
			originalWidths.push(imageStyle.getPropertyValue("width"));
			const width = Number.parseFloat(frame.style.width) * 0.5;
			return { width: String(width), height: String(width * 2) };
		},
	};
	const doc = { defaultView: win, images: [image], body: null };
	normalizeFrameImages(doc as unknown as Document, {
		width: 400,
		height: 1000,
	});
	assert.equal(imageStyle.getPropertyValue("width"), "200px");
	normalizeFrameImages(doc as unknown as Document, {
		width: 800,
		height: 1000,
	});
	assert.equal(imageStyle.getPropertyValue("width"), "400px");
	assert.deepEqual(originalWidths, ["50%", "50%"]);
	assert.deepEqual(frame.style, { width: "1px", height: "1px" });
});

function rubyTapHarness() {
	const marks = new Set<string>();
	const changes: string[] = [];
	const ruby = {
		nodeType: 1,
		closest: (selector: string): object | null =>
			selector === "ruby" ? ruby : null,
		toggleAttribute: (name: string, on?: boolean) => {
			if (on ?? !marks.has(name)) marks.add(name);
			else marks.delete(name);
			changes.push(name);
		},
		removeAttribute: (name: string) => marks.delete(name),
	};
	const doc = Object.assign(new EventTarget(), {
		getElementById: () => ({ textContent: "" }),
		head: { prepend: () => {} },
		documentElement: { dataset: {} },
		querySelectorAll: (query: string) =>
			query === "ruby[data-reader-ruby-open]"
				? marks.has("data-reader-ruby-open")
					? [ruby]
					: []
				: [ruby],
		getSelection: () => null,
	});
	const cleanup = applyFramePresentation(doc as unknown as Document, "white", {
		...DEFAULT_BOOK_UI,
		ruby: "on-demand",
	});
	const tap = () => {
		let up: Event | undefined;
		for (const type of ["pointerdown", "pointerup"]) {
			const event = new Event(type, { cancelable: true });
			Object.defineProperty(event, "target", { value: ruby });
			Object.assign(event, {
				clientX: 5,
				clientY: 5,
				pointerId: 1,
				button: 0,
				isPrimary: true,
				pointerType: "touch",
			});
			doc.dispatchEvent(event);
			if (type === "pointerup") up = event;
		}
		return up;
	};
	return { doc, marks, changes, cleanup, tap };
}

test("a later pointerup consumer preserves existing ruby state without any transient toggle", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = rubyTapHarness();
	h.marks.add("data-reader-ruby-open");
	h.changes.length = 0;
	h.doc.addEventListener("pointerup", (event) => event.preventDefault());
	assert.equal(h.tap()?.defaultPrevented, true);
	t.mock.timers.tick(1);
	assert.equal(h.marks.has("data-reader-ruby-open"), true);
	assert.deepEqual(h.changes, []);
	h.cleanup();
});

test("unconsumed ruby taps toggle once and teardown cancels a pending reveal", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = rubyTapHarness();
	h.tap();
	t.mock.timers.tick(1);
	assert.equal(h.marks.has("data-reader-ruby-open"), true);
	h.tap();
	t.mock.timers.tick(1);
	assert.equal(h.marks.has("data-reader-ruby-open"), false);
	h.tap();
	h.cleanup();
	t.mock.timers.tick(1);
	assert.equal(h.marks.has("data-reader-ruby-open"), false);
});
