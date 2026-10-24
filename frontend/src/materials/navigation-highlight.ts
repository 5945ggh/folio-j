const HIGHLIGHT_DURATION = 2500;
export const NAVIGATION_HIGHLIGHT_FADE_MS = 260;

type Schedule = (callback: () => void, delay: number) => () => void;
type FadeOptions = {
	opacity: (value: number) => void;
	reducedMotion?: () => boolean;
	now?: () => number;
	frame?: (callback: () => void) => () => void;
};
const scheduleTimeout: Schedule = (callback, delay) => {
	const timer = setTimeout(callback, delay);
	return () => clearTimeout(timer);
};
const scheduleFrame = (callback: () => void) => {
	const frame = requestAnimationFrame(callback);
	return () => cancelAnimationFrame(frame);
};

/** A navigation hint gets one visible interval; reflows never renew or revive it. */
export class NavigationHighlightLifetime {
	private active = false;
	private started = false;
	private fading = false;
	private revision = 0;
	private cancelTimer: (() => void) | undefined;
	private cancelFrame: (() => void) | undefined;
	private readonly expire: () => void;
	private readonly schedule: Schedule;
	private readonly fade: FadeOptions | undefined;

	constructor(
		expire: () => void,
		schedule: Schedule = scheduleTimeout,
		fade?: FadeOptions,
	) {
		this.expire = expire;
		this.schedule = schedule;
		this.fade = fade;
	}

	/** Accepting a new target cancels the previous target's deadline and fade. */
	replace(): void {
		this.dispose();
		this.active = true;
		this.fade?.opacity(1);
	}

	/** Call only after successful stable presentation, including after a retry. */
	presented(): void {
		if (!this.active || this.started || this.fading) return;
		this.started = true;
		const revision = this.revision;
		this.cancelTimer = this.schedule(() => {
			if (revision === this.revision) this.clear();
		}, HIGHLIGHT_DURATION);
	}

	/** Input/expiration fade; a navigation boundary can request immediate removal. */
	clear(immediate = false): void {
		if (!this.active) return;
		const fade = this.fade;
		const reduced = fade?.reducedMotion
			? fade.reducedMotion()
			: typeof matchMedia !== "undefined" &&
				matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (immediate || !this.started || !fade || reduced) {
			this.dispose();
			this.expire();
			return;
		}
		if (this.fading) return;
		this.fading = true;
		this.cancelTimer?.();
		const revision = this.revision;
		const now = fade.now ?? (() => performance.now());
		const frame = fade.frame ?? scheduleFrame;
		const start = now();
		const update = () => {
			if (revision !== this.revision) return;
			const elapsed = Math.max(0, now() - start);
			const progress = Math.min(1, elapsed / NAVIGATION_HIGHLIGHT_FADE_MS);
			fade.opacity(1 - progress);
			if (progress < 1) this.cancelFrame = frame(update);
			else {
				this.dispose();
				this.expire();
			}
		};
		this.cancelFrame = frame(update);
	}

	/** Cancel on teardown without calling a potentially unmounted consumer. */
	dispose(): void {
		this.revision++;
		this.active = false;
		this.started = false;
		this.fading = false;
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		this.cancelFrame?.();
		this.cancelFrame = undefined;
	}
}
