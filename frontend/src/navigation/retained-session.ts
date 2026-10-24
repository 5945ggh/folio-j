export type RetainedEntry<T> = { key: string; value: T };
export type RetainedSession<T> = {
	entry: RetainedEntry<T> | null;
	active: boolean;
	activation: number;
	instance: number;
	expiresAt: number | null;
};

export const DEFAULT_RETENTION_MS = 10 * 60 * 1000;

export function emptyRetainedSession<T>(): RetainedSession<T> {
	return {
		entry: null,
		active: false,
		activation: 0,
		instance: 0,
		expiresAt: null,
	};
}

/** One retained view; a lease starts on departure and never extends while away. */
export function advanceRetainedSession<T>(
	state: RetainedSession<T>,
	current: RetainedEntry<T> | null,
	retain: boolean,
	now: number,
	retentionMs = DEFAULT_RETENTION_MS,
): RetainedSession<T> {
	const expired = state.expiresAt !== null && now >= state.expiresAt;
	if (current) {
		if (!expired && state.entry?.key === current.key) {
			if (state.active && state.entry.value === current.value) return state;
			return {
				...state,
				entry: current,
				active: true,
				activation: state.activation + (state.active ? 0 : 1),
				expiresAt: null,
			};
		}
		return {
			entry: current,
			active: true,
			activation: 0,
			instance: state.instance + 1,
			expiresAt: null,
		};
	}
	if (!state.entry) return state;
	if (expired || !retain || retentionMs <= 0)
		return { ...emptyRetainedSession<T>(), instance: state.instance };
	if (!state.active) return state;
	return {
		...state,
		active: false,
		expiresAt: now + retentionMs,
	};
}
