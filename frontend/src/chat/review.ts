import type { AnalysisDetail } from "../analysis/api";
import type { Job } from "./api";

type Operation = Record<string, unknown>;

function asOperation(value: unknown): Operation | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Operation)
		: null;
}

function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function proposedSection(value: unknown): string {
	const item = asOperation(value);
	if (!item) return "";
	return [string(item.title) && `## ${string(item.title)}`, string(item.body)]
		.filter(Boolean)
		.join("\n\n");
}

export function describeReview(
	proposal: Job["review_proposal"],
	base?: AnalysisDetail,
): { title: string; target: string; before: string; after: string } | null {
	if (!proposal) return null;
	const operation = asOperation(proposal.operation);
	if (!operation) return null;
	const kind = string(operation.kind);
	const sid = string(operation.sid);
	const afterSid = string(operation.after_sid);
	const section = base?.sections.find((item) =>
		[item.id, item.uid, item.handle].includes(sid),
	);
	const anchor = base?.sections.find((item) =>
		[item.id, item.uid, item.handle].includes(afterSid),
	);
	switch (kind) {
		case "update_section":
			return {
				title: "修改小节",
				target: section?.title ?? "未命名小节",
				before: proposal.before || section?.raw || "（无）",
				after: proposal.after || proposedSection(operation) || "（空内容）",
			};
		case "insert_sections":
			return {
				title: "插入小节",
				target: afterSid
					? `位于「${anchor?.title ?? "指定小节"}」之后`
					: "位于文档开头",
				before: proposal.before || "（原位置为空）",
				after:
					proposal.after ||
					(Array.isArray(operation.sections)
						? operation.sections
								.map(proposedSection)
								.filter(Boolean)
								.join("\n\n")
						: "（无法预览拟插入内容）"),
			};
		case "delete_section":
			return {
				title: "删除小节",
				target: section?.title ?? "未命名小节",
				before: proposal.before || section?.raw || "（无）",
				after: "（删除此小节）",
			};
		case "update_preamble":
			return {
				title: "修改开头内容",
				target: "文档开头",
				before:
					proposal.before ||
					base?.sections.find((item) => item.kind === "preamble")?.raw ||
					"（无）",
				after: proposal.after || string(operation.body) || "（清空）",
			};
		default:
			return null;
	}
}
