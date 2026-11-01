import type { CatalogSegment } from "./api.ts";

type OriginSegment = Pick<
	CatalogSegment,
	"material_provenance" | "provenance_summary" | "source_ref"
>;
type OriginPart = {
	kind: "title" | "chapter" | "position" | "state" | "supplement" | "reference";
	text: string;
};

export function segmentOriginParts(segment: OriginSegment): OriginPart[] {
	const reference = segment.source_ref.trim();
	const summary = segment.provenance_summary;
	if (!segment.material_provenance && (!summary || summary.status === "none"))
		return [{ kind: "reference", text: reference || "未保存出处" }];
	const title = summary?.title?.trim() ?? "";
	let parts: OriginPart[];
	switch (summary?.status) {
		case "resolved": {
			const chapter = summary.chapter_title?.trim() ?? "";
			parts = [];
			if (summary.chapter_percent === undefined && summary.display) {
				// An older response only has a formatted location. Keep it intact.
				parts.push({ kind: "reference", text: summary.display });
				break;
			}
			if (title) parts.push({ kind: "title", text: title });
			if (chapter) parts.push({ kind: "chapter", text: chapter });
			if (summary.chapter_percent != null)
				parts.push({
					kind: "position",
					text: `章内约 ${summary.chapter_percent}%`,
				});
			if (!parts.length) parts.push({ kind: "reference", text: "材料出处" });
			break;
		}
		case "material_deleted":
			parts = [
				{ kind: "title", text: title || "原材料" },
				{ kind: "state", text: "材料已删除" },
			];
			break;
		case "version_unavailable":
			parts = [
				{ kind: "title", text: title || "材料出处" },
				{ kind: "state", text: "材料版本不可用" },
			];
			break;
		case "snapshot_mismatch":
			parts = [
				{ kind: "title", text: title || "材料出处" },
				{ kind: "state", text: "原文快照不一致" },
			];
			break;
		case "invalid_reference":
			parts = [
				{ kind: "title", text: title || "材料出处" },
				{ kind: "state", text: "无法精确定位" },
			];
			break;
		default:
			parts = [{ kind: "state", text: "材料出处待核对" }];
	}
	const origin = parts.map((part) => part.text).join(" · ");
	if (reference && reference !== title && reference !== origin)
		parts.push({ kind: "supplement", text: `出处补充：${reference}` });
	return parts;
}

export function segmentOriginLabel(segment: OriginSegment): string {
	return segmentOriginParts(segment)
		.map((part) => part.text)
		.join(" · ");
}
