import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSpeechController,
	type DeviceVoice,
	readSpeechPreferences,
	type SpeechAdapter,
	selectedVoice,
	speechUnavailableReason,
} from "./controller.ts";

const remote: DeviceVoice = {
	voiceURI: "remote-ja",
	name: "remote",
	lang: "ja-JP",
	localService: false,
};
const local: DeviceVoice = {
	voiceURI: "local-ja",
	name: "local",
	lang: "ja-JP",
	localService: true,
};
function fixture(initial: DeviceVoice[] = [remote, local]) {
	let voices = initial;
	let changed = () => {};
	let cancels = 0;
	const calls: Parameters<SpeechAdapter["speak"]>[0][] = [];
	const adapter: SpeechAdapter = {
		getVoices: () => voices,
		onVoicesChanged(listener) {
			changed = listener;
			return () => {
				changed = () => {};
			};
		},
		cancel() {
			cancels++;
		},
		speak(input) {
			calls.push(input);
		},
	};
	const controller = createSpeechController(adapter);
	return {
		call(index: number) {
			const call = calls[index];
			assert.ok(call);
			return call;
		},
		controller,
		calls,
		get cancels() {
			return cancels;
		},
		voices(next: DeviceVoice[]) {
			voices = next;
			changed();
		},
	};
}
const target = { id: "a", text: "日本語", label: "选区 A" };
test("声音列表迟到仅启用日语，自动优先本地声音", () => {
	const f = fixture([]);
	assert.match(
		speechUnavailableReason(f.controller.getSnapshot()) ?? "",
		/尚未检测到日语/,
	);
	f.controller.play(target);
	assert.equal(f.calls.length, 0);
	f.voices([{ ...local, lang: "en-US" }, remote, local]);
	assert.equal(f.controller.getSnapshot().voices.length, 2);
	assert.equal(f.controller.getSnapshot().error, null);
	assert.equal(selectedVoice(f.controller.getSnapshot()), local);
	f.controller.play(target);
	assert.equal(f.call(0).voice, local);
	assert.equal(f.controller.getSnapshot().status, "starting");
	f.call(0).onStart();
	assert.equal(f.controller.getSnapshot().status, "speaking");
	f.call(0).onEnd();
	assert.equal(f.controller.getSnapshot().status, "ended");
	f.call(0).onStart();
	assert.equal(f.controller.getSnapshot().status, "ended");
});
test("新播放和停止隔离迟到事件，重播保留原文快照", () => {
	const f = fixture();
	const mutable = { ...target };
	f.controller.play(mutable);
	mutable.text = "changed";
	f.controller.play({ id: "b", text: "次の原文" });
	f.call(0).onStart();
	f.call(0).onError("old");
	f.call(0).onEnd();
	assert.equal(f.controller.getSnapshot().target?.id, "b");
	assert.equal(f.controller.getSnapshot().status, "starting");
	f.call(1).onStart();
	f.controller.stop();
	f.call(1).onStart();
	f.call(1).onEnd();
	assert.equal(f.controller.getSnapshot().status, "stopped");
	f.controller.replay();
	assert.equal(f.call(2).text, "次の原文");
	assert.ok(f.cancels >= 3);
});
test("选中声音失效不静默换声，重新出现后可用", () => {
	const f = fixture();
	f.controller.setVoice(remote);
	f.voices([local]);
	assert.match(
		speechUnavailableReason(f.controller.getSnapshot()) ?? "",
		/重新选择/,
	);
	f.controller.play(target);
	assert.equal(f.calls.length, 0);
	f.voices([remote, local]);
	assert.equal(selectedVoice(f.controller.getSnapshot()), remote);
	f.controller.play(target);
	f.call(0).onError("not-allowed");
	assert.equal(f.controller.getSnapshot().status, "error");
	assert.match(f.controller.getSnapshot().error ?? "", /not-allowed/);
});
test("偏好拒绝坏存储和越界语速，存储失败不妨碍当前使用", () => {
	assert.deepEqual(readSpeechPreferences(), { voice: null, rate: 1 });
	for (const raw of [
		"broken",
		"null",
		"[]",
		'{"rate":99,"voice":{"lang":"en-US"}}',
	]) {
		assert.deepEqual(
			readSpeechPreferences({ getItem: () => raw, setItem() {} }),
			{ voice: null, rate: 1 },
		);
	}
	const denied = {
		getItem(): never {
			throw Error("denied");
		},
		setItem(): never {
			throw Error("denied");
		},
	};
	assert.equal(readSpeechPreferences(denied).rate, 1);
	const stored = JSON.stringify({ voice: remote, rate: 0.8 });
	assert.equal(
		readSpeechPreferences({ getItem: () => stored, setItem() {} }).voice
			?.voiceURI,
		remote.voiceURI,
	);
	const controller = createSpeechController(undefined, denied);
	assert.match(
		speechUnavailableReason(controller.getSnapshot()) ?? "",
		/不支持/,
	);
	controller.setRate(0.7);
	controller.setRate(Number.NaN);
	controller.setRate(2);
	assert.equal(controller.getSnapshot().preferences.rate, 0.7);
});
test("共享订阅同步偏好，重播采用新语速，原始目标不会被外部变更", () => {
	const f = fixture();
	let notifications = 0;
	const unsubscribe = f.controller.subscribe(() => {
		notifications++;
	});
	const original = { ...target };
	f.controller.play(original);
	original.text = "新选区";
	f.controller.stop();
	f.controller.setRate(0.8);
	f.controller.replay();
	assert.equal(f.call(1).text, target.text);
	assert.equal(f.call(1).rate, 0.8);
	assert.ok(notifications >= 4);
	unsubscribe();
	f.controller.dispose();
	f.call(1).onStart();
	assert.equal(f.controller.getSnapshot().status, "stopped");
});

test("同步启动失败与声音读取失败准确反馈，可重新检测恢复", () => {
	let broken = true;
	let failSpeak = true;
	const controller = createSpeechController({
		getVoices() {
			if (broken) throw Error("unavailable");
			return [local];
		},
		onVoicesChanged() {
			return () => {};
		},
		cancel() {},
		speak(input) {
			if (failSpeak) throw Error("denied");
			input.onStart();
		},
	});
	assert.match(controller.getSnapshot().error ?? "", /无法读取/);
	broken = false;
	controller.refresh();
	assert.equal(controller.getSnapshot().error, null);
	controller.play(target);
	assert.equal(controller.getSnapshot().status, "error");
	assert.match(controller.getSnapshot().error ?? "", /未能启动/);
	failSpeak = false;
	controller.replay();
	assert.equal(controller.getSnapshot().status, "speaking");
});

test("首次无声音或不支持时固定失败目标，控制条能保留失败原因", () => {
	for (const controller of [fixture([]).controller, createSpeechController()]) {
		const input = { ...target };
		controller.play(input);
		input.text = "更改选区";
		assert.deepEqual(controller.getSnapshot().target, target);
		assert.equal(controller.getSnapshot().status, "error");
		assert.match(controller.getSnapshot().error ?? "", /日语声音|不支持/);
		controller.dismiss();
		assert.equal(controller.getSnapshot().target, null);
		assert.equal(controller.getSnapshot().error, null);
		assert.equal(controller.getSnapshot().status, "idle");
	}
});
test("停止并收起取消当前播放，迟到事件不恢复目标；之后仍可新播", () => {
	const f = fixture();
	f.controller.play(target);
	f.call(0).onStart();
	const before = f.cancels;
	f.controller.dismiss();
	assert.equal(f.cancels, before + 1);
	f.call(0).onStart();
	f.call(0).onEnd();
	f.call(0).onError("late");
	assert.equal(f.controller.getSnapshot().target, null);
	assert.equal(f.controller.getSnapshot().status, "idle");
	assert.equal(f.controller.getSnapshot().error, null);
	f.controller.replay();
	assert.equal(f.calls.length, 1);
	f.controller.play(target);
	assert.equal(f.calls.length, 2);
});
