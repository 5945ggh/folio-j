import type {
	ContextCopyPreferences,
	ContextCopySettings,
	ContextCopySettingsUpdate,
} from "./context-copy-api.ts";

export type BudgetField = Exclude<
	keyof ContextCopyPreferences,
	"include_source"
>;
export type ContextCopyFields = {
	[Key in BudgetField]: string;
} & Pick<ContextCopyPreferences, "include_source">;

export type ContextCopyDraft = {
	fields: ContextCopyFields;
	baseline: ContextCopySettings;
	latest: ContextCopySettings;
	conflict: boolean;
};

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

export function createCopyDraft(
	settings: ContextCopySettings,
): ContextCopyDraft {
	return {
		fields: copyFields(settings),
		baseline: settings,
		latest: settings,
		conflict: false,
	};
}

export function copyDraftDirty(draft: ContextCopyDraft) {
	return (
		JSON.stringify(draft.fields) !== JSON.stringify(copyFields(draft.baseline))
	);
}

export function editCopyDraft(
	draft: ContextCopyDraft,
	fields: ContextCopyFields,
): ContextCopyDraft {
	return { ...draft, fields };
}

export function receiveCopySettings(
	draft: ContextCopyDraft,
	settings: ContextCopySettings,
): ContextCopyDraft {
	if (settings.revision <= draft.latest.revision) return draft;
	if (copyDraftDirty(draft) || draft.conflict)
		return { ...draft, latest: settings };
	return createCopyDraft(settings);
}

/** An explicit reload can retain inputs while adopting a new CAS revision. */
export function reloadCopyDraft(
	draft: ContextCopyDraft,
	settings: ContextCopySettings,
	keepChanges: boolean,
): ContextCopyDraft {
	const latest =
		settings.revision < draft.latest.revision ? draft.latest : settings;
	return {
		...createCopyDraft(latest),
		fields: keepChanges ? draft.fields : copyFields(latest),
	};
}

export function copyDraftRequest(
	draft: ContextCopyDraft,
): ContextCopySettingsUpdate | null {
	const preferences = parseCopyFields(draft.fields);
	return preferences &&
		!draft.conflict &&
		draft.latest.revision === draft.baseline.revision
		? { ...preferences, expected_revision: draft.baseline.revision }
		: null;
}

export function conflictCopyDraft(draft: ContextCopyDraft): ContextCopyDraft {
	return { ...draft, conflict: true };
}

/** A superseding saved response must not erase this form's submitted edits. */
export function completeCopyDraft(
	draft: ContextCopyDraft,
	saved: ContextCopySettings,
	persisted: ContextCopySettings,
): ContextCopyDraft {
	return persisted.revision > saved.revision
		? { ...draft, latest: persisted, conflict: true }
		: createCopyDraft(persisted);
}
