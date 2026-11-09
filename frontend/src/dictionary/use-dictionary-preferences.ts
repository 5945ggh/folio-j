import { useSyncExternalStore } from "react";
import {
	createDictionaryPreferencesStore,
	DICTIONARY_PREFERENCES_KEY,
} from "./preferences";

let shared: ReturnType<typeof createDictionaryPreferencesStore> | undefined;
function preferencesStore() {
	if (!shared) {
		shared = createDictionaryPreferencesStore();
		window.addEventListener("storage", (event) => {
			if (event.key === DICTIONARY_PREFERENCES_KEY || event.key === null)
				shared?.refresh();
		});
	}
	return shared;
}
export function useDictionaryPreferences() {
	const store = preferencesStore();
	const preferences = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const storageFailed = useSyncExternalStore(
		store.subscribe,
		store.getStorageFailed,
	);
	return {
		preferences,
		storageFailed,
		updatePreferences: store.updatePreferences,
	};
}
