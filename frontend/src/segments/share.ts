import type { QueryObserverResult } from "@tanstack/react-query";
import type { Segment } from "../content.ts";
import type { SegmentProvenance } from "../materials/study-api.ts";

type ShareSegment = Pick<
	Segment,
	"id" | "text" | "context_before" | "context_after" | "source_ref"
>;

export function segmentShareText(
	segment: ShareSegment,
	sourceTitle?: string,
	query?: Pick<
		QueryObserverResult<SegmentProvenance>,
		"data" | "isSuccess" | "isFetching"
	>,
) {
	const provenance =
		query?.isSuccess && !query.isFetching ? query.data : undefined;
	const origin: string[] = [];
	let title = "";
	if (provenance?.segment_id === segment.id) {
		title = provenance.title?.trim() ?? "";
		if (title)
			origin.push(
				title.startsWith("《") && title.endsWith("》") ? title : `《${title}》`,
			);
		if (provenance.status === "resolved" && provenance.chapter_title?.trim())
			origin.push(provenance.chapter_title.trim());
	}
	if (!title && sourceTitle?.trim()) origin.unshift(sourceTitle.trim());
	const sourceRef = segment.source_ref.trim();
	if (sourceRef && sourceRef !== title && !origin.includes(sourceRef))
		origin.push(sourceRef);
	const source = origin.join("\n");
	const hasContext = !!(
		segment.context_before.trim() || segment.context_after.trim()
	);
	const sections: string[] = [];
	if (segment.context_before.trim()) sections.push(segment.context_before);
	sections.push(
		hasContext
			? segment.text
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n")
			: segment.text,
	);
	if (segment.context_after.trim()) sections.push(segment.context_after);
	if (source) sections.push(`——${source}`);
	return { full: sections.join("\n\n"), original: segment.text, source };
}
