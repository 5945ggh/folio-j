import type { BrowserHarness } from "./harness";

export const animationFrame = () =>
	new Promise<number>((resolve) => requestAnimationFrame(resolve));

export async function animationFrames(count: number) {
	for (let index = 0; index < count; index++) await animationFrame();
}

/** Read the painted output, including the native CSS clip transition. */
export function inlineVisualState(
	node: HTMLElement | null,
	expandedHeight = 0,
) {
	if (!node) return { opacity: 0, reveal: 0, height: 0, visibleHeight: 0 };
	const height = node.getBoundingClientRect().height;
	const css = getComputedStyle(node);
	const insets = css.clipPath.match(/^inset\(([^)]+)\)/)?.[1]?.split(/\s+/);
	const bottom = insets?.[2] ?? insets?.[0];
	const clipped = bottom
		? Number.parseFloat(bottom) / (bottom.endsWith("%") ? 100 : height || 1)
		: 0;
	const visibleHeight = height * (1 - clipped);
	return {
		opacity: Number(css.opacity),
		reveal: visibleHeight / (expandedHeight || 1),
		height,
		visibleHeight,
	};
}

/** Include outer iframe transforms and original-document effects in settling. */
export function readerAnimations(
	container: HTMLElement,
	documents: Document[],
) {
	return [
		...container.getAnimations({ subtree: true }),
		...documents.flatMap((doc) => doc.getAnimations()),
	];
}

/** Pause real production effects and seek their common elapsed clock, without rAF sampling. */
export function pauseReaderAnimations(
	container: HTMLElement,
	documents: Document[],
) {
	const effects = readerAnimations(container, documents);
	const clocks = effects.map((effect) => Number(effect.currentTime ?? 0));
	const ends = effects.map((effect) =>
		Number(effect.effect?.getComputedTiming().endTime ?? 0),
	);
	const reference = clocks[0] ?? 0;
	for (const effect of effects) effect.pause();
	return {
		effects,
		clockSpread: effects.length ? Math.max(...clocks) - Math.min(...clocks) : 0,
		// A shared duration is part of the synchronization contract; values may change.
		durationSpread: effects.length ? Math.max(...ends) - Math.min(...ends) : 0,
		seek(progress: number) {
			const time = (ends[0] ?? 0) * progress;
			for (const [index, effect] of effects.entries())
				effect.currentTime = time + (clocks[index] ?? reference) - reference;
		},
		resume() {
			for (const effect of effects) effect.play();
		},
	};
}

export async function settleInline(
	h: BrowserHarness,
	doc: Document,
	predicate: () => boolean,
	message: string,
) {
	const check: BrowserHarness["check"] = h.check;
	let previous = "";
	let stable = 0;
	const started = performance.now();
	while (performance.now() - started < 3000) {
		await animationFrame();
		const geometry = JSON.stringify(
			[
				...doc.querySelectorAll("p,[data-reader-inline-translation]"),
				...h.container.querySelectorAll("iframe.material-part"),
			].map((node) => {
				const rect = node.getBoundingClientRect();
				return [rect.top, rect.height, getComputedStyle(node).opacity];
			}),
		);
		const settled =
			predicate() && readerAnimations(h.container, [doc]).length === 0;
		stable = settled && previous === geometry ? stable + 1 : 0;
		previous = geometry;
		if (stable >= 3) return;
	}
	check(false, message);
}
