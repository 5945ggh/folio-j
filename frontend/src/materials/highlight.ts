import type { Projection } from "./dom";
import { rawOffset } from "./position.ts";
/** CSS Highlight paints existing ranges; locator leaves and native selections stay intact. */
export function highlightRange(
	doc: Document,
	projection: Projection,
	start: number,
	end: number,
) {
	const begin = rawOffset(projection.raw, start),
		finish = rawOffset(projection.raw, end);
	const first = projection.entries.find((e) => e.end > begin);
	const last = projection.entries.find(
		(e) => e.end >= finish && e.start < finish,
	);
	if (!first || !last) throw new Error("搜索命中无法映射到原文。");
	const range = doc.createRange();
	range.setStart(first.node, begin - first.start);
	range.setEnd(last.node, finish - last.start);
	const view = doc.defaultView as
		| (Window & {
				Highlight?: new (...ranges: Range[]) => unknown;
				CSS?: { highlights?: Map<string, unknown> };
		  })
		| null;
	if (!view?.Highlight || !view.CSS?.highlights)
		throw new Error("已定位到原文，当前浏览器不支持搜索高亮。");
	if (view?.Highlight && view.CSS?.highlights) {
		view.CSS.highlights.set("folio-search", new view.Highlight(range));
		let style = doc.getElementById("folio-search-style");
		if (!style) {
			style = doc.createElement("style");
			style.id = "folio-search-style";
			doc.head.append(style);
		}
		style.textContent =
			"::highlight(folio-search){background:#e9cb69;color:#171717;}";
	}
}
