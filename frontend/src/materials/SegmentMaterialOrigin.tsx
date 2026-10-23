import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import type { Segment } from "../content";
import { returnDestination, returnState } from "../navigation";
import { InlineError } from "../Shared";
import { originFailure } from "./reader-origin";
import { getSegmentProvenance } from "./study-api";

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
	const failure = origin.isSuccess ? originFailure(origin.data) : null;
	return (
		<div className="segment-material-origin" aria-live="polite">
			{origin.isSuccess && !origin.isFetching && origin.data.display && (
				<p>材料出处：{origin.data.display}</p>
			)}
			{origin.isPending || origin.isFetching ? (
				<p>正在核对材料出处…</p>
			) : origin.isError ? (
				<>
					<InlineError error={origin.error} />
					<button type="button" onClick={() => void origin.refetch()}>
						重试核对出处
					</button>
				</>
			) : failure ? (
				<p>{failure}</p>
			) : showReturnLink ? (
				<Link
					to={`/materials/${segment.material_provenance.material_id}?segment=${segment.id}`}
					state={returnState(
						{ to: `${location.pathname}${location.search}`, label: "学习片段" },
						parent,
						`/materials/${segment.material_provenance.material_id}`,
					)}
				>
					返回原文 →
				</Link>
			) : null}
		</div>
	);
}
