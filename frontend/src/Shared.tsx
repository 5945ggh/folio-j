import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import { RequestError } from "./content";
import { handleDialogCancel } from "./dialog-events";

function displayError(error: Error): string {
	if (
		error instanceof TypeError &&
		/failed to fetch|load failed|networkerror|network request failed/i.test(
			error.message,
		)
	)
		return "暂时无法连接服务，请确认服务已启动后重试。";
	return error.message;
}

function NavigationIcon({
	name,
}: {
	name: "book" | "library" | "folder" | "settings";
}) {
	const paths = {
		book: "M12 5v16M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1",
		library: "M3 5h3v15H3zM9 3h3v17H9zM15 5l3-1 4 15-3 1z",
		folder: "M3 7V4h6l3 3h9M3 7h18v13H3z",
		settings:
			"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
	};
	return (
		<svg
			viewBox="0 0 24 24"
			width="20"
			height="20"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	);
}

export function Shell({
	children,
	fullWidth = false,
	className = "",
}: {
	children: ReactNode;
	fullWidth?: boolean;
	className?: string;
}) {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			return localStorage.getItem("folio-sidebar") === "collapsed";
		} catch {
			return false;
		}
	});
	const [drawer, setDrawer] = useState(false);
	function toggle() {
		setCollapsed((value) => {
			const next = !value;
			try {
				localStorage.setItem("folio-sidebar", next ? "collapsed" : "expanded");
			} catch {
				/* UI preferences are optional. */
			}
			return next;
		});
	}
	const navigation = (
		<nav className="app-navigation" aria-label="主导航">
			<NavLink
				onClick={() => setDrawer(false)}
				to="/materials"
				aria-label="素材库"
				title={collapsed ? undefined : "素材库"}
				data-tooltip="素材库"
			>
				<span aria-hidden="true">
					<NavigationIcon name="library" />
				</span>
				<span className="nav-label">素材库</span>
			</NavLink>
			<NavLink
				onClick={() => setDrawer(false)}
				to="/sources"
				aria-label="来源目录"
				title={collapsed ? undefined : "来源目录"}
				data-tooltip="来源目录"
			>
				<span aria-hidden="true">
					<NavigationIcon name="folder" />
				</span>
				<span className="nav-label">来源目录</span>
			</NavLink>
			<NavLink
				onClick={() => setDrawer(false)}
				className="nav-settings"
				to="/settings"
				aria-label="设置"
				title={collapsed ? undefined : "设置"}
				data-tooltip="设置"
			>
				<span aria-hidden="true">
					<NavigationIcon name="settings" />
				</span>
				<span className="nav-label">设置</span>
			</NavLink>
		</nav>
	);
	return (
		<div
			className={`app-shell ${className} ${collapsed ? "sidebar-collapsed" : ""} ${fullWidth ? "shell-full-width" : ""}`}
		>
			<aside className="app-sidebar">
				<div className="sidebar-brand-row">
					<Link
						className="brand"
						to="/materials"
						aria-label="Folio-J 素材库"
						title="Folio-J 素材库"
					>
						<img className="brand-mark" src="/folio-mark.svg" alt="" />
						<span className="nav-label">Folio-J</span>
					</Link>
					<button
						className="sidebar-toggle"
						type="button"
						onClick={toggle}
						aria-label={collapsed ? "展开导航" : "收窄导航"}
						title={collapsed ? undefined : "收窄导航"}
						data-tooltip="展开导航"
					>
						<svg
							viewBox="0 0 24 24"
							width="18"
							height="18"
							aria-hidden="true"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<rect x="3" y="4" width="18" height="16" rx="2" />
							<path d="M9 4v16" />
						</svg>
					</button>
				</div>
				{navigation}
			</aside>
			<header className="mobile-topbar">
				<button
					className="button secondary"
					type="button"
					onClick={(event) => {
						event.currentTarget.focus();
						setDrawer(true);
					}}
					aria-label="打开主导航"
					title="打开主导航"
				>
					☰
				</button>
				<Link className="brand" to="/materials">
					<img className="brand-mark" src="/folio-mark.svg" alt="" />
					Folio-J
				</Link>
			</header>
			<main className="page-content">{children}</main>
			{drawer && (
				<ConfirmDialog
					className="navigation-drawer"
					titleId="navigation-title"
					onClose={() => setDrawer(false)}
				>
					<div className="section-heading">
						<h2 id="navigation-title">Folio-J</h2>
						<button
							className="button secondary"
							data-dialog-cancel
							type="button"
							onClick={() => setDrawer(false)}
						>
							关闭
						</button>
					</div>
					{navigation}
				</ConfirmDialog>
			)}
		</div>
	);
}
export function PageError({
	error,
	retry,
}: {
	error: Error;
	retry?: () => void;
}) {
	const missing = error instanceof RequestError && error.status === 404;
	return (
		<Shell>
			<div className="state-card" role="alert">
				<h1>{missing ? "找不到这条记录" : "暂时无法加载"}</h1>
				<p>{displayError(error)}</p>
				<div className="actions">
					<Link className="button secondary" to="/sources">
						返回来源目录
					</Link>
					{retry && !missing && (
						<button className="button primary" type="button" onClick={retry}>
							重试
						</button>
					)}
				</div>
			</div>
		</Shell>
	);
}
export function Loading() {
	return (
		<Shell>
			<p className="loading" role="status">
				正在加载资料…
			</p>
		</Shell>
	);
}
export function InlineError({ error }: { error: Error | null }) {
	return error ? (
		<p className="inline-error" role="alert">
			{displayError(error)}
		</p>
	) : null;
}

export function ConfirmDialog({
	titleId,
	onClose,
	children,
	className = "",
	restoreFocusId,
}: {
	titleId: string;
	className?: string;
	restoreFocusId?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		const previous = document.activeElement;
		element?.showModal();
		element?.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.focus();
		return () => {
			element?.close();
			if (
				previous instanceof HTMLElement &&
				previous.isConnected &&
				previous !== document.body
			)
				previous.focus();
			else if (restoreFocusId) document.getElementById(restoreFocusId)?.focus();
		};
	}, [restoreFocusId]);
	return (
		<dialog
			ref={dialog}
			className={`confirm-card ${className}`}
			aria-labelledby={titleId}
			onKeyDown={(event) => {
				if (event.key !== "Tab") return;
				const controls = Array.from(
					event.currentTarget.querySelectorAll<HTMLElement>(
						"a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex='0']",
					),
				).filter((control) => control.getClientRects().length > 0);
				const first = controls[0];
				const last = controls.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}}
			onCancel={(event) => handleDialogCancel(event, onClose)}
		>
			{children}
		</dialog>
	);
}
export function dateLabel(value: string) {
	return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(
		new Date(value),
	);
}
