import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	createThemeController,
	normalizeThemePreference,
	resolveTheme,
	THEME_STORAGE_KEY,
	type ThemeMode,
} from "./preference.ts";

function setup(value: unknown = null, dark = false) {
	let stored = value;
	let systemDark = dark;
	let failure = false;
	let system: () => void = () => {};
	let storage: (value: unknown) => void = () => {};
	let cleaned = 0;
	const applied: ThemeMode[] = [];
	const controller = createThemeController({
		read: () => stored,
		write: (next) => {
			if (failure) throw new Error("Storage unavailable");
			stored = next;
		},
		systemDark: () => systemDark,
		onSystemChange: (listener) => {
			system = listener;
			return () => cleaned++;
		},
		onStorageChange: (listener) => {
			storage = listener;
			return () => cleaned++;
		},
		apply: (mode) => applied.push(mode),
	});
	return {
		controller,
		applied,
		stored: () => stored,
		cleaned: () => cleaned,
		fail: () => {
			failure = true;
		},
		system: (dark: boolean) => {
			systemDark = dark;
			system();
		},
		storage,
	};
}

test("only supported choices persist; absent or invalid values follow the system", () => {
	for (const value of [undefined, null, "", "black", {}, 1])
		assert.equal(normalizeThemePreference(value), "system");
	assert.equal(normalizeThemePreference("light"), "light");
	assert.equal(normalizeThemePreference("dark"), "dark");
	assert.equal(resolveTheme("system", true), "dark");
	assert.equal(resolveTheme("system", false), "light");
});

test("system changes apply only while following the system and snapshots stay stable otherwise", () => {
	const env = setup(null, true);
	assert.equal(env.controller.getSnapshot().mode, "dark");
	env.system(false);
	assert.equal(env.controller.getSnapshot().mode, "light");
	env.controller.select("dark");
	const snapshot = env.controller.getSnapshot();
	env.system(true);
	assert.equal(env.controller.getSnapshot(), snapshot);
	assert.equal(env.stored(), "dark");
	env.controller.select("system");
	assert.deepEqual(env.controller.getSnapshot(), {
		preference: "system",
		mode: "dark",
		storageFailed: false,
	});
	assert.deepEqual(env.applied, ["dark", "light", "dark"]);
});

test("cross-tab choice, deletion and clearing use the same preference rules", () => {
	const env = setup("light", true);
	let notifications = 0;
	const unsubscribe = env.controller.subscribe(() => notifications++);
	env.storage("dark");
	assert.equal(env.controller.getSnapshot().preference, "dark");
	env.storage(null);
	assert.equal(env.controller.getSnapshot().preference, "system");
	assert.equal(env.controller.getSnapshot().mode, "dark");
	env.storage("invalid");
	assert.equal(notifications, 2);
	unsubscribe();
	env.storage("light");
	assert.equal(notifications, 2);
});

test("failed persistence retains the user's effective choice in memory", () => {
	const env = setup();
	env.fail();
	env.controller.select("dark");
	assert.deepEqual(env.controller.getSnapshot(), {
		preference: "dark",
		mode: "dark",
		storageFailed: true,
	});
	env.system(false);
	assert.equal(env.controller.getSnapshot().mode, "dark");
	assert.equal(env.stored(), null);
});

test("unreadable storage falls back to system; disposed controllers ignore late events", () => {
	const modes: ThemeMode[] = [];
	const controller = createThemeController({
		read: () => {
			throw new Error("Access denied");
		},
		write: () => {},
		systemDark: () => true,
		onSystemChange: () => () => {},
		onStorageChange: () => () => {},
		apply: (mode) => modes.push(mode),
	});
	assert.deepEqual(controller.getSnapshot(), {
		preference: "system",
		mode: "dark",
		storageFailed: true,
	});
	const env = setup();
	env.controller.dispose();
	env.storage("dark");
	env.system(true);
	env.controller.select("dark");
	assert.equal(env.cleaned(), 2);
	assert.deepEqual(env.applied, ["light"]);
	assert.deepEqual(modes, ["dark"]);
});

test("the pre-paint bootstrap restores the same choice before the application module loads", () => {
	const html = readFileSync(
		new URL("../../index.html", import.meta.url),
		"utf8",
	);
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	for (const saved of [null, "light", "dark", "system", "invalid", "blocked"]) {
		for (const systemDark of [false, true]) {
			const root = { dataset: { theme: "" } };
			const meta = { content: "" };
			runInNewContext(script, {
				localStorage: {
					getItem(key: string) {
						assert.equal(key, THEME_STORAGE_KEY);
						if (saved === "blocked") throw new Error("Storage unavailable");
						return saved;
					},
				},
				matchMedia: () => ({ matches: systemDark }),
				document: { documentElement: root, querySelector: () => meta },
			});
			const expected = resolveTheme(
				normalizeThemePreference(saved),
				systemDark,
			);
			assert.equal(root.dataset.theme, expected);
			assert.equal(meta.content, expected === "dark" ? "#15181d" : "#f7f8f9");
		}
	}
});
