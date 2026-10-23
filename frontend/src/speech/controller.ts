export type SpeechTarget = { id: string; text: string; label?: string };
export type DeviceVoice = {
	voiceURI: string;
	name: string;
	lang: string;
	localService: boolean;
};
export type VoicePreference = Pick<DeviceVoice, "voiceURI" | "name" | "lang">;
export type SpeechPreferences = { voice: VoicePreference | null; rate: number };
export type SpeechState = {
	supported: boolean;
	voices: DeviceVoice[];
	preferences: SpeechPreferences;
	status: "idle" | "starting" | "speaking" | "stopped" | "ended" | "error";
	target: SpeechTarget | null;
	error: string | null;
};
export interface SpeechAdapter {
	getVoices(): DeviceVoice[];
	onVoicesChanged(listener: () => void): () => void;
	cancel(): void;
	speak(input: {
		text: string;
		voice: DeviceVoice;
		rate: number;
		onStart(): void;
		onEnd(): void;
		onError(error: string): void;
	}): void;
}
export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
export const SPEECH_STORAGE_KEY = "folio-j.device-speech.v1";
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 1.5;
const defaults = (): SpeechPreferences => ({ voice: null, rate: 1 });
const validRate = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= MIN_SPEECH_RATE &&
	value <= MAX_SPEECH_RATE;

export function readSpeechPreferences(
	storage?: PreferenceStorage,
): SpeechPreferences {
	try {
		const raw: unknown = JSON.parse(
			storage?.getItem(SPEECH_STORAGE_KEY) ?? "null",
		);
		if (!raw || typeof raw !== "object") return defaults();
		const value = raw as Record<string, unknown>;
		const voice = value.voice;
		let selected: VoicePreference | null = null;
		if (voice && typeof voice === "object") {
			const fields = voice as Record<string, unknown>;
			if (
				typeof fields.voiceURI === "string" &&
				fields.voiceURI.length > 0 &&
				typeof fields.name === "string" &&
				typeof fields.lang === "string" &&
				/^ja(?:[-_]|$)/i.test(fields.lang)
			) {
				selected = {
					voiceURI: fields.voiceURI,
					name: fields.name,
					lang: fields.lang,
				};
			}
		}
		return { voice: selected, rate: validRate(value.rate) ? value.rate : 1 };
	} catch {
		return defaults();
	}
}

export function selectedVoice(state: SpeechState): DeviceVoice | undefined {
	const preference = state.preferences.voice;
	return preference
		? state.voices.find(
				(voice) =>
					voice.voiceURI === preference.voiceURI &&
					voice.lang === preference.lang &&
					voice.name === preference.name,
			)
		: state.voices[0];
}
export function speechUnavailableReason(state: SpeechState): string | null {
	if (!state.supported) return "当前浏览器不支持设备朗读。";
	if (state.preferences.voice && !selectedVoice(state))
		return "已选日语声音当前不可用，请在设置中重新选择或重新检测。";
	if (!state.voices.length)
		return "尚未检测到日语声音。可重新检测，或在系统中安装日语声音后重试。";
	return null;
}

export function createSpeechController(
	adapter?: SpeechAdapter,
	storage?: PreferenceStorage,
) {
	let state: SpeechState = {
		supported: !!adapter,
		voices: [],
		preferences: readSpeechPreferences(storage),
		status: "idle",
		target: null,
		error: null,
	};
	let generation = 0;
	const listeners = new Set<() => void>();
	const update = (next: Partial<SpeechState>) => {
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};
	const refresh = () => {
		if (!adapter) return;
		try {
			const voices = adapter
				.getVoices()
				.filter((voice) => /^ja(?:[-_]|$)/i.test(voice.lang))
				.sort((a, b) => Number(b.localService) - Number(a.localService));
			update({ voices, error: null });
		} catch {
			update({ error: "无法读取设备声音，请重新检测。" });
		}
	};
	const save = (preferences: SpeechPreferences) => {
		update({ preferences, error: null });
		try {
			storage?.setItem(SPEECH_STORAGE_KEY, JSON.stringify(preferences));
		} catch {
			/* Private browsing may deny storage; current-session preference remains usable. */
		}
	};
	const stop = () => {
		generation++;
		try {
			adapter?.cancel();
		} catch {
			/* Events are invalidated even if the browser cannot cancel. */
		}
		if (state.status === "starting" || state.status === "speaking")
			update({ status: "stopped", error: null });
	};
	const play = (target: SpeechTarget) => {
		const reason = speechUnavailableReason(state);
		const voice = selectedVoice(state);
		stop();
		if (reason || !adapter || !voice || !target.text.trim()) {
			update({
				target: { ...target },
				status: "error",
				error: reason ?? "没有可朗读的原文。",
			});
			return;
		}
		const current = ++generation;
		update({ target: { ...target }, status: "starting", error: null });
		const event = (next: Partial<SpeechState>) => {
			if (current === generation) update(next);
		};
		try {
			adapter.speak({
				text: target.text,
				voice,
				rate: state.preferences.rate,
				onStart: () => event({ status: "speaking" }),
				onEnd: () => {
					event({ status: "ended" });
					if (current === generation) generation++;
				},
				onError: (error) => {
					event({
						status: "error",
						error: `设备朗读失败（${error}），请重试或检查声音设置。`,
					});
					if (current === generation) generation++;
				},
			});
		} catch {
			event({
				status: "error",
				error: "设备朗读未能启动，请重试或检查声音设置。",
			});
			if (current === generation) generation++;
		}
	};
	const unsubscribe = adapter?.onVoicesChanged(refresh);
	refresh();
	return {
		getSnapshot: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh,
		play,
		stop,
		dismiss() {
			stop();
			update({ target: null, status: "idle", error: null });
		},
		replay() {
			if (state.target) play(state.target);
		},
		setRate(rate: number) {
			if (validRate(rate)) save({ ...state.preferences, rate });
		},
		setVoice(voice: DeviceVoice | null) {
			if (voice === null || state.voices.includes(voice))
				save({
					...state.preferences,
					voice: voice
						? { voiceURI: voice.voiceURI, name: voice.name, lang: voice.lang }
						: null,
				});
		},
		dispose() {
			stop();
			unsubscribe?.();
			listeners.clear();
		},
	};
}
