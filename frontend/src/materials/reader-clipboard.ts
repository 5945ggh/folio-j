import type { Projection } from "./dom.ts";
import { inlineTranslationInRange } from "./inline-translation.ts";

/** Copy selected base text, including compiled line breaks, without changing the native selection. */
export function copyReaderSelection(
	doc: Document,
	projection: Projection,
	event: ClipboardEvent,
): void {
	const selection = doc.getSelection();
	if (
		event.defaultPrevented ||
		!event.clipboardData ||
		!selection ||
		selection.isCollapsed ||
		!selection.rangeCount
	)
		return;
	const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
		selection.getRangeAt(index),
	);
	if (
		ranges.some(
			(range) =>
				!doc.body.contains(range.startContainer) ||
				!doc.body.contains(range.endContainer),
		)
	)
		return;
	// A translation-only selection owns its own plain-text copy; mixed selections
	// continue through canonical leaves so translation can never join source copy.
	const translation =
		ranges.length === 1 && ranges[0]
			? inlineTranslationInRange(doc, ranges[0])
			: null;
	if (
		translation &&
		ranges.every(
			(range) =>
				translation.contains(range.startContainer) &&
				translation.contains(range.endContainer),
		)
	) {
		event.preventDefault();
		event.clipboardData.clearData();
		event.clipboardData.setData("text/plain", selection.toString());
		return;
	}
	const text = ranges
		.map((range) =>
			projection.entries
				.filter(({ node }) => range.intersectsNode(node))
				.map(({ node }) =>
					node.data.slice(
						range.startContainer === node ? range.startOffset : 0,
						range.endContainer === node ? range.endOffset : node.length,
					),
				)
				.join(""),
		)
		.join("\n");
	// Annotation-only selections must not fall back to copying rt/rp.
	event.preventDefault();
	if (text) {
		event.clipboardData.clearData();
		event.clipboardData.setData("text/plain", text);
	}
}
