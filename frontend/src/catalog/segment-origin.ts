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
		return [{ kind: "reference", text: reference || "手动录入" }];
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
					text: `本章约 ${summary.chapter_percent}%`,
				});
			if (!parts.length) parts.push({ kind: "reference", text: "书籍出处" });
			break;
		}
		case "material_deleted":
			parts = [
				{ kind: "title", text: title || "原书" },
				{ kind: "state", text: "原书已删除" },
			];
			break;
		case "version_unavailable":
			parts = [
				{ kind: "title", text: title || "书籍出处" },
				{ kind: "state", text: "原书版本已变更" },
			];
			break;
		case "snapshot_mismatch":
			parts = [
				{ kind: "title", text: title || "书籍出处" },
				{ kind: "state", text: "原文已变动，无法定位" },
			];
			break;
		case "invalid_reference":
			parts = [
				{ kind: "title", text: title || "书籍出处" },
				{ kind: "state", text: "无法定位到原文" },
			];
			break;
		default:
			parts = [{ kind: "state", text: "出处暂不可用" }];
	}
	const origin = parts.map((part) => part.text).join(" · ");
	if (reference && reference !== title && reference !== origin)
		parts.push({ kind: "supplement", text: `补充：${reference}` });
	return parts;
}
