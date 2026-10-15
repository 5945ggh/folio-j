import { useEffect, useState } from "react";

/** Shared with CSS through the Reader shell; retaining a view never delays its action. */
export const READER_EXIT_MS = 180;

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
export function useReaderPresence<T>(requested: T | null) {
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
		const timeout = window.setTimeout(() => setRetained(null), READER_EXIT_MS);
		return () => window.clearTimeout(timeout);
	}, [requested, reduced, retained]);
	return {
		value: requested ?? (reduced ? null : retained),
		exiting: requested === null && !reduced && retained !== null,
	};
}
