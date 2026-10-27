export type ThemePreference = "light" | "dark" | "system";
export type ThemeMode = Exclude<ThemePreference, "system">;
export const THEME_STORAGE_KEY = "folio-appearance-v1";

export function normalizeThemePreference(value: unknown): ThemePreference {
	return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
	preference: ThemePreference,
	systemDark: boolean,
): ThemeMode {
	return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export type ThemeSnapshot = {
	preference: ThemePreference;
	mode: ThemeMode;
	storageFailed: boolean;
};

type ThemeEnvironment = {
	read: () => unknown;
	write: (preference: ThemePreference) => void;
	systemDark: () => boolean;
	onSystemChange: (change: () => void) => () => void;
	onStorageChange: (change: (value: unknown) => void) => () => void;
	apply: (mode: ThemeMode) => void;
};

/** Owns preference persistence and external changes; consumers observe one snapshot. */
export function createThemeController(environment: ThemeEnvironment) {
	let preference: ThemePreference = "system";
	let storageFailed = false;
	try {
		preference = normalizeThemePreference(environment.read());
	} catch {
		storageFailed = true;
	}
	let snapshot: ThemeSnapshot = {
		preference,
		mode: resolveTheme(preference, environment.systemDark()),
		storageFailed,
	};
	let disposed = false;
	const listeners = new Set<() => void>();
	function update(next: ThemePreference, failed: boolean) {
		if (disposed) return;
		const mode = resolveTheme(next, environment.systemDark());
		if (
			snapshot.preference === next &&
			snapshot.mode === mode &&
			snapshot.storageFailed === failed
		)
			return;
		const modeChanged = snapshot.mode !== mode;
		snapshot = { preference: next, mode, storageFailed: failed };
		if (modeChanged) environment.apply(mode);
		for (const listener of listeners) listener();
	}
	environment.apply(snapshot.mode);
	const stopSystem = environment.onSystemChange(() =>
		update(snapshot.preference, snapshot.storageFailed),
	);
	const stopStorage = environment.onStorageChange((value) =>
		update(normalizeThemePreference(value), false),
	);
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		select(next: ThemePreference) {
			if (disposed) return;
			let failed = false;
			try {
				environment.write(next);
			} catch {
				failed = true;
			}
			update(next, failed);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopSystem();
			stopStorage();
			listeners.clear();
		},
	};
}
