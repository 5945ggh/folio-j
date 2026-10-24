import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSpeechController,
	type DeviceVoice,
	readSpeechPreferences,
	type SpeechAdapter,
	selectedVoice,
	speechTargetAction,
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
function fixture(initial: DeviceVoice[] = [remote, local], pausable = false) {
	let voices = initial;
	let changed = () => {};
	let cancels = 0;
	let pauses = 0;
	let resumes = 0;
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
		...(pausable
			? {
					pause() {
						pauses++;
					},
					resume() {
						resumes++;
					},
				}
			: {}),
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
		get pauses() {
			return pauses;
		},
		get resumes() {
			return resumes;
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

test("目标动作只停止自己的原文快照，其他目标播放后替换当前朗读", () => {
	const f = fixture();
	const other = { id: "b", text: "別の原文" };
	assert.equal(speechTargetAction(f.controller.getSnapshot(), target), "play");
	f.controller.play(target);
	assert.equal(speechTargetAction(f.controller.getSnapshot(), target), "stop");
	assert.equal(speechTargetAction(f.controller.getSnapshot(), other), "play");
	assert.equal(
		speechTargetAction(f.controller.getSnapshot(), {
			...target,
			text: "新選区",
		}),
		"play",
	);
	f.controller.play(other);
	f.call(0).onEnd();
	assert.equal(speechTargetAction(f.controller.getSnapshot(), other), "stop");
	f.controller.stop();
	assert.equal(speechTargetAction(f.controller.getSnapshot(), other), "replay");
	f.controller.replay();
	f.call(2).onEnd();
	assert.equal(speechTargetAction(f.controller.getSnapshot(), other), "replay");
});

test("离页清理目标后保留声音与语速，迟到事件与重播不能恢复旧目标", () => {
	const f = fixture();
	f.controller.setVoice(remote);
	f.controller.setRate(0.8);
	f.controller.play(target);
	const preferences = f.controller.getSnapshot().preferences;
	f.controller.dismiss();
	f.call(0).onError("late");
	f.call(0).onStart();
	f.call(0).onEnd();
	f.controller.replay();
	assert.equal(f.calls.length, 1);
	assert.equal(f.controller.getSnapshot().target, null);
	assert.equal(f.controller.getSnapshot().status, "idle");
	assert.deepEqual(f.controller.getSnapshot().preferences, preferences);
	f.controller.play({ id: "new-book", text: "新しい本" });
	assert.equal(f.call(1).rate, 0.8);
	assert.equal(f.call(1).voice, remote);
});

test("播放时声音消失仍保留当前目标的停止动作", () => {
	const f = fixture();
	f.controller.setVoice(remote);
	f.controller.play(target);
	f.call(0).onStart();
	f.voices([local]);
	assert.match(
		speechUnavailableReason(f.controller.getSnapshot()) ?? "",
		/已选日语声音当前不可用/,
	);
	assert.equal(speechTargetAction(f.controller.getSnapshot(), target), "stop");
	f.controller.stop();
	assert.equal(f.controller.getSnapshot().status, "stopped");
	f.call(0).onError("late");
	assert.equal(f.controller.getSnapshot().error, null);
});

test("暂停与继续调用设备方法，不重建朗读，也不应用待生效偏好", () => {
	const f = fixture(undefined, true);
	assert.equal(f.controller.getSnapshot().pauseSupported, true);
	f.controller.play(target);
	assert.equal(speechTargetAction(f.controller.getSnapshot(), target), "stop");
	f.call(0).onStart();
	assert.equal(speechTargetAction(f.controller.getSnapshot(), target), "pause");
	f.controller.pause();
	assert.equal(f.pauses, 1);
	assert.equal(f.controller.getSnapshot().status, "paused");
	assert.equal(
		speechTargetAction(f.controller.getSnapshot(), target),
		"resume",
	);
	f.controller.setRate(0.6);
	f.controller.setVoice(remote);
	f.voices([]);
	f.controller.resume();
	assert.equal(f.resumes, 1);
	assert.equal(f.controller.getSnapshot().status, "speaking");
	assert.equal(f.calls.length, 1);
	assert.equal(f.call(0).rate, 1);
	assert.equal(f.call(0).voice, local);
});

test("暂停/继续只接受对应播放状态，迟到事件不逆转最新意图", () => {
	const f = fixture(undefined, true);
	f.controller.pause();
	f.controller.resume();
	f.controller.play(target);
	f.controller.pause();
	assert.equal(f.pauses, 0);
	f.call(0).onStart();
	f.controller.pause();
	f.controller.pause();
	assert.equal(f.pauses, 1);
	f.call(0).onStart();
	assert.equal(f.controller.getSnapshot().status, "paused");
	f.controller.resume();
	f.controller.resume();
	assert.equal(f.resumes, 1);
	f.call(0).onPause();
	assert.equal(f.controller.getSnapshot().status, "speaking");
	f.controller.pause();
	f.call(0).onResume();
	assert.equal(f.controller.getSnapshot().status, "paused");
	f.controller.stop();
	f.call(0).onPause();
	f.call(0).onResume();
	assert.equal(f.controller.getSnapshot().status, "stopped");
	assert.equal(
		speechTargetAction(f.controller.getSnapshot(), target),
		"replay",
	);
});

test("暂停后重播、换目标与离页清除暂停并隔离旧事件", () => {
	const f = fixture(undefined, true);
	f.controller.play(target);
	f.call(0).onStart();
	f.controller.pause();
	f.controller.setRate(0.7);
	f.controller.replay();
	assert.equal(f.call(1).rate, 0.7);
	assert.equal(f.controller.getSnapshot().status, "starting");
	f.call(0).onResume();
	assert.equal(f.controller.getSnapshot().status, "starting");
	f.call(1).onStart();
	f.controller.pause();
	const other = { id: "b", text: "別の原文" };
	assert.equal(speechTargetAction(f.controller.getSnapshot(), other), "play");
	f.controller.play(other);
	f.call(1).onPause();
	assert.equal(f.controller.getSnapshot().target?.id, "b");
	f.call(2).onStart();
	f.controller.pause();
	f.controller.dismiss();
	f.call(2).onResume();
	assert.equal(f.controller.getSnapshot().status, "idle");
	assert.equal(f.controller.getSnapshot().target, null);
});

test("不支持暂停的适配器沿用停止，不伪造暂停状态", () => {
	const f = fixture();
	assert.equal(f.controller.getSnapshot().pauseSupported, false);
	f.controller.play(target);
	f.call(0).onStart();
	f.controller.pause();
	assert.equal(f.controller.getSnapshot().status, "speaking");
	assert.equal(speechTargetAction(f.controller.getSnapshot(), target), "stop");
});

test("设备暂停实际结束朗读时按真实终态显示重播", () => {
	const f = fixture(undefined, true);
	f.controller.play(target);
	f.call(0).onStart();
	f.controller.pause();
	f.call(0).onEnd();
	f.call(0).onPause();
	assert.equal(f.controller.getSnapshot().status, "ended");
	assert.equal(
		speechTargetAction(f.controller.getSnapshot(), target),
		"replay",
	);
});
