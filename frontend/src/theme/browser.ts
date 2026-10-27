import { useSyncExternalStore } from "react";
import {
	createThemeController,
	THEME_STORAGE_KEY,
	type ThemePreference,
} from "./preference";

let controller: ReturnType<typeof createThemeController> | undefined;

export function startAppTheme() {
	if (controller) return controller;
	const system = matchMedia("(prefers-color-scheme: dark)");
	controller = createThemeController({
		read: () => localStorage.getItem(THEME_STORAGE_KEY),
		write: (value) => localStorage.setItem(THEME_STORAGE_KEY, value),
		systemDark: () => system.matches,
		onSystemChange: (change) => {
			system.addEventListener("change", change);
			return () => system.removeEventListener("change", change);
		},
		onStorageChange: (change) => {
			const listener = (event: StorageEvent) => {
				if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
				try {
					if (event.storageArea && event.storageArea !== localStorage) return;
				} catch {
					return;
				}
				change(event.newValue);
			};
			window.addEventListener("storage", listener);
			return () => window.removeEventListener("storage", listener);
		},
		apply: (mode) => {
			document.documentElement.dataset.theme = mode;
			const meta = document.querySelector('meta[name="theme-color"]');
			meta?.setAttribute("content", mode === "dark" ? "#15181d" : "#f7f8f9");
		},
	});
	return controller;
}

export function useAppTheme() {
	const theme = startAppTheme();
	return {
		...useSyncExternalStore(theme.subscribe, theme.getSnapshot),
		select: (preference: ThemePreference) => theme.select(preference),
	};
}
