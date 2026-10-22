import type { MaterialProvenance, MaterialSegmentInput } from "./study-api";

export type ContextSide = "before" | "after";
type ContextField = {
	value: string;
	edited: boolean;
	automatic: boolean;
	truncated: boolean;
};
export type ContextFill = {
	before: string;
	after: string;
	beforeTruncated: boolean;
	afterTruncated: boolean;
};
export type ContextDraft = {
	target: string;
	generation: number;
	before: ContextField;
	after: ContextField;
};

export function createContextDraft(target: string): ContextDraft {
	return {
		target,
		generation: 0,
		before: { value: "", edited: false, automatic: false, truncated: false },
		after: { value: "", edited: false, automatic: false, truncated: false },
	};
}

export function editContext(
	draft: ContextDraft,
	side: ContextSide,
	value: string,
): ContextDraft {
	return {
		...draft,
		[side]: { value, edited: true, automatic: false, truncated: false },
	};
}

export function beginContextFill(draft: ContextDraft): ContextDraft {
	return { ...draft, generation: draft.generation + 1 };
}

/** Both target and attempt must still match. Clearing a field counts as an edit. */
export function applyContextFill(
	draft: ContextDraft,
	target: string,
	generation: number,
	fill: ContextFill,
	replace = false,
): ContextDraft {
	if (draft.target !== target || draft.generation !== generation) return draft;
	const field = (side: ContextSide): ContextField =>
		!replace && draft[side].edited
			? draft[side]
			: {
					value: fill[side],
					edited: false,
					automatic: true,
					truncated:
						side === "before" ? fill.beforeTruncated : fill.afterTruncated,
				};
	return { ...draft, before: field("before"), after: field("after") };
}

export function contextInputError(draft: ContextDraft): string | null {
	return [draft.before.value, draft.after.value].some(
		(value) => Array.from(value.normalize("NFC")).length > 100_000,
	)
		? "前后文各不能超过 100,000 个字符。"
		: null;
}

/** A lost response is retried with the captured request, including its original context. */
export function prepareStudyRequest(
	pending: MaterialSegmentInput | null,
	reference: MaterialProvenance,
	draft: ContextDraft,
	newId: () => string,
): MaterialSegmentInput {
	if (pending) return pending;
	const invalid = contextInputError(draft);
	if (invalid) throw new Error(invalid);
	const snapshot = structuredClone(reference);
	for (const range of snapshot.ranges) Object.freeze(range);
	Object.freeze(snapshot.ranges);
	Object.freeze(snapshot);
	return Object.freeze({
		material_provenance: snapshot,
		request_id: newId(),
		context_before: draft.before.value.normalize("NFC"),
		context_after: draft.after.value.normalize("NFC"),
		translation: "",
		transcription: "",
		note: "",
		source_ref: "",
	});
}

export function uncertainStudyFailure(error: unknown): boolean {
	const status =
		error && typeof error === "object" && "status" in error
			? error.status
			: null;
	return (
		typeof status !== "number" ||
		status === 0 ||
		status === 408 ||
		status >= 500
	);
}
