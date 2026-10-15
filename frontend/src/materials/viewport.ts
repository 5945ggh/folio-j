export type ViewportSize = { width: number; height: number };
export type LayoutPass = { ticket: number; size: ViewportSize };
export function viewportSize(
	element: Pick<HTMLElement, "clientWidth" | "clientHeight">,
): ViewportSize {
	return { width: element.clientWidth, height: element.clientHeight };
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
