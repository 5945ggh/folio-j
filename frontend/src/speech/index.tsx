import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
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
function SpeechRate({ onPreferenceChange }: { onPreferenceChange(): void }) {
	const { state, controller } = useDeviceSpeech();
	const id = useId();
	const change = (rate: number) => {
		if (rate === state.preferences.rate) return;
		controller.setRate(rate);
		onPreferenceChange();
	};
	return (
		<div className="device-speech-rate">
			<div className="device-speech-rate-heading">
				<label htmlFor={id}>语速</label>
				<div className="device-speech-rate-actions">
					<output htmlFor={id}>{state.preferences.rate.toFixed(1)}×</output>
					<button type="button" onClick={() => change(1)}>
						恢复默认
					</button>
				</div>
			</div>
			<input
				id={id}
				type="range"
				min={MIN_SPEECH_RATE}
				max={MAX_SPEECH_RATE}
				step="0.1"
				aria-label="朗读语速"
				aria-valuetext={`${state.preferences.rate} 倍速`}
				value={state.preferences.rate}
				onChange={(event) => change(Number(event.target.value))}
			/>
			<div className="device-speech-rate-presets">
				{[0.5, 1, 1.5].map((rate) => (
					<button
						key={rate}
						type="button"
						data-current={state.preferences.rate === rate || undefined}
						onClick={() => change(rate)}
					>
						{rate.toFixed(1)}×
					</button>
				))}
			</div>
		</div>
	);
}
const statusLabels = {
	idle: "尚未播放",
	starting: "等待设备开始",
	speaking: "正在朗读",
	paused: "已暂停",
	stopped: "已停止",
	ended: "朗读结束",
	error: "朗读失败，请重试或检查声音设置。",
};

/** Both the settings page and the in-place popover share this form, without route cleanup. */
function SpeechSettingsForm({ compact = false }: { compact?: boolean }) {
	const { state, controller } = useDeviceSpeech();
	const id = useId();
	const [preferenceHint, setPreferenceHint] = useState(false);
	const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (hintTimer.current) clearTimeout(hintTimer.current);
		},
		[],
	);
	const announcePreferenceChange = () => {
		setPreferenceHint(true);
		if (hintTimer.current) clearTimeout(hintTimer.current);
		hintTimer.current = setTimeout(() => setPreferenceHint(false), 3500);
	};
	const selected = selectedVoice(state);
	const unavailable = speechUnavailableReason(state);
	const previewing =
		state.target?.id === "device-speech-preview" &&
		(state.status === "starting" ||
			state.status === "speaking" ||
			state.status === "paused");
	return (
		<section
			className="device-speech-settings"
			data-compact={compact || undefined}
			aria-labelledby={`${id}-title`}
		>
			<h3 id={`${id}-title`}>朗读设置</h3>
			{!compact && (
				<p>
					声音由当前浏览器和系统提供；选择与语速仅保存在当前浏览器。不会保存音频文件。
				</p>
			)}
			<div className="device-speech-voice">
				<label htmlFor={`${id}-voice`}>日语声音</label>
				<div className="device-speech-voice-select">
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
						onChange={(event) => {
							controller.setVoice(
								event.target.value === "auto"
									? null
									: (state.voices[Number(event.target.value)] ?? null),
							);
							announcePreferenceChange();
						}}
					>
						<option value="auto">自动选择（优先本地）</option>
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
					<SpeechIcon action="chevron" />
				</div>
				{selected && (
					<p className="device-speech-voice-detail">
						<svg
							viewBox="0 0 20 20"
							width="15"
							height="15"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<circle cx="10" cy="10" r="7.5" />
							<path d="m6.5 10 2.3 2.3 4.7-4.8" />
						</svg>
						<span>
							当前使用 {selected.name} ·{" "}
							{selected.localService ? "本地" : "远端"}
						</span>
					</p>
				)}
			</div>
			<SpeechRate onPreferenceChange={announcePreferenceChange} />
			{!compact && (
				<div className="device-speech">
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
				</div>
			)}
			<details className="device-speech-more">
				<summary>
					<svg
						viewBox="0 0 20 20"
						width="16"
						height="16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M2 5h4m4 0h8M2 15h8m4 0h4" />
						<circle cx="8" cy="5" r="2" />
						<circle cx="12" cy="15" r="2" />
					</svg>
					<span>更多选项</span>
					<SpeechIcon action="chevron" />
				</summary>
				<div className="device-speech">
					<button
						type="button"
						disabled={!state.supported}
						onClick={() => controller.refresh()}
					>
						重新检测声音
					</button>
				</div>
			</details>
			{(unavailable ||
				state.error ||
				preferenceHint ||
				state.target?.id === "device-speech-preview") && (
				<p className="device-speech-settings-status" role="status">
					{unavailable ??
						state.error ??
						(preferenceHint
							? "已保存，将在下次播放或重播时使用。"
							: statusLabels[state.status])}
				</p>
			)}
		</section>
	);
}

function SpeechSettingsPopover({ showRate = false }: { showRate?: boolean }) {
	const { state } = useDeviceSpeech();
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
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
		const observer = new ResizeObserver(reposition);
		if (panel.current) observer.observe(panel.current);
		window.addEventListener("resize", reposition);
		window.addEventListener("scroll", reposition, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
		};
	}, [position]);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="device-speech-settings-trigger"
				aria-label="声音与语速"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={id}
				popoverTarget={id}
				title="声音与语速"
			>
				{showRate ? (
					<>
						<span>{state.preferences.rate}×</span>
						<SpeechIcon action="chevron" />
					</>
				) : (
					"声音设置"
				)}
			</button>
			<div
				ref={panel}
				id={id}
				popover="auto"
				role="dialog"
				aria-label="朗读设置"
				tabIndex={-1}
				className="device-speech-popover"
				onToggle={(event) => {
					setOpen(event.newState === "open");
					if (event.newState !== "open") {
						if (
							panel.current?.contains(document.activeElement) ||
							document.activeElement === document.body
						)
							trigger.current?.focus({ preventScroll: true });
						return;
					}
					position();
					panel.current?.focus({ preventScroll: true });
				}}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					close();
				}}
			>
				<SpeechSettingsForm compact />
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
		action === "pause"
			? "暂停朗读"
			: action === "resume"
				? "继续朗读"
				: action === "stop"
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
				disabled={
					(action === "play" || action === "replay") &&
					(!!reason || !target.text.trim())
				}
				onClick={() => {
					if (action === "pause") controller.pause();
					else if (action === "resume") controller.resume();
					else if (action === "stop") controller.stop();
					else if (action === "replay") controller.replay();
					else controller.play(target);
				}}
			>
				{iconOnly ? (
					<SpeechIcon action={action === "play" ? "volume" : action} />
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
type PlaybackAction = "play" | "pause" | "resume" | "stop" | "replay";
function SpeechIcon({
	action,
}: {
	action: PlaybackAction | "volume" | "chevron" | "close";
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="18"
			height="18"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{action === "pause" ? (
				<path d="M8 5v14M16 5v14" strokeWidth="3" />
			) : action === "stop" ? (
				<rect
					x="6"
					y="6"
					width="12"
					height="12"
					rx="1"
					fill="currentColor"
					stroke="none"
				/>
			) : action === "replay" ? (
				<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" />
			) : action === "volume" ? (
				<>
					<path d="m11 4-6 5H2v6h3l6 5V4Z" />
					<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
				</>
			) : action === "chevron" ? (
				<path d="m8 10 4 4 4-4" />
			) : action === "close" ? (
				<path d="m6 6 12 12M18 6 6 18" />
			) : (
				<path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none" />
			)}
		</svg>
	);
}
export function SpeechPlaybackBar() {
	const { state, controller } = useDeviceSpeech();
	if (!state.target) return null;
	const active = state.status === "starting" || state.status === "speaking";
	const action = speechTargetAction(state, state.target);
	const label =
		action === "resume"
			? "继续朗读"
			: action === "pause"
				? "暂停朗读"
				: action === "stop"
					? "停止朗读"
					: "重播原文";
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
				data-action={action}
				aria-label={label}
				title={label}
				disabled={action === "replay" && !!unavailable}
				onClick={() => {
					if (action === "pause") controller.pause();
					else if (action === "resume") controller.resume();
					else if (action === "stop") controller.stop();
					else controller.replay();
				}}
			>
				<SpeechIcon action={action} />
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
				aria-label="关闭并停止朗读"
				title="关闭并停止朗读"
				onClick={() => controller.dismiss()}
			>
				<SpeechIcon action="close" />
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
