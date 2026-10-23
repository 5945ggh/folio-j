export type ViewportSize = { width: number; height: number };
export type LayoutPass = { ticket: number; size: ViewportSize };
export function viewportSize(
	element: Pick<HTMLElement, "clientWidth" | "clientHeight">,
): ViewportSize {
	return { width: element.clientWidth, height: element.clientHeight };
}
type ReadingBounds = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/** Prefer the frame containing the reading edge and never select an empty trailing part. */
export function readingFrameDistance(
	rect: ReadingBounds,
	viewport: ReadingBounds,
	vertical: boolean,
	contentEnd: number | null,
	chapterEndReached = false,
): number | null {
	if (contentEnd === null) return null;
	const start = vertical ? rect.left : rect.top;
	const end = vertical ? rect.right : rect.bottom;
	const low = vertical ? viewport.left : viewport.top;
	const high = vertical ? viewport.right : viewport.bottom;
	if (start >= high || end <= low) {
		// A direct jump into a long blank tail must still obtain a real resume anchor.
		const passed = vertical ? start >= high : end <= low;
		if (!chapterEndReached || !passed) return null;
	}
	const edge = vertical ? high : low;
	return Math.max(0, start - edge, edge - end);
}

/** The last readable content must fit before the toolbar, without requiring a scroll through trailing whitespace. */
export function atChapterEnd(
	contentEnd: number | null,
	viewport: Pick<ReadingBounds, "left" | "bottom">,
	vertical: boolean,
): boolean {
	const edge = vertical ? viewport.left : viewport.bottom;
	if (
		contentEnd === null ||
		!Number.isFinite(contentEnd) ||
		!Number.isFinite(edge)
	)
		return false;
	return vertical ? contentEnd >= edge - 1 : contentEnd <= edge + 1;
}

/** Move only far enough to reveal the end after restoring a saved chapter-end anchor. */
export function chapterEndAdjustment(
	contentEnd: number | null,
	viewport: Pick<ReadingBounds, "left" | "bottom">,
	vertical: boolean,
): number {
	const edge = vertical ? viewport.left : viewport.bottom;
	if (
		contentEnd === null ||
		!Number.isFinite(contentEnd) ||
		!Number.isFinite(edge)
	)
		return 0;
	return vertical
		? Math.min(0, contentEnd - edge)
		: Math.max(0, contentEnd - edge);
}
/** Stable reading edges exclude overlay gutters; layout recovery still tracks the outer client size. */
export function readingViewport(
	element: Pick<
		HTMLElement,
		"clientWidth" | "clientHeight" | "getBoundingClientRect"
	>,
	style: Pick<CSSStyleDeclaration, "paddingTop" | "paddingBottom"> &
		Partial<Pick<CSSStyleDeclaration, "paddingLeft" | "paddingRight">>,
) {
	const rect = element.getBoundingClientRect();
	const top = Number.parseFloat(style.paddingTop) || 0;
	const bottom = Number.parseFloat(style.paddingBottom) || 0;
	const left = Number.parseFloat(style.paddingLeft ?? "0") || 0;
	const right = Number.parseFloat(style.paddingRight ?? "0") || 0;
	return {
		left: rect.left + left,
		right: rect.right - right,
		top: rect.top + top,
		bottom: rect.bottom - bottom,
		width: Math.max(0, element.clientWidth - left - right),
		height: Math.max(0, element.clientHeight - top - bottom),
	};
}
function same(a: ViewportSize | null, b: ViewportSize): boolean {
	return a !== null && a.width === b.width && a.height === b.height;
}
/** Owns the stable-layout boundary shared by scroll, delayed resize and restoration. */
export class ViewportRecovery {
	restoring = true;
	private stable: ViewportSize | null = null;
	private ticket = 0;
	canSample(size: ViewportSize): boolean {
		return !this.restoring && same(this.stable, size);
	}
	observe<T>(size: ViewportSize, sample: () => T | null): T | null {
		if (!same(this.stable, size)) {
			this.restoring = true;
			return null;
		}
		return this.restoring ? null : sample();
	}
	begin(size: ViewportSize): LayoutPass {
		this.restoring = true;
		return { ticket: ++this.ticket, size: { ...size } };
	}
	canFinish(pass: LayoutPass, size: ViewportSize): boolean {
		return pass.ticket === this.ticket && same(pass.size, size);
	}
	finish(pass: LayoutPass, size: ViewportSize): boolean {
		if (!this.canFinish(pass, size)) return false;
		this.stable = { ...size };
		this.restoring = false;
		return true;
	}
	invalidate(): void {
		this.restoring = true;
		this.ticket++;
	}
}
