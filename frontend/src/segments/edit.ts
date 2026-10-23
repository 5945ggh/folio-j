import type { Segment, SegmentFields } from "../content.ts";

export const segmentEditFields = [
	["context_before", "前文"],
	["text", "目标原文"],
	["context_after", "后文"],
	["translation", "译文"],
	["transcription", "听写"],
	["source_ref", "出处说明"],
	["note", "个人管理备注"],
] as const;

/** Compare with the opening snapshot even after a newer revision is confirmed. */
export function changedSegmentFields(
	fields: SegmentFields,
	initial: Segment,
): Partial<SegmentFields> {
	const changes: Partial<SegmentFields> = {};
	for (const [name] of segmentEditFields) {
		if (name === "text" && initial.text_locked_at) continue;
		if (fields[name] !== initial[name]) changes[name] = fields[name];
	}
	return changes;
}
