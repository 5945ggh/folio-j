import assert from "node:assert/strict";
import test from "node:test";
import { getSpeechController } from "./browser.ts";

test("取消后重播清理全局暂停，每次新建朗读对象并传入实际所选语速", () => {
	class Utterance {
		text: string;
		voice = null;
		lang = "";
		rate = 1;
		onstart: (() => void) | null = null;
		onpause: (() => void) | null = null;
		onresume: (() => void) | null = null;
		onend: (() => void) | null = null;
		constructor(text: string) {
			this.text = text;
		}
	}
	const voices = [
		{ voiceURI: "ja", name: "日本語", lang: "ja-JP", localService: true },
	];
	let current: Utterance | null = null;
	const spoken: Utterance[] = [];
	let resumes = 0;
	const synthesis = {
		paused: false,
		getVoices: () => voices,
		addEventListener() {},
		removeEventListener() {},
		cancel() {
			current = null;
		},
		pause() {
			this.paused = true;
			current?.onpause?.();
		},
		resume() {
			resumes++;
			if (!current) return;
			this.paused = false;
			current.onresume?.();
		},
		speak(utterance: Utterance) {
			current = utterance;
			spoken.push(utterance);
			if (!this.paused) utterance.onstart?.();
		},
	};
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const previousUtterance = Object.getOwnPropertyDescriptor(
		globalThis,
		"SpeechSynthesisUtterance",
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance },
	});
	Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
		configurable: true,
		value: Utterance,
	});
	const controller = getSpeechController();
	try {
		controller.play({ id: "target", text: "元の原文。" });
		assert.equal(controller.getSnapshot().status, "speaking");
		controller.pause();
		assert.equal(controller.getSnapshot().status, "paused");
		controller.replay();
		assert.equal(synthesis.paused, false);
		assert.equal(controller.getSnapshot().status, "speaking");
		assert.equal(spoken.length, 2);
		assert.notEqual(spoken[0], spoken[1]);
		assert.equal(spoken[1]?.text, "元の原文。");
		assert.ok(resumes >= 2);
		spoken[0]?.onpause?.();
		assert.equal(controller.getSnapshot().status, "speaking");
		for (const rate of [0.5, 0.6, 0.9, 1, 1.2, 1.5]) {
			const before: number = spoken.length;
			controller.setRate(rate);
			assert.equal(controller.getSnapshot().preferences.rate, rate);
			controller.replay();
			assert.equal(spoken.length, before + 1);
			assert.equal(spoken.at(-1)?.rate, rate);
			assert.equal(spoken.at(-1)?.text, "元の原文。");
			assert.notEqual(spoken.at(-1), spoken.at(-2));
		}
		controller.pause();
		controller.dismiss();
		spoken[1]?.onresume?.();
		assert.equal(controller.getSnapshot().status, "idle");
		assert.equal(controller.getSnapshot().target, null);
	} finally {
		controller.dispose();
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (previousUtterance)
			Object.defineProperty(
				globalThis,
				"SpeechSynthesisUtterance",
				previousUtterance,
			);
		else Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
	}
});
