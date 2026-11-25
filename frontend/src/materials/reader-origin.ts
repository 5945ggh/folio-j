import type { Chapter, Position, Settings } from "./api.ts";
import { referenceParts } from "./reader-selection.ts";
import type { MaterialProvenance, SegmentProvenance } from "./study-api.ts";

/** Exact record navigation uses verified chapter coordinates, never reading-recovery guesses. */
export function recordOriginPosition(
	reference: MaterialProvenance,
	chapter: Chapter,
	settings: Settings,
): Position {
	if (
		reference.contract_version !== "1" ||
		reference.material_id !== chapter.material_id ||
		reference.version_id !== chapter.version_id
	)
		throw new Error("本书版本已变化，无法定位原文。");
	const mapped = referenceParts(chapter, reference.ranges);
	const first = mapped.entries().next().value;
	if (!first) throw new Error("出处定位信息无效，无法定位原文。");
	const [index, intervals] = first;
	const part = chapter.parts[index];
	const interval = intervals[0];
	if (!part || !interval) throw new Error("出处定位信息无效，无法定位原文。");
	return {
		version_id: reference.version_id,
		chapter_id: chapter.id,
		part_index: index,
		resource_id: part.resource_id,
		kind: "text",
		offset: part.start + interval.start,
		at_chapter_end: false,
		settings,
	};
}

export function originFailure(origin: SegmentProvenance): string | null {
	switch (origin.status) {
		case "resolved":
			return null;
		case "material_deleted":
			return "原书已删除，无法跳转回原文。";
		case "version_unavailable":
			return "原书版本已变更，无法跳转回原文。";
		case "snapshot_mismatch":
			return "原文内容已变更，无法精确定位。";
		case "none":
			return "该片段未关联书籍出处。";
		default:
			return "出处定位信息无效，无法定位原文。";
	}
}

export function originPosition(
	origin: SegmentProvenance,
	settings: Settings,
): Position {
	const failure = originFailure(origin);
	const range = origin.material_provenance?.ranges[0];
	const part = origin.parts?.find((item) => item.range_index === 0);
	if (
		failure ||
		!origin.material_provenance ||
		!origin.chapter_id ||
		!range ||
		!part
	)
		throw new Error(failure ?? "出处定位信息无效，无法定位原文。");
	return {
		version_id: origin.material_provenance.version_id,
		chapter_id: origin.chapter_id,
		part_index: part.part_index,
		resource_id: range.resource_id,
		kind: "text",
		offset: range.start,
		at_chapter_end: false,
		settings,
	};
}
