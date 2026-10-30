import { dateLabel } from "../Shared";
import type { CatalogSegment } from "./api";
import { segmentOriginParts } from "./segment-origin";

export function SegmentMetadata({ segment }: { segment: CatalogSegment }) {
	const parts = segmentOriginParts(segment);
	const origin = parts.map((part) => part.text).join(" · ");
	return (
		<small className="segment-meta">
			<span className="segment-meta-layout">
				<span className="segment-origin-label" title={origin}>
					{parts.map((part, index) => (
						<span
							className={`segment-origin-part segment-origin-${part.kind}`}
							key={part.kind}
						>
							{index > 0 && (
								<span className="segment-origin-separator"> · </span>
							)}
							<span className="segment-origin-value">{part.text}</span>
						</span>
					))}
				</span>
				<span className="segment-created-at">
					添加于{" "}
					<time dateTime={segment.created_at}>
						{dateLabel(segment.created_at)}
					</time>
				</span>
			</span>
		</small>
	);
}
