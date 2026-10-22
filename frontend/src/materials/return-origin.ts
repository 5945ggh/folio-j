export function returnOriginLabel(
	title: string,
	progress: number | null,
): string {
	return `返回“${title}${progress === null ? "" : ` ${Math.round(progress * 100)}%`}”`;
}

export const JUMP_READING_POLICY = {
	minimumViewports: 1,
	minimumDurationMs: 5_000,
	inputWindowMs: 800,
	maximumMovementGapMs: 120_000,
} as const;

/** Detects sustained reading without owning or consuming the UI's return point. */
export class JumpReadingSession {
	#offset: number | null = null;
	#sampledAt: number | null = null;
	#inputAt: number | null = null;
	#candidate: {
		viewports: number;
		startedAt: number;
		movedAt: number;
	} | null = null;
	#shouldReplace = false;

	get shouldReplace(): boolean {
		return this.#shouldReplace;
	}

	input(now: number): void {
		this.#inputAt = Number.isFinite(now) ? now : null;
	}

	/** The caller normalizes either writing direction to a forward-positive axis. */
	sample(offset: number, viewport: number, now: number): void {
		const previousOffset = this.#offset;
		const previousTime = this.#sampledAt;
		this.#offset = Number.isFinite(offset) ? offset : null;
		this.#sampledAt = Number.isFinite(now) ? now : null;
		if (this.#shouldReplace) return;
		if (
			this.#offset === null ||
			this.#sampledAt === null ||
			!Number.isFinite(viewport) ||
			viewport <= 0 ||
			(previousTime !== null && now < previousTime) ||
			(this.#inputAt !== null && now < this.#inputAt)
		) {
			this.#candidate = null;
			this.#inputAt = null;
			return;
		}
		if (
			previousOffset === null ||
			previousTime === null ||
			this.#inputAt === null ||
			now - this.#inputAt > JUMP_READING_POLICY.inputWindowMs
		)
			return;
		const movement = (offset - previousOffset) / viewport;
		if (!Number.isFinite(movement) || movement === 0) return;
		if (
			this.#candidate &&
			now - this.#candidate.movedAt > JUMP_READING_POLICY.maximumMovementGapMs
		)
			this.#candidate = null;
		if (!this.#candidate) {
			if (movement > 0)
				this.#candidate = {
					viewports: movement,
					startedAt: now,
					movedAt: now,
				};
			return;
		}
		this.#candidate.viewports += movement;
		this.#candidate.movedAt = now;
		if (this.#candidate.viewports <= 0) {
			this.#candidate = null;
			return;
		}
		this.#shouldReplace =
			movement > 0 &&
			this.#candidate.viewports >= JUMP_READING_POLICY.minimumViewports &&
			now - this.#candidate.startedAt >= JUMP_READING_POLICY.minimumDurationMs;
	}

	pause(): void {
		this.#offset = null;
		this.#sampledAt = null;
		this.#inputAt = null;
		this.#candidate = null;
	}

	reset(): void {
		this.pause();
		this.#shouldReplace = false;
	}
}
