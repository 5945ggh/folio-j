import type { Position, Settings } from "./api.ts";
import type { SegmentProvenance } from "./study-api.ts";

export function originFailure(origin: SegmentProvenance): string | null {
	switch (origin.status) {
		case "resolved":
			return null;
		case "material_deleted":
			return "原材料已删除，保留了历史原文，当前无法返回原处。";
		case "version_unavailable":
			return "出处绑定的材料版本不可用，当前无法返回原处。";
		case "snapshot_mismatch":
			return "出处与材料原文快照不一致，无法精确定位。";
		case "none":
			return "这个片段没有材料出处。";
		default:
			return "出处契约或范围无法校验，当前无法精确定位。";
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
		throw new Error(failure ?? "出处缺少完整的定位范围。");
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
