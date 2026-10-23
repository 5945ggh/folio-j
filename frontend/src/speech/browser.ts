import {
	createSpeechController,
	type PreferenceStorage,
	type SpeechAdapter,
} from "./controller.ts";

function browserAdapter(): SpeechAdapter | undefined {
	if (
		typeof window === "undefined" ||
		!("speechSynthesis" in window) ||
		!("SpeechSynthesisUtterance" in window)
	)
		return undefined;
	const synthesis = window.speechSynthesis;
	return {
		getVoices: () => synthesis.getVoices(),
		onVoicesChanged(listener) {
			synthesis.addEventListener("voiceschanged", listener);
			return () => synthesis.removeEventListener("voiceschanged", listener);
		},
		cancel: () => synthesis.cancel(),
		speak(input) {
			const utterance = new SpeechSynthesisUtterance(input.text);
			utterance.voice = input.voice as SpeechSynthesisVoice;
			utterance.lang = input.voice.lang;
			utterance.rate = input.rate;
			utterance.onstart = input.onStart;
			utterance.onend = input.onEnd;
			utterance.onerror = (event) => input.onError(event.error);
			synthesis.speak(utterance);
		},
	};
}
let controller: ReturnType<typeof createSpeechController> | undefined;
export function getSpeechController() {
	if (!controller) {
		let storage: PreferenceStorage | undefined;
		try {
			if (typeof window !== "undefined") storage = window.localStorage;
		} catch {
			/* Storage is optional. */
		}
		controller = createSpeechController(browserAdapter(), storage);
	}
	return controller;
}
