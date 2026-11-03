import type { ContextCopyPreferences } from "./context-copy-api.ts";

export type BudgetField = Exclude<
	keyof ContextCopyPreferences,
	"include_source"
>;
export type ContextCopyFields = {
	[Key in BudgetField]: string;
} & Pick<ContextCopyPreferences, "include_source">;

export function copyFields(value: ContextCopyPreferences): ContextCopyFields {
	return {
		before_sentences: String(value.before_sentences),
		after_sentences: String(value.after_sentences),
		before_characters: String(value.before_characters),
		after_characters: String(value.after_characters),
		include_source: value.include_source,
	};
}

export function parseCopyFields(
	fields: ContextCopyFields,
): ContextCopyPreferences | null {
	const budget = (value: string) =>
		/^\d+$/.test(value) && Number(value) <= 100000 ? Number(value) : NaN;
	const preferences: ContextCopyPreferences = {
		before_sentences: budget(fields.before_sentences),
		after_sentences: budget(fields.after_sentences),
		before_characters: budget(fields.before_characters),
		after_characters: budget(fields.after_characters),
		include_source: fields.include_source,
	};
	return Object.values(preferences).some(
		(value) => typeof value === "number" && Number.isNaN(value),
	)
		? null
		: preferences;
}
