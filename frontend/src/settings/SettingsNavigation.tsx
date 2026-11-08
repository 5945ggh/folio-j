import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, type LinkProps, useLocation } from "react-router";
import { Icon } from "../catalog/LibraryTools";
import { getMaterial, materialKeys } from "../materials/api";
import {
	type ReturnDestination,
	settingsReadingReturn,
	settingsReturnState,
} from "../navigation";
import "./settings-reading-return.css";

/** Preserve a reader's return trail while moving between settings sections. */
export function SettingsLink(props: Omit<LinkProps, "state">) {
	const location = useLocation();
	return <Link {...props} state={settingsReturnState(location)} />;
}

export function SettingsReadingReturn() {
	const location = useLocation();
	const reader = settingsReadingReturn(location.state);
	return reader ? <ReadingReturn key={reader.to} reader={reader} /> : null;
}

function ReadingReturn({ reader }: { reader: ReturnDestination }) {
	const materialId =
		new URL(reader.to, "https://folio.invalid").pathname.split("/")[2] ?? "";
	const book = useQuery({
		queryKey: materialKeys.book(materialId),
		queryFn: () => getMaterial(materialId),
		// Reuse the book already loaded by the reader; direct settings entries can read its title.
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const title =
		book.data?.title || (reader.label !== "阅读" ? reader.label : "原书");
	const [dismissed, setDismissed] = useState(false);
	const headerLink = useRef<HTMLAnchorElement>(null);
	return (
		<>
			<Link
				ref={headerLink}
				id="settings-reading-return"
				className="settings-reading-return"
				to={reader.to}
				state={reader.state}
				aria-label={`继续阅读《${title}》`}
				title={`继续阅读《${title}》`}
			>
				<span aria-hidden="true">←</span>
				<span>继续阅读</span>
				<span className="settings-reading-return-title">《{title}》</span>
			</Link>
			{!dismissed && (
				<aside className="settings-reading-notice" aria-label="阅读返回提示">
					<span className="settings-reading-notice-icon" aria-hidden="true">
						<Icon name="book" />
					</span>
					<div
						className="settings-reading-notice-copy"
						role="status"
						aria-live="polite"
						aria-atomic="true"
					>
						<p className="settings-reading-notice-context">
							正在为这本书调整设置
						</p>
						<p className="settings-reading-notice-title" title={title}>
							《{title}》
						</p>
					</div>
					<button
						className="settings-reading-notice-close"
						type="button"
						aria-label="关闭阅读返回提示"
						title="关闭提示，仍可从页头继续阅读"
						onClick={() => {
							setDismissed(true);
							headerLink.current?.focus();
						}}
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="m6 6 12 12M18 6 6 18" />
						</svg>
					</button>
					<Link
						className="settings-reading-notice-action"
						to={reader.to}
						state={reader.state}
					>
						继续阅读 <span aria-hidden="true">→</span>
					</Link>
				</aside>
			)}
		</>
	);
}
