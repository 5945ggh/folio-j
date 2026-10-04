import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import { RequestError } from "./content";

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

export function Shell({
	children,
	fullWidth = false,
}: {
	children: ReactNode;
	fullWidth?: boolean;
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
			<NavLink onClick={() => setDrawer(false)} to="/materials" title="素材库">
				<span aria-hidden="true">▤</span>
				<span className="nav-label">素材库</span>
			</NavLink>
			<NavLink onClick={() => setDrawer(false)} to="/sources" title="Source">
				<span aria-hidden="true">◫</span>
				<span className="nav-label">Source</span>
			</NavLink>
			<NavLink
				onClick={() => setDrawer(false)}
				className="nav-settings"
				to="/settings"
				title="设置"
			>
				<span aria-hidden="true">⚙</span>
				<span className="nav-label">设置</span>
			</NavLink>
		</nav>
	);
	return (
		<div
			className={`app-shell ${collapsed ? "sidebar-collapsed" : ""} ${fullWidth ? "shell-full-width" : ""}`}
		>
			<aside className="app-sidebar">
				<Link className="brand" to="/materials" aria-label="Folio-J 素材库">
					<span className="brand-mark" aria-hidden="true">
						文
					</span>
					<span className="nav-label">Folio-J</span>
				</Link>
				{navigation}
				<button
					className="sidebar-toggle"
					type="button"
					onClick={toggle}
					aria-label={collapsed ? "展开导航" : "收窄导航"}
					title={collapsed ? "展开导航" : "收窄导航"}
				>
					<span aria-hidden="true">{collapsed ? "»" : "«"}</span>
					<span className="nav-label">收窄导航</span>
				</button>
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
				>
					☰
				</button>
				<Link className="brand" to="/materials">
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
						"a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex='0']",
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
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
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
