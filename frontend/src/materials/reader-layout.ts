import { anchorBeforeLayout } from "./position.ts";
import { ViewportRecovery, type ViewportSize } from "./viewport.ts";

type LayoutSurface<A> = {
	generation: number;
	parts: number;
	geometry: string;
	size: () => ViewportSize | null;
	capture: () => A | null;
	measure: () => void;
	// Return false if the DOM is unavailable; run completion only after the recovery ticket finishes.
	restore: (anchor: A | null) => false | (() => void);
};
/** Coordinates stable sampling and synchronous DOM layout across resource callbacks. */
export class ReaderLayout<A> {
	private recovery = new ViewportRecovery();
	private pending: A | null;
	private surface: LayoutSurface<A> | null = null;
	private ready = new Set<number>();
	private appliedGeometry: string | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	constructor(anchor: A | null) {
		this.pending = anchor;
	}
	canSample(size: ViewportSize): boolean {
		return this.recovery.canSample(size);
	}
	anchor(capture: () => A | null): A | null {
		return anchorBeforeLayout(this.recovery.restoring, this.pending, capture);
	}
	setAnchor(anchor: A | null): void {
		this.cancelSave();
		this.pending = anchor;
		this.recovery.invalidate();
	}
	invalidateSurface(): void {
		this.cancelSave();
		this.surface = null;
		this.ready.clear();
		this.appliedGeometry = null;
		this.recovery.invalidate();
	}
	cancelSave(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
	observe(
		size: ViewportSize,
		capture: () => A | null,
		save: (anchor: A) => void,
	): void {
		const anchor = this.recovery.observe(size, capture);
		if (!this.recovery.canSample(size)) {
			this.cancelSave();
			return;
		}
		if (!anchor) return;
		this.cancelSave();
		this.pending = anchor;
		this.timer = setTimeout(() => {
			this.timer = null;
			save(anchor);
		}, 550);
	}
	commit(
		surface: LayoutSurface<A>,
		presentation: () => void,
		update: () => void,
	): void {
		if (this.surface?.generation !== surface.generation) {
			this.ready.clear();
			this.appliedGeometry = null;
			this.recovery.invalidate();
		}
		this.surface = surface;
		if (this.appliedGeometry === surface.geometry && !this.recovery.restoring) {
			presentation();
			return;
		}
		this.reflow(update);
	}
	resourcesReady(generation: number, index: number): void {
		const surface = this.surface;
		if (
			!surface ||
			surface.generation !== generation ||
			index < 0 ||
			index >= surface.parts ||
			this.ready.has(index)
		)
			return;
		this.ready.add(index);
		if (this.ready.size === surface.parts) this.reflow();
	}
	reflow(update?: () => void): void {
		const surface = this.surface;
		const size = surface?.size();
		if (!surface || !size) return;
		this.pending = this.anchor(surface.capture);
		this.cancelSave();
		const pass = this.recovery.begin(size);
		update?.();
		surface.measure();
		this.appliedGeometry = surface.geometry;
		if (
			this.ready.size !== surface.parts ||
			this.surface !== surface ||
			!this.recovery.canFinish(pass, surface.size() ?? size)
		)
			return;
		const restored = surface.restore(this.pending);
		if (restored === false) return;
		const currentSize = surface.size();
		if (
			this.surface !== surface ||
			!currentSize ||
			!this.recovery.finish(pass, currentSize)
		)
			return;
		restored();
	}
}
