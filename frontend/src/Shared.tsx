import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";
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

export function Shell({ children }: { children: ReactNode }) {
	return (
		<div className="app-shell">
			<header className="topbar">
				<Link className="brand" to="/" aria-label="Folio-J 素材目录">
					<span className="brand-mark" aria-hidden="true">
						文
					</span>
					<span>Folio-J</span>
				</Link>
				<span className="topbar-label">日语学习资料</span>
			</header>
			<main className="page-content">{children}</main>
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
					<Link className="button secondary" to="/">
						返回素材目录
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
}: {
	titleId: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => element?.close();
	}, []);
	return (
		<dialog
			ref={dialog}
			className="confirm-card"
			aria-labelledby={titleId}
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
