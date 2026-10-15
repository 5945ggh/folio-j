import type { Position } from "./api";

export type PendingReturn = { generation: number; target: Position };
/** A return consumes its origin only after the current surface locates that exact target. */
export function returnWasLocated(
	intent: PendingReturn,
	generation: number,
	anchor: Position | null,
	located: boolean,
): boolean {
	const target = intent.target;
	return (
		located &&
		intent.generation === generation &&
		anchor !== null &&
		target.version_id === anchor.version_id &&
		target.chapter_id === anchor.chapter_id &&
		target.part_index === anchor.part_index &&
		target.resource_id === anchor.resource_id &&
		target.kind === anchor.kind &&
		(target.kind === "text"
			? target.offset === anchor.offset
			: target.image_id === anchor.image_id)
	);
}
