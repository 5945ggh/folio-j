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
	restore: (
		anchor: A | null,
		initialPresentation: boolean,
	) => false | (() => void);
};
/** Coordinates stable sampling and synchronous DOM layout across resource callbacks. */
export class ReaderLayout<A> {
	private recovery = new ViewportRecovery();
	private pending: A | null;
	private presented: A | null;
	private surface: LayoutSurface<A> | null = null;
	private ready = new Set<number>();
	private appliedGeometry: string | null = null;
	private presentedGeneration: number | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	constructor(anchor: A | null) {
		this.pending = anchor;
		this.presented = null;
	}
	canSample(size: ViewportSize): boolean {
		return this.recovery.canSample(size);
	}
	anchor(capture: () => A | null): A | null {
		return anchorBeforeLayout(this.recovery.restoring, this.pending, capture);
	}
	/** Navigation targets are provisional until successfully sampled after presentation. */
	presentedAnchor(capture: () => A | null): A | null {
		if (!this.recovery.restoring) this.presented = capture() ?? this.presented;
		return this.presented;
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
	): A | null {
		const anchor = this.recovery.observe(size, capture);
		if (!this.recovery.canSample(size)) {
			this.cancelSave();
			return null;
		}
		if (!anchor) return null;
		this.cancelSave();
		this.pending = anchor;
		this.presented = anchor;
		this.timer = setTimeout(() => {
			this.timer = null;
			save(anchor);
		}, 550);
		return anchor;
	}
	commit(
		surface: LayoutSurface<A>,
		presentation: () => void,
		update: () => void,
		stabilize?: () => void,
	): void {
		const paintOnly =
			this.surface?.generation === surface.generation &&
			this.appliedGeometry === surface.geometry &&
			!this.recovery.restoring;
		// Settle old visual geometry before replacing the surface or sampling its anchor.
		// Ordinary reflow() also drives inline animations and must not run this preparation.
		if (!paintOnly) stabilize?.();
		if (this.surface?.generation !== surface.generation) {
			this.ready.clear();
			this.appliedGeometry = null;
			this.recovery.invalidate();
		}
		this.surface = surface;
		if (paintOnly) {
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
		const restored = surface.restore(
			this.pending,
			this.presentedGeneration !== surface.generation,
		);
		if (restored === false) return;
		const currentSize = surface.size();
		if (
			this.surface !== surface ||
			!currentSize ||
			!this.recovery.finish(pass, currentSize)
		)
			return;
		this.presentedGeneration = surface.generation;
		restored();
	}
}
