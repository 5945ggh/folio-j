import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
	type AnkiCollectionInfo,
	ankiKeys,
	getAnkiConnection,
	probeAnkiConnection,
} from "./api";
import "./anki-composer.css";

export function AnkiHeaderStatus({
	active = true,
	activation = 0,
	settingsState,
	externalStatus,
	onStatusChange,
}: {
	active?: boolean;
	activation?: number;
	settingsState: unknown;
	externalStatus: {
		state: "idle" | "checking" | "connected" | "error";
		info?: AnkiCollectionInfo;
		message?: string;
	};
	onStatusChange: (next: {
		state: "idle" | "checking" | "connected" | "error";
		info?: AnkiCollectionInfo;
		message?: string;
	}) => void;
}) {
	const [open, setOpen] = useState(false);
	const [probing, setProbing] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const requestSeqRef = useRef(0);
	const probingRef = useRef(false);
	const activeRef = useRef(active);
	activeRef.current = active;
	const statusRef = useRef(externalStatus);
	statusRef.current = externalStatus;
	const onStatusChangeRef = useRef(onStatusChange);
	onStatusChangeRef.current = onStatusChange;

	const connectionQuery = useQuery({
		queryKey: ankiKeys.connection,
		queryFn: ({ signal }) => getAnkiConnection(signal),
		enabled: open,
		retry: false,
	});

	const runProbe = useCallback((options: { showChecking: boolean }) => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		const seq = ++requestSeqRef.current;
		probingRef.current = true;
		setProbing(true);
		if (options.showChecking) {
			onStatusChangeRef.current({ state: "checking" });
		}
		probeAnkiConnection(undefined, controller.signal).then(
			(info) => {
				if (
					controller.signal.aborted ||
					seq !== requestSeqRef.current ||
					!activeRef.current
				)
					return;
				probingRef.current = false;
				setProbing(false);
				onStatusChangeRef.current({ state: "connected", info });
			},
			(error) => {
				if (
					controller.signal.aborted ||
					seq !== requestSeqRef.current ||
					!activeRef.current
				)
					return;
				probingRef.current = false;
				setProbing(false);
				onStatusChangeRef.current({
					state: "error",
					message: error instanceof Error ? error.message : "未能连接 Anki。",
				});
			},
		);
	}, []);

	// Probe silently when entering the reader or returning from another view (e.g. Anki settings).
	useEffect(() => {
		if (!active) {
			abortRef.current?.abort();
			abortRef.current = null;
			probingRef.current = false;
			setProbing(false);
			setOpen(false);
			return;
		}
		void activation;
		runProbe({ showChecking: false });
		return () => {
			abortRef.current?.abort();
			abortRef.current = null;
			probingRef.current = false;
		};
	}, [active, activation, runProbe]);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.isComposing ||
				event.keyCode === 229 ||
				(event.target instanceof Element &&
					event.target.closest("dialog[open]"))
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus({ preventScroll: true });
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	const handleToggle = () => {
		const next = !open;
		setOpen(next);
		if (
			next &&
			!probingRef.current &&
			(statusRef.current.state === "idle" ||
				statusRef.current.state === "error")
		) {
			runProbe({ showChecking: true });
		}
	};

	const effectiveState =
		probing && (open || externalStatus.state === "checking")
			? "checking"
			: externalStatus.state;

	const statusTitle =
		effectiveState === "connected"
			? "已连接"
			: effectiveState === "checking"
				? "正在测试…"
				: effectiveState === "error"
					? "未连接"
					: "未测试";

	return (
		<div className="anki-topbar-wrap" ref={wrapRef}>
			<button
				ref={triggerRef}
				type="button"
				className="anki-topbar-btn"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={`Anki 连接状态（${statusTitle}）`}
				title={`Anki：${statusTitle}`}
				onClick={handleToggle}
			>
				<span>Anki</span>
				{externalStatus.state === "connected" && (
					<span className="anki-topbar-dot" aria-hidden="true" />
				)}
			</button>

			{open && (
				<div
					className="anki-topbar-popover reader-popover"
					role="dialog"
					aria-label="Anki 连接状态"
				>
					<div className="anki-topbar-popover-head">
						<span>Anki 导出</span>
						<span
							className="anki-topbar-popover-status"
							data-state={effectiveState}
						>
							{statusTitle}
						</span>
					</div>

					<p className="anki-topbar-popover-meta">
						{effectiveState === "connected" && externalStatus.info
							? `AnkiConnect 地址：${externalStatus.info.endpoint}（Anki 用户：${externalStatus.info.profile}）`
							: effectiveState === "error"
								? externalStatus.message || "无法连接 AnkiConnect。"
								: `AnkiConnect 地址：${connectionQuery.data?.url ?? "http://127.0.0.1:8765"}`}
					</p>

					<div className="anki-topbar-popover-actions">
						<button
							type="button"
							className="anki-topbar-test-btn"
							disabled={probing}
							onClick={() => runProbe({ showChecking: true })}
						>
							{probing ? "正在测试…" : "测试连接"}
						</button>
						<Link
							to="/settings?section=anki"
							state={settingsState}
							className="anki-link-btn anki-topbar-settings-link"
							onClick={() => setOpen(false)}
						>
							Anki 设置 →
						</Link>
					</div>
				</div>
			)}
		</div>
	);
}
