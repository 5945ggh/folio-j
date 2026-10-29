import type { ContextCopyPreferences } from "../settings/context-copy-api.ts";
import type { Chapter } from "./api.ts";
import type { MaterialProvenance } from "./study-api.ts";
import { prefillContext } from "./study-context.ts";

export type { ContextCopyPreferences } from "../settings/context-copy-api.ts";

export const DEFAULT_CONTEXT_COPY: ContextCopyPreferences = {
	before_sentences: 3,
	after_sentences: 0,
	before_characters: 200,
	after_characters: 200,
	include_source: true,
};

/** Verify the exact target and build a local copy without saving learning content. */
export function buildContextCopy(
	chapter: Chapter,
	reference: MaterialProvenance,
	preferences: ContextCopyPreferences,
	bookTitle: string,
): { text: string; beforeTruncated: boolean; afterTruncated: boolean } {
	const context = prefillContext(chapter, reference, {
		...preferences,
		enabled: true,
	});
	const blocks: string[] = [];
	if (preferences.include_source) {
		const title = bookTitle.trim();
		const source = [
			title
				? title.startsWith("《") && title.endsWith("》")
					? title
					: `《${title}》`
				: "",
			chapter.title.trim(),
		]
			.filter(Boolean)
			.join("／");
		if (source) blocks.push(`出处：${source}`);
	}
	const target = reference.ranges
		.map((range) => range.exact)
		.join("")
		.normalize("NFC");
	blocks.push(`目标原文：\n${target}`);
	if (context.before)
		blocks.push(
			`前文${context.beforeTruncated ? "（已截断）" : ""}：\n${context.before}`,
		);
	if (context.after)
		blocks.push(
			`后文${context.afterTruncated ? "（已截断）" : ""}：\n${context.after}`,
		);
	return {
		text: blocks.join("\n\n"),
		beforeTruncated: context.beforeTruncated,
		afterTruncated: context.afterTruncated,
	};
}
