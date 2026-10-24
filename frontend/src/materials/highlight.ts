import type { Projection } from "./dom";
import { rawOffset } from "./position.ts";
import { subtractMarkIntervals } from "./record-mark-ranges.ts";

const searchOpacity = new WeakMap<Document, number>();
const searchForeground = new WeakMap<Document, string>();

/** Highlight pseudo-elements are repainted per frame rather than relying on CSS transitions. */
export function setSearchHighlightOpacity(doc: Document, value: number): void {
	const opacity = Math.min(1, Math.max(0, value));
	searchOpacity.set(doc, opacity);
	const style = doc.getElementById("folio-search-style");
	if (style)
		style.textContent = `::highlight(folio-search){background:rgb(233 203 105 / ${opacity});color:color-mix(in srgb,#171717 ${opacity * 100}%,${searchForeground.get(doc) ?? "#282828"});}`;
}

/** Theme presentation can change without reprojecting the active source range. */
export function refreshSearchHighlightForeground(doc: Document): void {
	const view = doc.defaultView as
		| (Window & { CSS?: { highlights?: Map<string, unknown> } })
		| null;
	if (!view?.CSS?.highlights?.has("folio-search")) return;
	if (doc.body && view.getComputedStyle)
		searchForeground.set(doc, view.getComputedStyle(doc.body).color);
	setSearchHighlightOpacity(doc, searchOpacity.get(doc) ?? 1);
}

/** CSS Highlight paints existing ranges; locator leaves and native selections stay intact. */
function projectedRanges(
	doc: Document,
	projection: Projection,
	start: number,
	end: number,
	baseOnly = false,
) {
	const begin = rawOffset(projection.raw, start),
		finish = rawOffset(projection.raw, end);
	const first = projection.entries.find((e) => e.end > begin);
	const last = projection.entries.find(
		(e) => e.end >= finish && e.start < finish,
	);
	if (!first || !last) throw new Error("搜索命中无法映射到原文。");
	const ranges: Range[] = [];
	if (
		baseOnly ||
		projection.entries.some((entry) =>
			entry.node.parentElement?.closest("ruby"),
		)
	) {
		for (const entry of projection.entries) {
			if (entry.end <= begin || entry.start >= finish) continue;
			const range = doc.createRange();
			range.setStart(entry.node, Math.max(0, begin - entry.start));
			range.setEnd(
				entry.node,
				Math.min(entry.node.length, finish - entry.start),
			);
			ranges.push(range);
		}
	} else {
		const range = doc.createRange();
		range.setStart(first.node, begin - first.start);
		range.setEnd(last.node, finish - last.start);
		ranges.push(range);
	}
	return ranges;
}

/** Validate all local intervals before committing a chapter's highlights. */
export function prepareHighlights(
	doc: Document,
	projection: Projection,
	intervals: readonly { start: number; end: number }[],
): () => void {
	if (!intervals.length) throw new Error("没有可高亮的原文范围。");
	const ranges = intervals.flatMap(({ start, end }) => {
		if (start < 0 || end <= start) throw new Error("原文范围无效。");
		return projectedRanges(doc, projection, start, end);
	});
	const view = doc.defaultView as
		| (Window & {
				Highlight?: new (...ranges: Range[]) => unknown;
				CSS?: { highlights?: Map<string, unknown> };
		  })
		| null;
	if (!view?.Highlight || !view.CSS?.highlights)
		throw new Error("已定位到原文，当前浏览器不支持搜索高亮。");
	const Highlight = view.Highlight;
	const highlights = view.CSS.highlights;
	return () => {
		highlights.set("folio-search", new Highlight(...ranges));
		let style = doc.getElementById("folio-search-style");
		if (!style) {
			style = doc.createElement("style");
			style.id = "folio-search-style";
			doc.head.append(style);
		}
		// Chromium resolves nested highlight currentColor to the highlight itself.
		// Capture the actual source color once per projection, including theme reflows.
		const source = ranges[0]?.startContainer?.parentElement ?? doc.body;
		if (source && view.getComputedStyle)
			searchForeground.set(doc, view.getComputedStyle(source).color);
		setSearchHighlightOpacity(doc, searchOpacity.get(doc) ?? 1);
	};
}

/** Existing single-range search callers use the same complete projection path. */
export function highlightRange(
	doc: Document,
	projection: Projection,
	start: number,
	end: number,
): void {
	prepareHighlights(doc, projection, [{ start, end }])();
}

/** Navigation feedback ends independently of persistent study and translation marks. */
export function clearSearchHighlights(
	doc: Document,
	removeStyle = false,
): void {
	const view = doc.defaultView as
		| (Window & { CSS?: { highlights?: Map<string, unknown> } })
		| null;
	view?.CSS?.highlights?.delete("folio-search");
	searchOpacity.delete(doc);
	searchForeground.delete(doc);
	if (removeStyle) doc.getElementById("folio-search-style")?.remove?.();
}

/** Split at locator text nodes so annotations never join study decoration or hit geometry. */
export function projectedBaseRanges(
	doc: Document,
	projection: Projection,
	start: number,
	end: number,
): Range[] {
	if (start < 0 || end <= start) throw new Error("原文范围无效。");
	return projectedRanges(doc, projection, start, end, true);
}

export function clearStudyHighlights(doc: Document, removeStyle = false): void {
	const view = doc.defaultView as
		| (Window & { CSS?: { highlights?: Map<string, unknown> } })
		| null;
	view?.CSS?.highlights?.delete("folio-study");
	view?.CSS?.highlights?.delete("folio-study-active");
	view?.CSS?.highlights?.delete("folio-translation");
	view?.CSS?.highlights?.delete("folio-translation-active");
	if (removeStyle) doc.getElementById("folio-study-style")?.remove?.();
}

/** Base ranges stay within one locator node, including ruby bases and UTF-16 boundaries. */
export function uncoveredStudyRanges(
	doc: Document,
	ranges: readonly Range[],
	covered: readonly Range[],
): Range[] {
	const nodes = new Set(ranges.map((range) => range.startContainer));
	return [...nodes].flatMap((node) =>
		subtractMarkIntervals(
			ranges
				.filter((range) => range.startContainer === node)
				.map((range) => ({ start: range.startOffset, end: range.endOffset })),
			covered
				.filter((range) => range.startContainer === node)
				.map((range) => ({ start: range.startOffset, end: range.endOffset })),
		).map(({ start, end }) => {
			const range = doc.createRange();
			range.setStart(node, start);
			range.setEnd(node, end);
			return range;
		}),
	);
}

export function prepareStudyUnderlines(
	doc: Document,
	ranges: readonly Range[],
	active: readonly Range[],
	theme: "white" | "black",
	translations: readonly Range[] = [],
	activeTranslations: readonly Range[] = [],
): () => void {
	const view = doc.defaultView as
		| (Window & {
				Highlight?: new (...ranges: Range[]) => unknown;
				CSS?: { highlights?: Map<string, unknown> };
		  })
		| null;
	if (!view?.Highlight || !view.CSS?.highlights)
		throw new Error("当前浏览器无法显示学习片段标记。");
	const Highlight = view.Highlight,
		registry = view.CSS.highlights;
	return () => {
		if (ranges.length) registry.set("folio-study", new Highlight(...ranges));
		else registry.delete("folio-study");
		if (active.length)
			registry.set("folio-study-active", new Highlight(...active));
		else registry.delete("folio-study-active");
		if (translations.length)
			registry.set("folio-translation", new Highlight(...translations));
		else registry.delete("folio-translation");
		if (activeTranslations.length)
			registry.set(
				"folio-translation-active",
				new Highlight(...activeTranslations),
			);
		else registry.delete("folio-translation-active");
		let style = doc.getElementById("folio-study-style");
		if (!style) {
			style = doc.createElement("style");
			style.id = "folio-study-style";
			doc.head.append(style);
		}
		const red = theme === "black" ? "#ff9993" : "#c73535";
		const translationRed = `${red}b3`;
		style.textContent = `::highlight(folio-study){text-decoration-line:underline;text-decoration-style:solid;text-decoration-color:${red};text-decoration-thickness:1px;text-underline-offset:2px;text-underline-position:under left;}::highlight(folio-study-active){text-decoration-line:underline;text-decoration-style:solid;text-decoration-color:${red};text-decoration-thickness:2px;text-underline-offset:2px;text-underline-position:under left;}::highlight(folio-translation){text-decoration-line:underline;text-decoration-style:dashed;text-decoration-color:${translationRed};text-decoration-thickness:1px;text-underline-offset:2px;text-underline-position:under left;}::highlight(folio-translation-active){text-decoration-line:underline;text-decoration-style:dashed;text-decoration-color:${red};text-decoration-thickness:2px;text-underline-offset:2px;text-underline-position:under left;}`;
	};
}
