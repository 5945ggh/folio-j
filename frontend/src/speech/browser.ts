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
		cancel() {
			synthesis.cancel();
			// cancel() preserves the global paused flag; a new utterance must start.
			if (synthesis.paused && typeof synthesis.resume === "function")
				synthesis.resume();
		},
		...(typeof synthesis.pause === "function" &&
		typeof synthesis.resume === "function"
			? {
					pause: () => synthesis.pause(),
					resume: () => synthesis.resume(),
				}
			: {}),
		speak(input) {
			const utterance = new SpeechSynthesisUtterance(input.text);
			utterance.voice = input.voice as SpeechSynthesisVoice;
			utterance.lang = input.voice.lang;
			utterance.rate = input.rate;
			utterance.onstart = input.onStart;
			utterance.onpause = input.onPause;
			utterance.onresume = input.onResume;
			utterance.onend = input.onEnd;
			utterance.onerror = (event) => input.onError(event.error);
			synthesis.speak(utterance);
			// Some engines ignore resume() with an empty queue after cancellation.
			if (synthesis.paused && typeof synthesis.resume === "function")
				synthesis.resume();
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
