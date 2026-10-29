import type { Chapter } from "./api.ts";
import type { PreferenceStorage } from "./preferences.ts";
import type { MaterialProvenance } from "./study-api.ts";
import { type ContextBudget, prefillContext } from "./study-context.ts";

export type ContextCopyPreferences = Omit<ContextBudget, "enabled"> & {
	include_source: boolean;
};

export const DEFAULT_CONTEXT_COPY: ContextCopyPreferences = {
	before_sentences: 3,
	after_sentences: 0,
	before_characters: 200,
	after_characters: 200,
	include_source: true,
};
export const CONTEXT_COPY_KEY = "folio-reader-context-copy-v1";

function storage(): PreferenceStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function budgetValue(value: unknown, fallback: number): number {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 100000
		? value
		: fallback;
}

export function normalizeContextCopyPreferences(
	input: unknown,
): ContextCopyPreferences {
	const value =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {};
	return {
		before_sentences: budgetValue(
			value.before_sentences,
			DEFAULT_CONTEXT_COPY.before_sentences,
		),
		after_sentences: budgetValue(
			value.after_sentences,
			DEFAULT_CONTEXT_COPY.after_sentences,
		),
		before_characters: budgetValue(
			value.before_characters,
			DEFAULT_CONTEXT_COPY.before_characters,
		),
		after_characters: budgetValue(
			value.after_characters,
			DEFAULT_CONTEXT_COPY.after_characters,
		),
		include_source:
			typeof value.include_source === "boolean"
				? value.include_source
				: DEFAULT_CONTEXT_COPY.include_source,
	};
}

export function readContextCopyPreferences(
	store = storage(),
): ContextCopyPreferences {
	try {
		return normalizeContextCopyPreferences(
			JSON.parse(store?.getItem(CONTEXT_COPY_KEY) ?? "null"),
		);
	} catch {
		return { ...DEFAULT_CONTEXT_COPY };
	}
}

export function writeContextCopyPreferences(
	value: ContextCopyPreferences,
	store = storage(),
): boolean {
	try {
		if (!store) return false;
		store.setItem(
			CONTEXT_COPY_KEY,
			JSON.stringify(normalizeContextCopyPreferences(value)),
		);
		return true;
	} catch {
		return false;
	}
}

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
