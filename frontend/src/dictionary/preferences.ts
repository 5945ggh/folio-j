export type DictionaryMode = "off" | "click" | "hover";
export type DictionaryPreferences = {
	mode: DictionaryMode;
	autoExpand: boolean;
	assistedRanking: boolean;
};
export const DICTIONARY_PREFERENCES_KEY = "folio-dictionary-preferences-v1";
const legacyReaderKey = "folio-reader-ui-v1";
export const DEFAULT_DICTIONARY_PREFERENCES: DictionaryPreferences = {
	mode: "off",
	autoExpand: true,
	assistedRanking: true,
};
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
function browserStorage(): PreferenceStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function normalizeDictionaryPreferences(
	value: unknown,
): DictionaryPreferences {
	const input = object(value);
	return {
		mode: input.mode === "click" || input.mode === "hover" ? input.mode : "off",
		autoExpand: input.autoExpand !== false,
		assistedRanking: input.assistedRanking !== false,
	};
}
export function writeDictionaryPreferences(
	value: DictionaryPreferences,
	store = browserStorage(),
): boolean {
	try {
		if (!store) return false;
		store.setItem(
			DICTIONARY_PREFERENCES_KEY,
			JSON.stringify(normalizeDictionaryPreferences(value)),
		);
		return true;
	} catch {
		return false;
	}
}
export function readDictionaryPreferences(
	store = browserStorage(),
): DictionaryPreferences {
	try {
		const saved = store?.getItem(DICTIONARY_PREFERENCES_KEY);
		if (saved !== null && saved !== undefined)
			return normalizeDictionaryPreferences(JSON.parse(saved));
		const legacy = object(
			JSON.parse(store?.getItem(legacyReaderKey) ?? "null"),
		);
		const migrated = normalizeDictionaryPreferences({
			mode: legacy.dictionaryMode,
			autoExpand: legacy.dictionaryAutoExpand,
			assistedRanking: legacy.dictionaryAssistedRanking,
		});
		writeDictionaryPreferences(migrated, store);
		return migrated;
	} catch {
		return { ...DEFAULT_DICTIONARY_PREFERENCES };
	}
}

/** One snapshot serves every mounted reader and segment, including when storage is unavailable. */
export function createDictionaryPreferencesStore(store = browserStorage()) {
	let snapshot = readDictionaryPreferences(store);
	let storageFailed = false;
	const listeners = new Set<() => void>();
	function publish(next: DictionaryPreferences, failed = false) {
		if (
			snapshot.mode === next.mode &&
			snapshot.autoExpand === next.autoExpand &&
			snapshot.assistedRanking === next.assistedRanking &&
			storageFailed === failed
		)
			return;
		storageFailed = failed;
		snapshot = next;
		for (const listener of listeners) listener();
	}
	return {
		getSnapshot: () => snapshot,
		getStorageFailed: () => storageFailed,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		updatePreferences(patch: Partial<DictionaryPreferences>) {
			const next = normalizeDictionaryPreferences({ ...snapshot, ...patch });
			const saved = writeDictionaryPreferences(next, store);
			publish(next, !saved);
		},
		refresh: () => publish(readDictionaryPreferences(store)),
	};
}
