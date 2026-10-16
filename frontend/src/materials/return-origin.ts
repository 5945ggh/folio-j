import type { components } from "../api/schema";

type Position = Omit<
	components["schemas"]["ReadingPositionUpdate"],
	"expected_revision"
>;
export type JumpOriginPolicy = "preserve" | "replace";

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

/** Only a stable viewport at its physical start is already at the chapter beginning. */
export function atChapterStart(offset: number, stable: boolean): boolean {
	return stable && Number.isFinite(offset) && Math.abs(offset) <= 1;
}

export function samePosition(left: Position | null, right: Position): boolean {
	if (
		!left ||
		left.version_id !== right.version_id ||
		left.chapter_id !== right.chapter_id ||
		left.part_index !== right.part_index ||
		left.resource_id !== right.resource_id ||
		left.kind !== right.kind
	)
		return false;
	return left.kind === "text"
		? left.offset === right.offset
		: left.image_id === right.image_id &&
				(left.image_progress ?? 0) === (right.image_progress ?? 0);
}

/** An explicit chapter-start jump offers undo for this action; an exact repeat keeps that undo point. */
export function jumpOrigin(
	previous: Position | null,
	presented: Position | null,
	target: Position,
	policy: JumpOriginPolicy,
	chapterStartPresented?: boolean,
): { jump: boolean; origin: Position | null } {
	if (
		policy === "replace" &&
		(chapterStartPresented === undefined
			? samePosition(presented, target)
			: chapterStartPresented &&
				presented?.version_id === target.version_id &&
				presented.chapter_id === target.chapter_id)
	)
		return { jump: false, origin: previous };
	return {
		jump: true,
		origin: policy === "replace" ? presented : (previous ?? presented),
	};
}
