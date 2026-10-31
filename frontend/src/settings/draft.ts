export type Draft<T> = {
	value: T;
	baseline: T;
	source: T;
	sourcePending: boolean;
	saved: boolean;
};

function equal<T>(a: T, b: T) {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function createDraft<T>(value: T): Draft<T> {
	return {
		value,
		baseline: value,
		source: value,
		sourcePending: false,
		saved: false,
	};
}

export function draftDirty<T>(draft: Draft<T>) {
	return !equal(draft.value, draft.baseline);
}

export function editDraft<T>(
	draft: Draft<T>,
	value: T,
	preserveInput = false,
): Draft<T> {
	if (!preserveInput && draft.sourcePending && equal(value, draft.baseline))
		return resetDraft(draft);
	if (preserveInput && draft.sourcePending)
		return {
			...draft,
			value,
			baseline: draft.source,
			sourcePending: false,
			saved: false,
		};
	return { ...draft, value, saved: false };
}

export function resetDraft<T>(draft: Draft<T>): Draft<T> {
	const baseline = draft.sourcePending ? draft.source : draft.baseline;
	return {
		...draft,
		value: baseline,
		baseline,
		sourcePending: false,
		saved: false,
	};
}

export function receiveDraft<T>(
	draft: Draft<T>,
	value: T,
	preserveInput = false,
): Draft<T> {
	const dirty = draftDirty(draft);
	// Query observer notifications can lag behind a locally accepted save.
	if (
		equal(draft.source, value) &&
		!(draft.sourcePending && !dirty && !preserveInput)
	)
		return draft;
	if (dirty || preserveInput)
		return {
			...draft,
			baseline: preserveInput ? value : draft.baseline,
			source: value,
			sourcePending: !preserveInput && !equal(draft.baseline, value),
		};
	if (equal(draft.baseline, value))
		return { ...draft, source: value, sourcePending: false };
	return createDraft(value);
}

export function completeDraft<T>(
	draft: Draft<T>,
	submitted: T,
	persisted: T,
): Draft<T> {
	const unchanged = equal(draft.value, submitted);
	return {
		value: unchanged ? persisted : draft.value,
		baseline: persisted,
		source: draft.source,
		sourcePending: false,
		saved: unchanged,
	};
}

type Address = { pathname: string; search: string; hash: string };

export function shouldBlockSettingsNavigation(
	current: Address,
	next: Address,
	drafts: readonly { dirty: boolean; pending: boolean }[],
) {
	return (
		(current.pathname !== next.pathname ||
			current.search !== next.search ||
			current.hash !== next.hash) &&
		drafts.some((draft) => draft.dirty || draft.pending)
	);
}
