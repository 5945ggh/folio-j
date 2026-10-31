/** Never calls the platform synthesizer, including in the interactive preview. */
export function fakeSpeech() {
	const utterances: SpeechSynthesisUtterance[] = [];
	let cancellations = 0;
	let voices = [
		{
			voiceURI: "fixture-local",
			name: "回归用日语声音",
			lang: "ja-JP",
			localService: true,
		},
		{
			voiceURI: "fixture-second",
			name: "另一日语声音",
			lang: "ja-JP",
			localService: true,
		},
	];
	const savedVoices = voices;
	class Utterance extends EventTarget {
		voice: SpeechSynthesisVoice | null = null;
		lang = "";
		rate = 1;
		onstart: (() => void) | null = null;
		onend: (() => void) | null = null;
		onerror: ((event: { error: string }) => void) | null = null;
		constructor(public text: string) {
			super();
		}
	}
	const synthesis = new EventTarget();
	Object.assign(synthesis, {
		getVoices: () => voices,
		cancel: () => {
			cancellations++;
		},
		speak: (utterance: SpeechSynthesisUtterance) => {
			utterances.push(utterance);
		},
	});
	Object.defineProperty(window, "speechSynthesis", {
		configurable: true,
		value: synthesis,
	});
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		configurable: true,
		value: Utterance,
	});
	const latest = () => utterances.at(-1);
	return {
		utterances,
		setVoicesAvailable(available: boolean) {
			voices = available ? savedVoices : [];
			synthesis.dispatchEvent(new Event("voiceschanged"));
		},
		get cancellations() {
			return cancellations;
		},
		start: () =>
			latest()?.onstart?.(new Event("start") as SpeechSynthesisEvent),
		end: () => latest()?.onend?.(new Event("end") as SpeechSynthesisEvent),
		error: () =>
			latest()?.onerror?.({ error: "audio-busy" } as SpeechSynthesisErrorEvent),
	};
}
