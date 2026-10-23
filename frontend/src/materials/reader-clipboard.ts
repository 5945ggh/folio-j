import type { Projection } from "./dom.ts";

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
