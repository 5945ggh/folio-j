import { useLayoutEffect, useRef } from "react";
import { SelectionActions } from "../selection/SelectionActions";
import { getSpeechController } from "../speech/browser";

export type SelectedText = { text: string; anchor: DOMRect };

/** Keep the selection inside one displayed original, context, or Markdown block. */
export function readSegmentSelection(
	surface: Element | null,
): SelectedText | null {
	const selection = document.getSelection();
	if (
		!surface ||
		!selection ||
		selection.isCollapsed ||
		selection.rangeCount !== 1
	)
		return null;
	const range = selection.getRangeAt(0);
	const start = range.startContainer;
	const element = (
		start instanceof Element ? start : start.parentElement
	)?.closest(".segment-selection-text,.segment-analyses .analysis-markdown");
	if (
		!element ||
		!surface.contains(element) ||
		element.closest("dialog") !== surface.closest("dialog") ||
		element.closest("[inert]") ||
		!element.contains(range.endContainer)
	)
		return null;
	const text = selection.toString();
	return text.trim() ? { text, anchor: range.getBoundingClientRect() } : null;
}

export function SegmentSelectionToolbar({
	selection,
	onLookup,
	onDismiss,
}: {
	selection: SelectedText;
	onLookup?: () => void;
	onDismiss: () => void;
}) {
	const toolbar = useRef<HTMLDivElement>(null);
	const { anchor, text } = selection;
	const canLookup = Boolean(onLookup);
	// biome-ignore lint/correctness/useExhaustiveDependencies: The lookup button changes the width.
	useLayoutEffect(() => {
		const element = toolbar.current;
		if (!element) return;
		const { offsetWidth, offsetHeight } = element;
		const body = element
			.closest(".segment-material-dialog")
			?.querySelector(".segment-material-body")
			?.getBoundingClientRect();
		const topLimit = Math.max(0, body?.top ?? 0) + 8;
		const bottomLimit =
			Math.min(window.innerHeight, body?.bottom ?? window.innerHeight) - 8;
		const leftLimit = Math.max(0, body?.left ?? 0) + 8;
		const rightLimit =
			Math.min(window.innerWidth, body?.right ?? window.innerWidth) - 8;
		const below = anchor.bottom + 6;
		const top =
			below + offsetHeight <= bottomLimit
				? below
				: anchor.top - offsetHeight - 6;
		element.style.left = `${Math.max(leftLimit, Math.min(rightLimit - offsetWidth, anchor.left))}px`;
		element.style.top = `${Math.max(topLimit, Math.min(bottomLimit - offsetHeight, top))}px`;
	}, [anchor, canLookup]);
	return (
		<SelectionActions
			className="segment-selection-toolbar"
			ref={toolbar}
			lookupLabel="查所选文字"
			onLookup={onLookup}
			onSpeak={() => {
				getSpeechController().play({
					id: "segment-selection",
					label: "片段选区",
					text,
				});
				onDismiss();
			}}
		/>
	);
}
