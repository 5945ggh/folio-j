export const INLINE_MOTION_MS = 260;
export const INLINE_MOTION_EASING = "cubic-bezier(.3,.15,.3,1)";

type Frame = { doc: Document; element: HTMLIFrameElement };
type Sample = {
	element: HTMLElement;
	top: number;
	height: number;
	frame?: Frame;
};
type Effect = {
	animation: Animation;
	restore: () => void;
	margin: boolean;
	awaitingCommit: boolean;
};
const overscan = 300;

/** Owns visual feedback and closing frame height; canonical text and position recovery stay with the caller. */
export class ReaderFlowMotion {
	private effects = new Set<Effect>();
	private pendingMargins = new Map<HTMLElement, number>();
	private generation = 0;
	private changing = false;
	private started: number | null = null;
	private frames: () => Iterable<Frame>;
	private root: () => HTMLElement | null;
	constructor(frames: () => Iterable<Frame>, root: () => HTMLElement | null) {
		this.frames = frames;
		this.root = root;
	}
	get running(): boolean {
		return this.effects.size > 0;
	}
	private begin(): void {
		const time = this.root()?.ownerDocument.timeline?.currentTime;
		this.started = typeof time === "number" ? time : null;
	}
	private align(animation: Animation): void {
		const time = animation.timeline?.currentTime;
		const reference = this.root()?.ownerDocument.timeline?.currentTime;
		if (
			this.started !== null &&
			typeof time === "number" &&
			typeof reference === "number"
		)
			// Each iframe has its own timeline origin; align elapsed time, not timestamps.
			animation.startTime = time - (reference - this.started);
	}
	/** CSS transitions retain precedence over author !important while sharing the flow clock. */
	synchronize(animations: readonly Animation[]): void {
		for (const animation of animations) {
			animation.effect?.updateTiming({ duration: INLINE_MOTION_MS });
			this.align(animation);
			if (
				/^(height|padding-top|padding-bottom)$/.test(
					(animation as CSSTransition).transitionProperty,
				)
			)
				this.holdGeometry(animation);
		}
	}
	private holdGeometry(animation: Animation, hold = false): void {
		if (
			Array.from(this.effects).some((effect) => effect.animation === animation)
		)
			return;
		const effect = {
			animation,
			restore: () => {},
			margin: false,
			awaitingCommit: false,
		};
		this.effects.add(effect);
		const generation = this.generation;
		animation.onfinish = () => {
			if (
				!hold &&
				generation === this.generation &&
				animation.playState === "finished" &&
				this.effects.has(effect)
			)
				this.cancelEffect(effect);
		};
	}
	private resizeFrame(
		element: HTMLIFrameElement,
		from: number,
		to: number,
		hold = false,
	): void {
		element.style.setProperty("height", `${to}px`);
		if (!element.animate || Math.abs(from - to) < 0.1) return;
		try {
			const animation = element.animate(
				[{ height: `${from}px` }, { height: `${to}px` }],
				{
					duration: INLINE_MOTION_MS,
					easing: INLINE_MOTION_EASING,
					fill: "both",
				},
			);
			this.align(animation);
			this.holdGeometry(animation, hold);
		} catch {
			// The underlying size already contains the final geometry.
		}
	}
	/** One requested geometry read sees canonical layout, even during visual motion. */
	measure<T>(read: () => T): T {
		const detached = Array.from(this.effects, (effect) => ({
			effect,
			keyframes: effect.animation.effect,
			time: effect.animation.currentTime,
		}));
		try {
			for (const { effect } of detached) effect.animation.effect = null;
			return read();
		} finally {
			for (const { effect, keyframes, time } of detached) {
				if (!this.effects.has(effect)) continue;
				effect.animation.effect = keyframes;
				if (effect.animation.currentTime !== time)
					effect.animation.currentTime = time;
			}
		}
	}
	private enabled(): boolean {
		const view = this.root()?.ownerDocument.defaultView;
		return (
			!!view && !view.matchMedia("(prefers-reduced-motion: reduce)").matches
		);
	}
	private margins(): Map<HTMLElement, number> {
		return new Map(
			Array.from(
				this.root()?.querySelectorAll<HTMLElement>(".reader-study-margin") ??
					[],
				(element) => [element, element.getBoundingClientRect().top],
			),
		);
	}
	private cancelEffect(effect: Effect): void {
		effect.animation.onfinish = null;
		effect.animation.cancel();
		effect.restore();
		this.effects.delete(effect);
	}
	private cancelEffects(preserveMargins = false): void {
		if (!preserveMargins) this.generation++;
		for (const effect of this.effects) {
			if (preserveMargins && effect.margin) {
				effect.awaitingCommit = true;
				continue;
			}
			this.cancelEffect(effect);
		}
	}
	/** No range geometry or descendant scan is needed for offscreen frames. */
	private samples(): Sample[] {
		const root = this.root();
		if (!root) return [];
		const viewport = root.getBoundingClientRect();
		const samples: Sample[] = [];
		for (const frame of this.frames()) {
			const outer = frame.element.getBoundingClientRect();
			samples.push({
				element: frame.element,
				top: outer.top,
				height: outer.height,
			});
			if (
				outer.bottom < viewport.top - overscan ||
				outer.top > viewport.bottom + overscan
			)
				continue;
			const targets = new Set<HTMLElement>();
			for (const leaf of frame.doc.querySelectorAll<HTMLElement>(
				"[data-locator-leaf],img[data-epub-image]",
			)) {
				// Paragraphs move as a unit, including their ruby annotations. A br-only
				// document instead keeps each existing inline child and its line wrapping.
				let target = leaf.closest<HTMLElement>("p,figure");
				if (!target) {
					target = leaf;
					while (
						target.parentElement &&
						!/^(BODY|DIV)$/.test(target.parentElement.tagName)
					)
						target = target.parentElement;
				}
				targets.add(target);
			}
			for (const element of targets) {
				// An image figure may also contain paragraph targets. Animate its
				// outer box once instead of adding the same displacement twice.
				let ancestor = element.parentElement;
				while (ancestor && !targets.has(ancestor))
					ancestor = ancestor.parentElement;
				if (ancestor) continue;
				const rect = element.getBoundingClientRect();
				const top = outer.top + rect.top;
				// Read this frame once, including candidates entering view after a long
				// translation shrinks. Only nearby before/after positions get effects.
				samples.push({ element, top, height: rect.height, frame });
			}
		}
		return samples;
	}
	private top(sample: Sample): number {
		return (
			sample.element.getBoundingClientRect().top +
			(sample.frame?.element.getBoundingClientRect().top ?? 0)
		);
	}
	private nearby(sample: Sample, after: number): boolean {
		const viewport = this.root()?.getBoundingClientRect();
		if (!viewport) return false;
		return [sample.top, after].some(
			(top) =>
				top + sample.height >= viewport.top - overscan &&
				top <= viewport.bottom + overscan,
		);
	}
	private play(
		element: HTMLElement,
		from: number,
		to: number,
		hold = false,
		margin = false,
	): void {
		if (Math.abs(from - to) < 0.1 || !element.isConnected || !element.animate)
			return;
		const view = element.ownerDocument.defaultView;
		if (!view) return;
		const css = view.getComputedStyle(element);
		const outerUi = element.ownerDocument === this.root()?.ownerDocument;
		if (
			!/^(static|relative)$/.test(css.position) &&
			!(outerUi && css.position === "absolute")
		)
			return;
		// Author transforms inside the resource may change the coordinate space.
		// Controlled outer UI uses translations to center the reader; those preserve
		// CSS-pixel displacement and must not disable whole-frame/margin motion.
		for (
			let ancestor: HTMLElement | null = element;
			ancestor;
			ancestor = ancestor.parentElement
		) {
			const style =
				ancestor === element ? css : view.getComputedStyle(ancestor);
			const allowTranslation = outerUi && ancestor !== element;
			const matrix = /^matrix\(([^)]+)\)$/
				.exec(style.transform ?? "")?.[1]
				?.split(",")
				.map(Number);
			const translated =
				allowTranslation &&
				matrix?.length === 6 &&
				matrix[0] === 1 &&
				matrix[1] === 0 &&
				matrix[2] === 0 &&
				matrix[3] === 1;
			if (
				(style.transform && style.transform !== "none" && !translated) ||
				(style.translate && style.translate !== "none" && !allowTranslation) ||
				(style.rotate && style.rotate !== "none") ||
				(style.scale && style.scale !== "none") ||
				(style.writingMode && style.writingMode !== "horizontal-tb")
			)
				return;
		}
		let restore = () => {};
		let keyframes: Keyframe[];
		if (/^(inline|ruby|ruby-base|ruby-text-container)$/.test(css.display)) {
			if (!/^(static|relative)$/.test(css.position)) return;
			const neutralInset = (value: string | undefined) =>
				!value || value === "auto" || Number.parseFloat(value) === 0;
			// Enabling relative positioning must not activate dormant author insets.
			// Important top also wins over WAAPI and would suppress this motion.
			if (
				element.style.getPropertyPriority("top") === "important" ||
				(css.position === "static" &&
					[css.top, css.right, css.bottom, css.left].some(
						(value) => !neutralInset(value),
					)) ||
				(css.position === "relative" &&
					css.top === "auto" &&
					!neutralInset(css.bottom)) ||
				(css.top &&
					css.top !== "auto" &&
					!/^-?(?:\d+\.?\d*|\.\d+)px$/.test(css.top) &&
					!neutralInset(css.top))
			)
				return;
			// Non-replaced inline boxes cannot transform. Relative positioning changes
			// only their paint position, leaving line boxes and native selection intact.
			const position = element.style.getPropertyValue("position");
			const priority = element.style.getPropertyPriority("position");
			const originalAttribute = element.getAttribute("style");
			const originalCssText = element.style.cssText;
			const base = Number.parseFloat(css.top) || 0;
			element.style.setProperty("position", "relative", "important");
			restore = () => {
				if (position) element.style.setProperty("position", position, priority);
				else element.style.removeProperty("position");
				// CSSOM may normalize author whitespace/order while changing position.
				// Restore exact markup only when nobody changed another declaration.
				if (element.style.cssText === originalCssText) {
					if (originalAttribute === null) element.removeAttribute("style");
					else element.setAttribute("style", originalAttribute);
				} else if (originalAttribute === null && !element.getAttribute("style"))
					element.removeAttribute("style");
			};
			keyframes = [{ top: `${base + from}px` }, { top: `${base + to}px` }];
		} else {
			keyframes = [
				{ transform: `translateY(${from}px)`, composite: "add" },
				{ transform: `translateY(${to}px)`, composite: "add" },
			];
		}
		try {
			const animation = element.animate(keyframes, {
				duration: INLINE_MOTION_MS,
				easing: INLINE_MOTION_EASING,
				fill: "both",
			});
			this.align(animation);
			const effect = { animation, restore, margin, awaitingCommit: false };
			this.effects.add(effect);
			const generation = this.generation;
			animation.onfinish = () => {
				if (
					hold ||
					effect.awaitingCommit ||
					generation !== this.generation ||
					animation.playState !== "finished" ||
					!this.effects.delete(effect)
				)
					return;
				animation.cancel();
				restore();
			};
		} catch {
			restore();
		}
	}
	change<T>(
		update: () => T,
		growth?: () => {
			node: HTMLElement;
			fromHeight: number;
			fullHeight: number;
		} | null,
	): T {
		if (!this.enabled()) {
			this.clear();
			return update();
		}
		const before = this.samples();
		this.pendingMargins = this.margins();
		this.cancelEffects(true);
		const canonical = new Map(
			before.map((sample) => [sample.element, this.top(sample)]),
		);
		let result: T;
		this.changing = true;
		try {
			result = update();
		} finally {
			this.changing = false;
		}
		this.begin();
		const growing = growth?.();
		if (growing) {
			const frame = Array.from(this.frames()).find(
				(item) => item.doc === growing.node.ownerDocument,
			);
			const sizes = before
				.filter((sample) => !sample.frame)
				.map((sample) => {
					const element = sample.element as HTMLIFrameElement;
					const measured = Number.parseFloat(
						element.style.getPropertyValue("height"),
					);
					const fallback =
						element === frame?.element
							? sample.height + growing.fullHeight - growing.fromHeight
							: element.getBoundingClientRect().height;
					return {
						element,
						from: sample.height,
						to: Math.max(32, Number.isFinite(measured) ? measured : fallback),
					};
				});
			// Other frames can still be completing the preceding target's height.
			// Restore every actual starting size before taking residual top samples.
			for (const size of sizes)
				this.resizeFrame(size.element, size.from, size.to);
			this.synchronize(growing.node.getAnimations());
		}
		// Growth now exposes its actual starting layout: native node/frame heights
		// account for the new space, so only unrelated residual motion needs FLIP.
		const after = new Map(
			before.map((sample) => [sample.element, this.top(sample)]),
		);
		const frameFrom = new Map<HTMLIFrameElement, number>();
		for (const sample of before) {
			if (sample.frame || !sample.element.isConnected) continue;
			const delta = sample.top - (after.get(sample.element) ?? sample.top);
			frameFrom.set(sample.element as HTMLIFrameElement, delta);
			this.play(sample.element, delta, 0);
		}
		for (const sample of before) {
			if (!sample.frame) continue;
			const finalTop = after.get(sample.element) ?? sample.top;
			if (this.nearby(sample, finalTop))
				this.play(
					sample.element,
					sample.top - finalTop - (frameFrom.get(sample.frame.element) ?? 0),
					0,
				);
		}
		// An idempotent reopen may not trigger a React commit. Retarget its retained
		// margin immediately rather than holding a finished effect indefinitely.
		if (
			!growing &&
			!before.some(
				(sample) =>
					Math.abs(
						(canonical.get(sample.element) ?? 0) -
							(after.get(sample.element) ?? 0),
					) >= 0.1,
			)
		)
			this.marginsChanged();
		return result;
	}
	collapse(
		node: HTMLElement,
		fullHeight = node.getBoundingClientRect().height,
	): void {
		if (!this.enabled()) return;
		const before = this.samples();
		const margins = this.margins();
		const height = node.getBoundingClientRect().height;
		const frame = Array.from(this.frames()).find(
			(item) => item.doc === node.ownerDocument,
		);
		if (!frame || height <= 0) return;
		this.cancelEffects();
		const boundary =
			frame.element.getBoundingClientRect().top +
			node.getBoundingClientRect().top;
		const marginCanonical = new Map(
			Array.from(margins.keys(), (element) => [
				element,
				element.getBoundingClientRect().top,
			]),
		);
		const sizes = before
			.filter((sample) => !sample.frame)
			.map((sample) => {
				const element = sample.element as HTMLIFrameElement;
				const underlying = element.getBoundingClientRect().height;
				return {
					element,
					from: sample.height,
					to: Math.max(
						32,
						underlying - (element === frame.element ? fullHeight : 0),
					),
				};
			});
		const closing = sizes.find((size) => size.element === frame.element);
		this.begin();
		const frameFrom = new Map<HTMLIFrameElement, number>();
		// Commit the final underlying size first. Cancelling or disposing the height
		// effect then exposes the collapsed geometry instead of restoring a gap.
		for (const size of sizes)
			this.resizeFrame(size.element, size.from, size.to, true);
		// Cancelling old geometry exposes its full target. Re-establish the actual
		// starting sizes first so subsequent frame/child residuals do not count the
		// same height change a second time.
		const canonical = new Map(
			before.map((sample) => [sample.element, this.top(sample)]),
		);
		for (const sample of before) {
			if (sample.frame) continue;
			const from = sample.top - (canonical.get(sample.element) ?? sample.top);
			frameFrom.set(sample.element as HTMLIFrameElement, from);
			this.play(sample.element, from, 0, true);
		}
		for (const sample of before) {
			if (!sample.frame) continue;
			const ownFrame = sample.frame.element;
			const finalTop = canonical.get(sample.element) ?? sample.top;
			const displacement =
				ownFrame === frame.element &&
				node.compareDocumentPosition(sample.element) & 4
					? -height
					: frame.element.compareDocumentPosition(ownFrame) & 4
						? (closing?.to ?? 0) - (closing?.from ?? 0)
						: 0;
			if (this.nearby(sample, finalTop + displacement))
				this.play(
					sample.element,
					sample.top - finalTop - (frameFrom.get(ownFrame) ?? 0),
					0,
					true,
				);
		}
		for (const [element, top] of margins) {
			const canonical = marginCanonical.get(element) ?? top;
			this.play(
				element,
				top - canonical,
				canonical >= boundary ? -fullHeight : 0,
				true,
				true,
			);
		}
	}
	beforeRemove(): void {
		if (!this.changing) this.pendingMargins = this.margins();
		this.cancelEffects(true);
	}
	marginsChanged(): void {
		const pending = this.pendingMargins;
		this.pendingMargins = new Map();
		if (!this.enabled()) {
			this.clear();
			return;
		}
		if (!pending.size) return;
		for (const effect of this.effects)
			if (effect.margin) this.cancelEffect(effect);
		for (const [element, top] of pending)
			if (element.isConnected)
				this.play(
					element,
					top - element.getBoundingClientRect().top,
					0,
					false,
					true,
				);
	}
	clear(): void {
		this.cancelEffects();
		this.pendingMargins.clear();
		this.started = null;
	}
}
