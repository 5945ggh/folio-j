import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import type { Segment } from "../content";
import { returnDestination, returnState } from "../navigation";
import { InlineError } from "../Shared";
import { originFailure } from "./reader-origin";
import { getSegmentProvenance } from "./study-api";
import "./segment-material-origin.css";

/** Historical Segment text stays visible while the location is checked independently. */
export function SegmentMaterialOrigin({
	segment,
	showReturnLink = true,
}: {
	segment: Segment;
	showReturnLink?: boolean;
}) {
	const location = useLocation();
	const parent = returnDestination(location.state, {
		to: `/sources/${segment.source_id}`,
		label: "所属来源",
	});
	const origin = useQuery({
		queryKey: ["segments", segment.id, "material-provenance"],
		queryFn: ({ signal }) => getSegmentProvenance(segment.id, signal),
		enabled: !!segment.material_provenance,
		refetchOnMount: "always",
	});
	if (!segment.material_provenance) return null;
	// A dialog mounts another observer of this query. Keep the last verified
	// identity in place while it refreshes, but wait for verification to navigate.
	const saved = origin.data;
	const failure = saved ? originFailure(saved) : null;
	const title = saved?.title;
	const chapter = saved && !failure ? saved.chapter_title : null;
	return (
		<section
			className="segment-material-origin"
			aria-label="材料出处"
			aria-live="polite"
			aria-busy={origin.isFetching}
		>
			{(title || chapter) && (
				<div className="segment-material-origin-identity">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M12 5.5C8.5 3.5 5 3.5 2 5v15c3-1.5 6.5-1.5 10 .5 3.5-2 7-2 10-.5V5c-3-1.5-6.5-1.5-10 .5Z" />
						<path d="M12 5.5v15" />
					</svg>
					<div className="segment-material-origin-text">
						{title && (
							<p className="segment-material-origin-title" title={title}>
								{title}
							</p>
						)}
						{chapter && (
							<p className="segment-material-origin-chapter" title={chapter}>
								{chapter}
							</p>
						)}
					</div>
				</div>
			)}
			{origin.isPending ? (
				<p className="segment-material-origin-status">正在核对材料出处…</p>
			) : origin.isError ? (
				<div className="segment-material-origin-status">
					<InlineError error={origin.error} />
					<button
						type="button"
						disabled={origin.isFetching}
						onClick={() => void origin.refetch()}
					>
						重试核对出处
					</button>
				</div>
			) : failure ? (
				<p className="segment-material-origin-status">{failure}</p>
			) : showReturnLink && origin.isFetching ? (
				<span
					className="segment-material-origin-link"
					aria-disabled="true"
					title="正在核对材料出处"
				>
					在原文中定位 →
				</span>
			) : showReturnLink ? (
				<Link
					className="segment-material-origin-link"
					to={`/materials/${segment.material_provenance.material_id}?segment=${segment.id}`}
					state={returnState(
						{ to: `${location.pathname}${location.search}`, label: "学习片段" },
						parent,
						`/materials/${segment.material_provenance.material_id}`,
					)}
				>
					在原文中定位 →
				</Link>
			) : null}
		</section>
	);
}
