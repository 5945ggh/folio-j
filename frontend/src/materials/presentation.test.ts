import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import {
	applyFramePresentation,
	fitReaderImage,
	normalizeFrameImages,
} from "./presentation.ts";

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
