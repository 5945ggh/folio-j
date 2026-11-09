import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, type LinkProps, useLocation } from "react-router";
import { Icon } from "../catalog/LibraryTools";
import { getSegment, getSource, queries } from "../content";
import { getMaterial, materialKeys } from "../materials/api";
import { getSegmentProvenance } from "../materials/study-api";
import {
	type ReturnDestination,
	settingsPageReturn,
	settingsReturnState,
} from "../navigation";
import "./settings-reading-return.css";

/** Preserve the learning page's return trail while moving between settings sections. */
export function SettingsLink(props: Omit<LinkProps, "state">) {
	const location = useLocation();
	return <Link {...props} state={settingsReturnState(location)} />;
}

export function SettingsReadingReturn() {
	const location = useLocation();
	const reader = settingsPageReturn(location.state);
	return reader ? <ReadingReturn key={reader.to} reader={reader} /> : null;
}

/** Optional context reuses the learning page's cache and never gates navigation. */
function SegmentReturnIdentity({ segmentId }: { segmentId: string }) {
	const segment = useQuery({
		queryKey: queries.segment(segmentId),
		queryFn: () => getSegment(segmentId),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const sourceId = segment.data?.source_id ?? "";
	const source = useQuery({
		queryKey: queries.source(sourceId),
		queryFn: () => getSource(sourceId),
		enabled: segment.isSuccess && Boolean(sourceId),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const reference = segment.data?.material_provenance;
	const origin = useQuery({
		queryKey: ["segments", segmentId, "material-provenance"],
		queryFn: ({ signal }) => getSegmentProvenance(segmentId, signal),
		enabled: segment.isSuccess && Boolean(reference),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const text = segment.isSuccess
		? segment.data.text.trim().replace(/\s+/gu, " ")
		: "";
	// Bound the live-region announcement as well as the visible two-line preview.
	const characters = [...text];
	const excerpt =
		characters.length > 120 ? `${characters.slice(0, 120).join("")}…` : text;
	const sourceTitle =
		source.isSuccess && source.data.id === sourceId
			? source.data.title.trim()
			: "";
	const bookTitle =
		reference &&
		origin.isSuccess &&
		origin.data.segment_id === segmentId &&
		origin.data.status === "resolved" &&
		origin.data.material_provenance?.material_id === reference.material_id
			? origin.data.title?.trim()
			: undefined;
	const sourceLabel = sourceTitle
		? `来源：${sourceTitle}`
		: segment.isError || source.isError
			? "来源信息暂不可用"
			: "正在读取来源…";
	const attribution = `${sourceLabel}${bookTitle ? ` · 《${bookTitle}》` : ""}`;
	return (
		<>
			<p
				className="settings-reading-notice-excerpt"
				lang={excerpt ? "ja" : undefined}
				title={excerpt || undefined}
			>
				{excerpt ? `「${excerpt}」` : "学习片段"}
			</p>
			<p className="settings-reading-notice-source" title={attribution}>
				{attribution}
			</p>
		</>
	);
}

function ReadingReturn({ reader }: { reader: ReturnDestination }) {
	const isReader = reader.to.startsWith("/materials/");
	const entryId =
		new URL(reader.to, "https://folio.invalid").pathname.split("/")[2] ?? "";
	const book = useQuery({
		queryKey: materialKeys.book(entryId),
		queryFn: () => getMaterial(entryId),
		// Reuse the book already loaded by the reader; direct settings entries can read its title.
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		enabled: isReader,
	});
	const title =
		book.data?.title || (reader.label !== "阅读" ? reader.label : "原书");
	const action = isReader ? "继续阅读" : "返回片段";
	const accessibleLabel = isReader ? `继续阅读《${title}》` : "返回学习片段";
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
				aria-label={accessibleLabel}
				title={accessibleLabel}
			>
				<span aria-hidden="true">←</span>
				<span>{action}</span>
				{isReader && (
					<span className="settings-reading-return-title">《{title}》</span>
				)}
			</Link>
			{!dismissed && (
				<aside
					className="settings-reading-notice"
					aria-label={isReader ? "阅读返回提示" : "片段返回提示"}
				>
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
							{isReader ? "刚才在读" : "刚才在看"}
						</p>
						{isReader && (
							<p className="settings-reading-notice-title" title={title}>
								《{title}》
							</p>
						)}
						{!isReader && <SegmentReturnIdentity segmentId={entryId} />}
					</div>
					<button
						className="settings-reading-notice-close"
						type="button"
						aria-label={isReader ? "关闭阅读返回提示" : "关闭片段返回提示"}
						title={`关闭提示，仍可从页头${action}`}
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
						{action} <span aria-hidden="true">→</span>
					</Link>
				</aside>
			)}
		</>
	);
}
