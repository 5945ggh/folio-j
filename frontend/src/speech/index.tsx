import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useSyncExternalStore,
} from "react";
import { getSpeechController } from "./browser";
import {
	MAX_SPEECH_RATE,
	MIN_SPEECH_RATE,
	type SpeechTarget,
	selectedVoice,
	speechTargetAction,
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
/** Call once on each reading/segment page; scopeKey also clears same-route target navigation. */
export function useStopSpeechOnLeave(scopeKey?: string) {
	useEffect(() => {
		void scopeKey;
		return () => getSpeechController().dismiss();
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
	error: "朗读失败，请重试或检查声音设置。",
};

/** Both the settings page and the in-place popover share this form, without route cleanup. */
function SpeechSettingsForm({ compact = false }: { compact?: boolean }) {
	const { state, controller } = useDeviceSpeech();
	const id = useId();
	const selected = selectedVoice(state);
	const unavailable = speechUnavailableReason(state);
	const previewing =
		state.target?.id === "device-speech-preview" &&
		(state.status === "starting" || state.status === "speaking");
	return (
		<section className="device-speech-settings" aria-labelledby={`${id}-title`}>
			<h3 id={`${id}-title`}>声音与语速</h3>
			{!compact && (
				<p>
					声音由当前浏览器和系统提供；选择与语速仅保存在当前浏览器。不会保存音频文件。
				</p>
			)}
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
				{!compact && (
					<button
						type="button"
						disabled={!previewing && !!unavailable}
						onClick={() =>
							previewing
								? controller.stop()
								: controller.play({
										id: "device-speech-preview",
										text: "こんにちは。日本語の文章を読み上げます。",
										label: "声音试听",
									})
						}
					>
						{previewing ? "停止试听" : "试听"}
					</button>
				)}
			</div>
			<p role="status">
				{unavailable ??
					state.error ??
					(state.target?.id === "device-speech-preview"
						? statusLabels[state.status]
						: "更改声音和语速后，在下一次播放或重播时生效。")}
			</p>
		</section>
	);
}

function SpeechSettingsPopover({ showRate = false }: { showRate?: boolean }) {
	const { state } = useDeviceSpeech();
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const position = useCallback(() => {
		const bounds = trigger.current?.getBoundingClientRect();
		const menu = panel.current;
		if (!bounds || !menu) return;
		menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
		const above = bounds.top - menu.offsetHeight - 8;
		const top = above >= 8 ? above : bounds.bottom + 8;
		menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8))}px`;
	}, []);
	const close = () => {
		panel.current?.hidePopover();
		trigger.current?.focus({ preventScroll: true });
	};
	useEffect(() => {
		const reposition = () => {
			if (panel.current?.matches(":popover-open")) position();
		};
		window.addEventListener("resize", reposition);
		return () => window.removeEventListener("resize", reposition);
	}, [position]);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="device-speech-settings-trigger"
				aria-label="声音与语速"
				aria-haspopup="dialog"
				popoverTarget={id}
				title="声音与语速"
			>
				{showRate ? `${state.preferences.rate}× · 声音` : "声音设置"}
			</button>
			<div
				ref={panel}
				id={id}
				popover="auto"
				role="dialog"
				aria-label="声音与语速"
				className="device-speech-popover"
				onToggle={(event) => {
					if (event.newState !== "open") return;
					position();
					panel.current
						?.querySelector<HTMLElement>("select:not(:disabled),button")
						?.focus({ preventScroll: true });
				}}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					close();
				}}
			>
				<SpeechSettingsForm compact />
				<button
					type="button"
					className="device-speech-popover-close"
					onClick={close}
				>
					关闭声音设置
				</button>
			</div>
		</>
	);
}

export function SpeechControls({
	target,
	compact = false,
	iconOnly = false,
}: {
	target: SpeechTarget;
	compact?: boolean;
	iconOnly?: boolean;
}) {
	const { state, controller } = useDeviceSpeech();
	const reason = speechUnavailableReason(state);
	const action = speechTargetAction(state, target);
	const error = reason ?? (action !== "play" ? state.error : null);
	const label =
		action === "stop"
			? "停止朗读"
			: action === "replay"
				? "重播原文"
				: "朗读原文";
	return (
		<div className="device-speech" data-compact={compact || undefined}>
			<button
				type="button"
				className={iconOnly ? "device-speech-icon" : undefined}
				aria-label={iconOnly ? label : undefined}
				title={iconOnly ? label : undefined}
				disabled={action !== "stop" && (!!reason || !target.text.trim())}
				onClick={() => {
					if (action === "stop") controller.stop();
					else if (action === "replay") controller.replay();
					else controller.play(target);
				}}
			>
				{iconOnly ? (
					<svg
						viewBox="0 0 24 24"
						width="17"
						height="17"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.7"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						{action === "stop" ? (
							<rect
								x="6"
								y="6"
								width="12"
								height="12"
								rx="1"
								fill="currentColor"
								stroke="none"
							/>
						) : (
							<>
								<path d="m11 4-6 5H2v6h3l6 5V4Z" />
								<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
							</>
						)}
					</svg>
				) : (
					label
				)}
			</button>
			{error && (
				<div className="device-speech-message">
					<span role="status">
						{compact ? (reason ? "声音不可用" : "朗读失败") : error}
					</span>
					<SpeechSettingsPopover />
				</div>
			)}
		</div>
	);
}
export function SpeechPlaybackBar() {
	const { state, controller } = useDeviceSpeech();
	if (!state.target) return null;
	const active = state.status === "starting" || state.status === "speaking";
	const unavailable = speechUnavailableReason(state);
	const error =
		state.error ??
		unavailable ??
		(state.status === "error" ? statusLabels.error : null);
	const mode = error ? "error" : active ? "active" : "resting";
	return (
		<section
			className="device-speech device-speech-bar"
			data-state={mode}
			aria-label="当前设备朗读"
		>
			<button
				type="button"
				className="device-speech-primary"
				aria-label={active ? "停止朗读" : "重播原文"}
				disabled={!active && !!unavailable}
				onClick={() => (active ? controller.stop() : controller.replay())}
			>
				{active ? "停止" : "重播"}
			</button>
			<span
				className="device-speech-summary"
				lang="ja"
				title={state.target.text}
			>
				{state.target.text}
			</span>
			<span className="device-speech-sr-status" role="status">
				{statusLabels[state.status]}
			</span>
			<SpeechSettingsPopover showRate />
			<button
				type="button"
				className="device-speech-dismiss"
				aria-label="关闭朗读控制"
				title="关闭朗读控制"
				onClick={() => controller.dismiss()}
			>
				<span aria-hidden="true">×</span>
			</button>
			{error && (
				<p className="device-speech-message" role="status">
					{unavailable ? "声音不可用" : "朗读失败"}，请查看声音设置。
				</p>
			)}
		</section>
	);
}
export function DeviceSpeechSettings() {
	useStopSpeechOnLeave("speech-settings");
	return <SpeechSettingsForm />;
}
