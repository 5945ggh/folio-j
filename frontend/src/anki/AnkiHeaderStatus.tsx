import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
	type AnkiCollectionInfo,
	ankiKeys,
	getAnkiConnection,
	probeAnkiConnection,
} from "./api";
import "./anki-composer.css";

function AnkiCardIcon() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.65"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="3" y="5" width="18" height="14" rx="2.5" />
			<path d="M12 9v6M9 12h6" />
		</svg>
	);
}

export function AnkiHeaderStatus({
	settingsState,
	externalStatus,
	onStatusChange,
}: {
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
	const wrapRef = useRef<HTMLDivElement>(null);

	const connectionQuery = useQuery({
		queryKey: ankiKeys.connection,
		queryFn: ({ signal }) => getAnkiConnection(signal),
		enabled: open,
		retry: false,
	});

	const probeMutation = useMutation({
		mutationFn: () => probeAnkiConnection(),
		onMutate: () => {
			onStatusChange({ state: "checking" });
		},
		onSuccess: (info) => {
			onStatusChange({ state: "connected", info });
		},
		onError: (error) => {
			onStatusChange({
				state: "error",
				message: error instanceof Error ? error.message : "未能连接 Anki。",
			});
		},
	});

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const statusTitle =
		externalStatus.state === "connected"
			? `已连接 · ${externalStatus.info?.profile ?? ""}`
			: externalStatus.state === "checking"
				? "正在测试…"
				: externalStatus.state === "error"
					? "未连接"
					: "未测试";

	return (
		<div className="anki-topbar-wrap" ref={wrapRef}>
			<button
				type="button"
				className="anki-topbar-btn"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={`Anki 连接状态（${statusTitle}）`}
				title={`Anki：${statusTitle}`}
				onClick={() => setOpen((prev) => !prev)}
			>
				<AnkiCardIcon />
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
							style={{
								fontSize: 12,
								color:
									externalStatus.state === "connected"
										? "var(--color-success, #2a8a4b)"
										: externalStatus.state === "error"
											? "var(--reader-error)"
											: "var(--reader-muted)",
							}}
						>
							{statusTitle}
						</span>
					</div>

					<p className="anki-topbar-popover-meta">
						{externalStatus.state === "connected" && externalStatus.info
							? `AnkiConnect 地址：${externalStatus.info.endpoint}（Anki 用户：${externalStatus.info.profile}）`
							: externalStatus.state === "error"
								? externalStatus.message || "无法连接 AnkiConnect。"
								: `AnkiConnect 地址：${connectionQuery.data?.url ?? "http://127.0.0.1:8765"}`}
					</p>

					<div className="anki-topbar-popover-actions">
						<button
							type="button"
							className="anki-btn-secondary"
							style={{ padding: "4px 9px", fontSize: 12 }}
							disabled={probeMutation.isPending}
							onClick={() => probeMutation.mutate()}
						>
							{probeMutation.isPending ? "正在测试…" : "测试连接"}
						</button>
						<Link
							to="/settings?section=anki"
							state={settingsState}
							className="anki-link-btn"
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
