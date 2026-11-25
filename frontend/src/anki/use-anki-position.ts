import { type RefObject, useLayoutEffect, useState } from "react";
import { clampReaderCardPosition } from "../materials/reader-card-drag";
import type { ScreenAnchor } from "../materials/reader-study";
import { useReaderCardDrag } from "../materials/use-reader-card-drag";

const formWidth = 378;
const expandedWidth = 748;
const margin = 12;

function viewportSize() {
	return { width: window.innerWidth, height: window.innerHeight };
}

export function useAnkiPosition(
	card: RefObject<HTMLElement | null>,
	anchor: ScreenAnchor,
	referenceOpen: boolean,
) {
	const [viewport, setViewport] = useState(viewportSize);
	const [manual, setManual] = useState<{ right: number; top: number } | null>(
		null,
	);
	const [height, setHeight] = useState(500);
	useLayoutEffect(() => {
		function resize() {
			setViewport(viewportSize());
		}
		window.addEventListener("resize", resize);
		const node = card.current;
		const observer = new ResizeObserver(() => {
			if (node) setHeight(node.offsetHeight);
		});
		if (node) observer.observe(node);
		return () => {
			window.removeEventListener("resize", resize);
			observer.disconnect();
		};
	}, [card]);
	const narrow = viewport.width <= 780;
	const rightLimit = viewport.width - margin;
	// Choose the form edge once for either width. The reference pane grows to its left.
	const rightOfSelection = anchor.right + 18 + formWidth;
	const leftOfSelection = anchor.left - 18;
	const initialRight =
		rightOfSelection <= rightLimit ? rightOfSelection : leftOfSelection;
	const right = Math.min(
		rightLimit,
		Math.max(
			formWidth + margin,
			manual?.right ?? Math.max(expandedWidth + margin, initialRight),
		),
	);
	const singlePane = narrow || right < expandedWidth + margin;
	const dualPane = referenceOpen && !singlePane;
	const width = dualPane ? expandedWidth : formWidth;
	const bounds = {
		left: margin,
		right: rightLimit - width,
		top: 56,
		bottom: viewport.height - margin,
	};
	const top = clampReaderCardPosition(
		{ left: right - width, top: manual?.top ?? anchor.top - 24 },
		bounds,
		height,
	).top;
	const positionStyle = narrow
		? undefined
		: { right: viewport.width - right, top };
	const visualWidth = () =>
		card.current?.getBoundingClientRect().width ?? width;
	const drag = useReaderCardDrag(
		card,
		!narrow,
		(point) => {
			const currentWidth = visualWidth();
			return clampReaderCardPosition(
				point,
				{
					...bounds,
					left: margin + Math.max(0, width - currentWidth),
					right: rightLimit - currentWidth,
				},
				height,
			);
		},
		(point) => {
			setManual({ right: point.left + visualWidth(), top: point.top });
		},
	);
	return { drag, narrow, singlePane, dualPane, positionStyle };
}
