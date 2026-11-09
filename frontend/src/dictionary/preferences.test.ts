import assert from "node:assert/strict";
import test from "node:test";
import {
	createDictionaryPreferencesStore,
	DEFAULT_DICTIONARY_PREFERENCES,
	DICTIONARY_PREFERENCES_KEY,
	normalizeDictionaryPreferences,
	readDictionaryPreferences,
	writeDictionaryPreferences,
} from "./preferences.ts";

function storage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}

test("lookup options default on and modes reject invalid values", () => {
	for (const value of [undefined, null, "false", 0, true]) {
		assert.deepEqual(
			normalizeDictionaryPreferences({
				mode: value,
				autoExpand: value,
				assistedRanking: value,
			}),
			DEFAULT_DICTIONARY_PREFERENCES,
		);
	}
	for (const mode of ["off", "click", "hover"] as const) {
		for (const autoExpand of [false, true]) {
			for (const assistedRanking of [false, true]) {
				const store = storage();
				const preferences = { mode, autoExpand, assistedRanking };
				assert.equal(writeDictionaryPreferences(preferences, store), true);
				assert.deepEqual(readDictionaryPreferences(store), preferences);
			}
		}
	}
});

test("first read migrates reader preferences once and preserves the reader visual settings", () => {
	const store = storage();
	const legacy = JSON.stringify({
		dictionaryMode: "hover",
		dictionaryAutoExpand: false,
		dictionaryAssistedRanking: false,
		dictionaryOpacity: 38,
	});
	store.setItem("folio-reader-ui-v1", legacy);
	const migrated = { mode: "hover", autoExpand: false, assistedRanking: false };
	assert.deepEqual(readDictionaryPreferences(store), migrated);
	assert.deepEqual(
		JSON.parse(store.getItem(DICTIONARY_PREFERENCES_KEY) ?? "{}"),
		migrated,
	);
	assert.equal(store.getItem("folio-reader-ui-v1"), legacy);
	store.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({ dictionaryMode: "click" }),
	);
	assert.deepEqual(readDictionaryPreferences(store), migrated);
});

test("an existing independent key is authoritative even when invalid", () => {
	const store = storage();
	store.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({ dictionaryMode: "hover" }),
	);
	store.setItem(DICTIONARY_PREFERENCES_KEY, "broken JSON");
	assert.deepEqual(
		readDictionaryPreferences(store),
		DEFAULT_DICTIONARY_PREFERENCES,
	);
});

test("mounted consumers share immediate updates and refresh external storage changes", () => {
	const storageAdapter = storage();
	const store = createDictionaryPreferencesStore(storageAdapter);
	const snapshots: unknown[] = [];
	const reader = store.subscribe(() =>
		snapshots.push(["reader", store.getSnapshot()]),
	);
	const segment = store.subscribe(() =>
		snapshots.push(["segment", store.getSnapshot()]),
	);
	const initial = store.getSnapshot();
	store.updatePreferences({ mode: "click" });
	assert.equal(snapshots.length, 2);
	assert.equal(store.getSnapshot().mode, "click");
	assert.notEqual(store.getSnapshot(), initial);
	const current = store.getSnapshot();
	store.updatePreferences({ mode: "click" });
	assert.equal(store.getSnapshot(), current);
	assert.equal(snapshots.length, 2);
	writeDictionaryPreferences(
		{ mode: "hover", autoExpand: false, assistedRanking: true },
		storageAdapter,
	);
	store.refresh();
	assert.equal(snapshots.length, 4);
	assert.deepEqual(store.getSnapshot(), {
		mode: "hover",
		autoExpand: false,
		assistedRanking: true,
	});
	reader();
	segment();
	store.updatePreferences({ assistedRanking: false });
	assert.equal(snapshots.length, 4);
});

test("unavailable persistence retains shared in-memory choices", () => {
	const store = createDictionaryPreferencesStore({
		getItem: () => {
			throw new Error("Storage unavailable");
		},
		setItem: () => {
			throw new Error("Storage unavailable");
		},
	});
	store.updatePreferences({ mode: "click", autoExpand: false });
	assert.equal(store.getStorageFailed(), true);
	assert.deepEqual(store.getSnapshot(), {
		mode: "click",
		autoExpand: false,
		assistedRanking: true,
	});
});
