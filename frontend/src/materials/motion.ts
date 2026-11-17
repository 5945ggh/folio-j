import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/** Shared with CSS through the Reader shell; retaining a view never delays its action. */
export const READER_EXIT_MS = 180;
export const DICTIONARY_POPOVER_MOTION_MS = 130;

/** Closing sibling layers restore their trigger without taking focus from other tools. */
export function restoreReaderPanelFocus(
	node: HTMLElement,
	previous: Element | null,
) {
	const active = document.activeElement;
	const activePanel = active?.closest<HTMLElement>("[data-reader-panel-side]");
	const closingSibling =
		node.dataset.exiting === "true" &&
		activePanel?.dataset.exiting === "true" &&
		activePanel.dataset.readerPanelSide === node.dataset.readerPanelSide;
	if (!node.contains(active) && active !== document.body && !closingSibling)
		return;
	if (
		previous instanceof HTMLElement &&
		previous.isConnected &&
		previous !== document.body &&
		!previous.closest("[inert]")
	) {
		previous.focus({ preventScroll: true });
		return;
	}
	const underlying = Array.from(
		document.querySelectorAll<HTMLElement>("[data-reader-panel-side]"),
	).find(
		(panel) =>
			panel !== node &&
			panel.dataset.readerPanelSide === node.dataset.readerPanelSide &&
			panel.getAttribute("aria-hidden") !== "true" &&
			!panel.closest("[inert]"),
	);
	underlying
		?.querySelector<HTMLElement>(".reader-panel-close")
		?.focus({ preventScroll: true });
}

/** Keep only the departing view briefly; reopening cancels its removal. */
export function useReaderPresence<T>(
	requested: T | null,
	durationMs = READER_EXIT_MS,
) {
	const [retained, setRetained] = useState<T | null>(requested);
	const [reduced, setReduced] = useState(
		() => matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	useEffect(() => {
		const media = matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (requested !== null || reduced) {
			if (retained !== requested) setRetained(requested);
			return;
		}
		if (retained === null) return;
		const timeout = window.setTimeout(() => setRetained(null), durationMs);
		return () => window.clearTimeout(timeout);
	}, [requested, reduced, retained, durationMs]);
	return {
		value: requested ?? (reduced ? null : retained),
		exiting: requested === null && !reduced && retained !== null,
	};
}

function shiftRect(rect: DOMRect, x: number) {
	return new DOMRect(rect.left + x, rect.top, rect.width, rect.height);
}

/** Animate between the compact popover and its expanded reading sidebar. */
export function useExpandFlipMotion(
	element: RefObject<HTMLElement | null>,
	expanded: boolean,
	settled: boolean,
	active = true,
) {
	const previousExpanded = useRef(expanded);
	const settledRect = useRef<DOMRect | null>(null);
	const pendingFrom = useRef<DOMRect | null>(null);
	const animation = useRef<Animation | null>(null);

	useEffect(() => () => animation.current?.cancel(), []);

	useLayoutEffect(() => {
		const node = element.current;
		if (!node || !active) {
			animation.current?.cancel();
			animation.current = null;
			previousExpanded.current = expanded;
			pendingFrom.current = null;
			settledRect.current = null;
			return;
		}
		let offsetX = 0;
		if (
			animation.current &&
			animation.current.playState !== "idle" &&
			animation.current.playState !== "finished"
		) {
			const transform = getComputedStyle(node).transform;
			if (transform !== "none") offsetX = new DOMMatrixReadOnly(transform).m41;
		}
		if (previousExpanded.current !== expanded) {
			previousExpanded.current = expanded;
			const from = settledRect.current;
			pendingFrom.current = from && shiftRect(from, offsetX);
			animation.current?.cancel();
			animation.current = null;
			offsetX = 0;
		}
		if (!settled) return;
		const nextRect = node.getBoundingClientRect();
		// Keep the layout bounds separate from any transform still being painted.
		settledRect.current = offsetX ? shiftRect(nextRect, -offsetX) : nextRect;
		if (pendingFrom.current) {
			const from = pendingFrom.current;
			pendingFrom.current = null;
			if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
				const dx = from.left - nextRect.left;
				if (expanded && nextRect.height >= from.height) {
					const topInset = Math.max(0, from.top - nextRect.top);
					const bottomInset = Math.max(0, nextRect.bottom - from.bottom);
					if (Math.abs(dx) > 1 || topInset > 1 || bottomInset > 1) {
						animation.current = node.animate(
							[
								{
									transform: `translateX(${dx}px)`,
									clipPath: `inset(${topInset}px 0 ${bottomInset}px 0 round 12px)`,
								},
								{
									transform: "none",
									clipPath: "inset(0 0 0 0 round 12px)",
								},
							],
							{
								duration: READER_EXIT_MS,
								easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
							},
						);
					}
				} else {
					const hasHorizontalShift = Math.abs(dx) > 1;
					animation.current = node.animate(
						[
							{
								transform: hasHorizontalShift ? `translateX(${dx}px)` : "none",
								opacity: 0.88,
							},
							{
								transform: "none",
								opacity: 1,
							},
						],
						{
							duration: READER_EXIT_MS,
							easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
						},
					);
				}
			}
		}
	});
}
