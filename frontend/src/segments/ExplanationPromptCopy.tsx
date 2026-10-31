import { useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { api } from "../api/client";
import { requireData } from "../content";
import "./explanation-prompt-copy.css";

type CopyState =
	| { status: "idle" }
	| { status: "reading" }
	| { status: "copying" }
	| { status: "copied" }
	| { status: "read-error" }
	| { status: "clipboard-error"; prompt: string };

async function getExplanationPrompt(segmentId: string, signal: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/segments/{segment_id}/explanation-prompt",
		{ params: { path: { segment_id: segmentId } }, signal },
	);
	return requireData(data, error, response.status).prompt;
}

/** Both the clipboard write and its receipt belong to the initiating segment. */
export function useExplanationPromptCopy(segmentId: string, disabled: boolean) {
	const client = useQueryClient();
	const attempt = useRef(0);
	const scope = useRef({ segmentId, disabled });
	const [state, setState] = useState<CopyState>({ status: "idle" });
	const dismiss = useCallback(() => {
		attempt.current++;
		setState({ status: "idle" });
		void client.cancelQueries({
			queryKey: ["segments", segmentId, "explanation-prompt"],
			exact: true,
		});
	}, [client, segmentId]);
	useLayoutEffect(() => {
		scope.current = { segmentId, disabled };
		dismiss();
		return () => {
			attempt.current++;
			void client.cancelQueries({
				queryKey: ["segments", segmentId, "explanation-prompt"],
				exact: true,
			});
		};
	}, [client, segmentId, disabled, dismiss]);
	const copy = async (preparedPrompt?: string) => {
		if (disabled) return;
		const serial = ++attempt.current;
		const current = () =>
			serial === attempt.current &&
			scope.current.segmentId === segmentId &&
			!scope.current.disabled;
		setState({ status: preparedPrompt === undefined ? "reading" : "copying" });
		const read = (
			preparedPrompt === undefined
				? client.fetchQuery({
						queryKey: ["segments", segmentId, "explanation-prompt"],
						queryFn: ({ signal }) => getExplanationPrompt(segmentId, signal),
						retry: false,
						staleTime: 0,
						gcTime: 0,
					})
				: Promise.resolve(preparedPrompt)
		).then((prompt) => {
			if (typeof prompt !== "string" || !prompt.trim())
				throw new Error("Empty explanation prompt");
			if (!current()) throw new Error("Retired explanation prompt copy");
			return prompt;
		});
		let pendingWrite: Promise<void> | undefined;
		if (preparedPrompt !== undefined) {
			// Retrying retained text must also start synchronously in this gesture.
			try {
				pendingWrite = navigator.clipboard.writeText(preparedPrompt);
				void pendingWrite.catch(() => undefined);
			} catch {
				// The complete text remains available if the Clipboard API is absent.
			}
		} else if (
			navigator.clipboard?.write &&
			typeof ClipboardItem !== "undefined"
		) {
			// WebKit requires starting the clipboard write during the initiating gesture.
			// The promised payload checks scope before it can reach the clipboard.
			const payload = read.then(
				(prompt) => new Blob([prompt], { type: "text/plain" }),
			);
			void payload.catch(() => undefined);
			try {
				pendingWrite = navigator.clipboard.write([
					new ClipboardItem({ "text/plain": payload }),
				]);
				void pendingWrite.catch(() => undefined);
			} catch {
				// Older implementations may reject promised ClipboardItem payloads.
			}
		}
		let prompt: string;
		try {
			prompt = await read;
		} catch {
			if (current()) setState({ status: "read-error" });
			return;
		}
		if (!current()) return;
		setState({ status: "copying" });
		try {
			if (pendingWrite) await pendingWrite;
			else await navigator.clipboard.writeText(prompt);
			if (current()) setState({ status: "copied" });
		} catch {
			if (current()) setState({ status: "clipboard-error", prompt });
		}
	};
	return { state, copy, dismiss };
}

export function ExplanationPromptCopyFeedback({
	state,
	onCopy,
	onDismiss,
	trigger,
}: {
	state: CopyState;
	onCopy: (prompt?: string) => Promise<void>;
	onDismiss: () => void;
	trigger: { current: HTMLButtonElement | null };
}) {
	const text = useRef<HTMLTextAreaElement>(null);
	const feedback = useRef<HTMLFieldSetElement>(null);
	const dismissRef = useRef(onDismiss);
	dismissRef.current = onDismiss;
	useEffect(() => {
		if (state.status !== "copied") return;
		const timer = setTimeout(() => dismissRef.current(), 5000);
		return () => clearTimeout(timer);
	}, [state]);
	useLayoutEffect(() => {
		if (
			state.status === "clipboard-error" &&
			document.activeElement === trigger.current
		)
			text.current?.focus({ preventScroll: true });
	}, [state, trigger]);
	const dismiss = () => {
		if (feedback.current?.contains(document.activeElement))
			trigger.current?.focus({ preventScroll: true });
		onDismiss();
	};
	const retry = (prompt?: string) => {
		trigger.current?.focus({ preventScroll: true });
		void onCopy(prompt);
	};
	const fallback = state.status === "clipboard-error";
	return (
		<fieldset
			ref={feedback}
			aria-label="讲解提示词复制反馈"
			className={`segment-prompt-feedback${fallback ? " segment-prompt-fallback" : ""}`}
			hidden={state.status === "idle"}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !event.nativeEvent.isComposing) {
					event.preventDefault();
					event.stopPropagation();
					dismiss();
				}
			}}
		>
			<div className="segment-prompt-feedback-line">
				<p role="status" aria-live="polite" aria-atomic="true">
					{state.status === "reading"
						? "正在读取讲解提示词…"
						: state.status === "copying"
							? "正在复制讲解提示词…"
							: state.status === "copied"
								? "已复制讲解提示词"
								: state.status === "read-error"
									? "讲解提示词读取失败。"
									: fallback
										? "复制失败，可选择下方文本手动复制。"
										: ""}
				</p>
				<button
					type="button"
					aria-label="关闭讲解提示词复制提示"
					onClick={dismiss}
				>
					×
				</button>
			</div>
			{state.status === "read-error" && (
				<button type="button" onClick={() => retry()}>
					重试读取并复制
				</button>
			)}
			{fallback && (
				<>
					<textarea
						ref={text}
						aria-label="讲解提示词，可手动复制"
						readOnly
						value={state.prompt}
					/>
					<div className="segment-prompt-copy-actions">
						<button type="button" onClick={() => text.current?.select()}>
							选择文本
						</button>
						<button type="button" onClick={() => retry(state.prompt)}>
							重试复制
						</button>
					</div>
				</>
			)}
		</fieldset>
	);
}
