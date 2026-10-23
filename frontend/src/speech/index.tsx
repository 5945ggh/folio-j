import { useEffect, useId, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { getSpeechController } from "./browser";
import {
	MAX_SPEECH_RATE,
	MIN_SPEECH_RATE,
	type SpeechTarget,
	selectedVoice,
	speechUnavailableReason,
} from "./controller";
import "./speech.css";

export type { SpeechTarget } from "./controller";

function useDeviceSpeech() {
	const controller = getSpeechController();
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);
	return { controller, state };
}
/** Call once on each reading/segment page; scopeKey also stops on same-route target navigation. */
export function useStopSpeechOnLeave(scopeKey?: string) {
	useEffect(() => {
		void scopeKey;
		return () => getSpeechController().stop();
	}, [scopeKey]);
}
function SpeechRate() {
	const { state, controller } = useDeviceSpeech();
	const id = useId();
	return (
		<label
			className="device-speech-rate"
			htmlFor={id}
			title="更改语速在下一次播放或重播时生效"
		>
			语速
			<select
				id={id}
				aria-label="朗读语速，下次播放或重播时生效"
				value={state.preferences.rate}
				onChange={(event) => controller.setRate(Number(event.target.value))}
			>
				{Array.from(
					{ length: Math.round((MAX_SPEECH_RATE - MIN_SPEECH_RATE) / 0.1) + 1 },
					(_, index) => Number((MIN_SPEECH_RATE + index / 10).toFixed(1)),
				).map((rate) => (
					<option key={rate} value={rate}>
						{rate}×
					</option>
				))}
			</select>
		</label>
	);
}
const statusLabels = {
	idle: "尚未播放",
	starting: "等待设备开始",
	speaking: "正在朗读",
	stopped: "已停止",
	ended: "朗读结束",
	error: "朗读失败",
};
export function SpeechControls({
	target,
	compact = false,
}: {
	target: SpeechTarget;
	compact?: boolean;
}) {
	const { state, controller } = useDeviceSpeech();
	const reason = speechUnavailableReason(state);
	const current =
		state.target?.id === target.id && state.target.text === target.text;
	const active = state.status === "starting" || state.status === "speaking";
	return (
		<div className="device-speech" data-compact={compact || undefined}>
			<button
				type="button"
				disabled={!!reason || !target.text.trim()}
				onClick={() => controller.play(target)}
			>
				设备朗读
			</button>
			{active && (
				<button type="button" onClick={() => controller.stop()}>
					停止朗读
				</button>
			)}
			{current && !active && (
				<button
					type="button"
					disabled={!!reason}
					onClick={() => controller.replay()}
				>
					重播原文
				</button>
			)}
			{!compact && <SpeechRate />}
			{(reason || state.error) && (
				<span className="device-speech-message" role="status">
					{reason ?? state.error}{" "}
					<Link to="/settings?section=speech">声音设置</Link>
				</span>
			)}
		</div>
	);
}
export function SpeechPlaybackBar() {
	const { state, controller } = useDeviceSpeech();
	if (!state.target) return null;
	const active = state.status === "starting" || state.status === "speaking";
	return (
		<section
			className="device-speech device-speech-bar"
			aria-label="当前设备朗读"
		>
			<span className="device-speech-summary">
				<strong>{state.target.label ?? "当前原文"}</strong>
				<span lang="ja" title={state.target.text}>
					{state.target.text}
				</span>
			</span>
			<span role="status">{state.error ?? statusLabels[state.status]}</span>
			{active ? (
				<button type="button" onClick={() => controller.stop()}>
					停止朗读
				</button>
			) : (
				<button
					type="button"
					disabled={!!speechUnavailableReason(state)}
					onClick={() => controller.replay()}
				>
					重播原文
				</button>
			)}
			<SpeechRate />
			<Link to="/settings?section=speech">声音设置</Link>
			<button type="button" onClick={() => controller.dismiss()}>
				{active ? "停止并收起" : "收起朗读控制"}
			</button>
		</section>
	);
}
export function DeviceSpeechSettings() {
	const { state, controller } = useDeviceSpeech();
	const id = useId();
	const selected = selectedVoice(state);
	const unavailable = speechUnavailableReason(state);
	useStopSpeechOnLeave("speech-settings");
	return (
		<section className="device-speech-settings" aria-labelledby={`${id}-title`}>
			<h3 id={`${id}-title`}>声音与播放</h3>
			<p>
				声音由当前浏览器和系统提供；选择与语速仅保存在当前浏览器。不会保存音频文件。
			</p>
			<label htmlFor={`${id}-voice`}>日语声音</label>
			<select
				id={`${id}-voice`}
				disabled={!state.supported}
				value={
					state.preferences.voice
						? selected
							? String(state.voices.indexOf(selected))
							: "missing"
						: "auto"
				}
				onChange={(event) =>
					controller.setVoice(
						event.target.value === "auto"
							? null
							: (state.voices[Number(event.target.value)] ?? null),
					)
				}
			>
				<option value="auto">自动选择日语声音（优先本地）</option>
				{state.preferences.voice && !selected && (
					<option value="missing" disabled>
						{state.preferences.voice.name}（当前不可用）
					</option>
				)}
				{state.voices.map((voice, index) => (
					<option
						key={`${voice.voiceURI}-${voice.name}-${voice.lang}`}
						value={index}
					>
						{voice.name} · {voice.lang} ·{" "}
						{voice.localService ? "本地声音" : "远端声音"}
					</option>
				))}
			</select>
			{selected && (
				<p>
					当前：{selected.name}（
					{selected.localService ? "本地声音" : "远端声音，可能需要网络"}
					）。
				</p>
			)}
			<div className="device-speech">
				<SpeechRate />
				<button
					type="button"
					disabled={!state.supported}
					onClick={() => controller.refresh()}
				>
					重新检测声音
				</button>
				<button
					type="button"
					disabled={!!unavailable}
					onClick={() =>
						controller.play({
							id: "device-speech-preview",
							text: "こんにちは。日本語の文章を読み上げます。",
							label: "声音试听",
						})
					}
				>
					试听
				</button>
				{(state.status === "starting" || state.status === "speaking") && (
					<button type="button" onClick={() => controller.stop()}>
						停止试听
					</button>
				)}
			</div>
			<p role="status">
				{unavailable ??
					state.error ??
					(state.target?.id === "device-speech-preview"
						? statusLabels[state.status]
						: "更改声音和语速后，在下一次播放时生效。")}
			</p>
		</section>
	);
}
