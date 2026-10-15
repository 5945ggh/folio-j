import type { components } from "../api/schema";

type Position = Omit<
	components["schemas"]["ReadingPositionUpdate"],
	"expected_revision"
>;
export type JumpOriginPolicy = "preserve" | "replace";

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
