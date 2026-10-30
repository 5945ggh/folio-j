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
			// Strip only the exact, separately supplied names: titles may contain separators.
			let location = summary.display?.trim() ?? "";
			for (const name of [title, chapter]) {
				if (!name) continue;
				if (location === name) location = "";
				else if (location.startsWith(`${name} · `))
					location = location.slice(name.length + 3);
			}
			parts = [];
			if (title) parts.push({ kind: "title", text: title });
			if (chapter) parts.push({ kind: "chapter", text: chapter });
			if (location) {
				if (/^章内约 \d+%$/.test(location))
					parts.push({ kind: "position", text: location });
				else
					parts = [
						{
							kind: "reference",
							text: summary.display?.trim() || title || "材料出处",
						},
					];
			}
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
