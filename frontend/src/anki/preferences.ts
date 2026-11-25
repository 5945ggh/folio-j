const STORAGE_KEY = "folio-j:anki-export-preferences";

export type AnkiRememberedDeck = {
	id: string | null;
	name: string;
};

export type AnkiLocalPreferences = {
	lastConfigurationId: string | null;
	recentDecks: Record<string, AnkiRememberedDeck>;
};

const EMPTY_PREFERENCES: AnkiLocalPreferences = {
	lastConfigurationId: null,
	recentDecks: {},
};

export function deckScopeKey(endpoint: string, profile: string): string {
	return `${endpoint.trim().replace(/\/+$/u, "")}::${profile}`;
}

export function loadAnkiPreferences(
	storage: Pick<Storage, "getItem"> | undefined = typeof window !== "undefined"
		? window.localStorage
		: undefined,
): AnkiLocalPreferences {
	if (!storage) return EMPTY_PREFERENCES;
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (!raw) return EMPTY_PREFERENCES;
		const parsed = JSON.parse(raw) as Partial<AnkiLocalPreferences>;
		const lastConfigurationId =
			typeof parsed.lastConfigurationId === "string" &&
			parsed.lastConfigurationId.trim()
				? parsed.lastConfigurationId.trim()
				: null;
		const recentDecks: Record<string, AnkiRememberedDeck> = {};
		if (parsed.recentDecks && typeof parsed.recentDecks === "object") {
			for (const [key, value] of Object.entries(parsed.recentDecks)) {
				if (
					value &&
					typeof value === "object" &&
					typeof value.name === "string" &&
					value.name.trim()
				) {
					recentDecks[key] = {
						id: typeof value.id === "string" && value.id ? value.id : null,
						name: value.name,
					};
				}
			}
		}
		return { lastConfigurationId, recentDecks };
	} catch {
		return EMPTY_PREFERENCES;
	}
}

function saveAnkiPreferences(
	next: AnkiLocalPreferences,
	storage: Pick<Storage, "setItem"> | undefined = typeof window !== "undefined"
		? window.localStorage
		: undefined,
): void {
	if (!storage) return;
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Private mode or full storage simply skips local recall.
	}
}

export function rememberLastConfigurationId(
	configurationId: string,
	storage?: Pick<Storage, "getItem" | "setItem">,
): void {
	const current = loadAnkiPreferences(storage);
	saveAnkiPreferences(
		{ ...current, lastConfigurationId: configurationId },
		storage,
	);
}

export function rememberRecentDeck(
	endpoint: string,
	profile: string,
	deck: AnkiRememberedDeck,
	storage?: Pick<Storage, "getItem" | "setItem">,
): void {
	const key = deckScopeKey(endpoint, profile);
	const current = loadAnkiPreferences(storage);
	const entries = Object.entries(current.recentDecks).filter(
		([k]) => k !== key,
	);
	entries.push([key, deck]);
	// Keep the map bounded to the 12 most recent collections.
	const bounded = Object.fromEntries(entries.slice(-12));
	saveAnkiPreferences({ ...current, recentDecks: bounded }, storage);
}

export function getRememberedDeck(
	endpoint: string,
	profile: string,
	storage?: Pick<Storage, "getItem">,
): AnkiRememberedDeck | null {
	const current = loadAnkiPreferences(storage);
	return current.recentDecks[deckScopeKey(endpoint, profile)] ?? null;
}
