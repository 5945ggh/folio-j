import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ReturnDestination } from "../navigation";
import { SettingsLink } from "../settings/SettingsNavigation";

function ToolIcon({
	name,
}: {
	name: "home" | "back" | "chat" | "more" | "settings";
}) {
	return (
		<svg
			aria-hidden="true"
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{name === "home" ? (
				<path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" />
			) : name === "settings" ? (
				<>
					<path d="m9.5 3-.6 2.2-2 .9-2-.6-2.5 4.3L4 11.4v2.2l-1.6 1.6L5 19.5l2-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2 .6 2.5-4.3-1.6-1.6v-2.2l1.6-1.6L19 5.5l-2 .6-2-.9-.5-2.2z" />
					<circle cx="12" cy="12.5" r="3" />
				</>
			) : name === "back" ? (
				<path d="m14 5-7 7 7 7M7 12h12" />
			) : name === "chat" ? (
				<path d="M20 11.5a8 8 0 0 1-8 8 8.5 8.5 0 0 1-3.3-.7L4 20l1.2-4.7A8 8 0 1 1 20 11.5Z" />
			) : (
				<>
					<circle cx="5" cy="12" r="1" />
					<circle cx="12" cy="12" r="1" />
					<circle cx="19" cy="12" r="1" />
				</>
			)}
		</svg>
	);
}

/** Focused page chrome, independent of the global navigation preference. */
export function SegmentFrame({
	children,
	returnTo,
	chatOpen,
	available,
	onToggleDiscussion,
	onEdit,
	onDelete,
}: {
	children: ReactNode;
	returnTo: ReturnDestination;
	chatOpen: boolean;
	available: boolean;
	onToggleDiscussion: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!available) setMenuOpen(false);
	}, [available]);
	useEffect(() => {
		if (!menuOpen) return;
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !menu.current?.contains(event.target))
				setMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setMenuOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [menuOpen]);
	return (
		<div className="app-shell segment-study-shell">
			<nav className="segment-tools" aria-label="片段工具">
				<Link
					className="segment-tool"
					to="/"
					aria-label="首页（素材库）"
					title="首页（素材库）"
				>
					<ToolIcon name="home" />
					<span className="segment-tool-mobile-label">首页</span>
					<span className="segment-tool-label">首页（素材库）</span>
				</Link>
				<Link
					className="segment-tool"
					to={returnTo.to}
					state={returnTo.state}
					aria-label={`返回${returnTo.label}`}
					title={`返回${returnTo.label}`}
				>
					<ToolIcon name="back" />
					<span className="segment-tool-mobile-label">返回</span>
					<span className="segment-tool-label">返回{returnTo.label}</span>
				</Link>
				<div className="segment-tool-group">
					<button
						id="segment-discussion-toggle"
						className="segment-tool"
						type="button"
						disabled={!available}
						aria-label={chatOpen ? "收起讨论" : "展开讨论"}
						title={chatOpen ? "收起讨论" : "展开讨论"}
						aria-expanded={chatOpen && available}
						aria-controls="segment-conversation"
						onClick={onToggleDiscussion}
					>
						<ToolIcon name="chat" />
						<span className="segment-tool-mobile-label">讨论</span>
						<span className="segment-tool-label">
							{chatOpen ? "收起讨论" : "展开讨论"}
						</span>
					</button>
				</div>
				<div className="segment-tool-more" ref={menu}>
					<button
						ref={trigger}
						id="segment-more-trigger"
						className="segment-tool"
						type="button"
						disabled={!available}
						aria-label="片段更多操作"
						title="片段更多操作"
						aria-expanded={menuOpen}
						aria-controls="segment-tools-menu"
						onClick={() => setMenuOpen(!menuOpen)}
					>
						<ToolIcon name="more" />
						<span className="segment-tool-mobile-label">更多</span>
						<span className="segment-tool-label">片段更多操作</span>
					</button>
					{menuOpen && (
						<div className="segment-tools-menu" id="segment-tools-menu">
							<button
								type="button"
								onClick={() => {
									setMenuOpen(false);
									onEdit();
								}}
							>
								编辑片段资料
							</button>
							<button
								className="text-danger"
								type="button"
								onClick={() => {
									setMenuOpen(false);
									onDelete();
								}}
							>
								删除片段…
							</button>
						</div>
					)}
				</div>
				<SettingsLink
					className="segment-tool segment-settings-link"
					to="/settings"
					aria-label="全局设置"
					title="全局设置"
				>
					<ToolIcon name="settings" />
					<span className="segment-tool-mobile-label">设置</span>
					<span className="segment-tool-label">全局设置</span>
				</SettingsLink>
			</nav>
			<main className="segment-study-main">
				{children}
				<div id="segment-overlays" />
			</main>
		</div>
	);
}
