import type { QueryClient } from "@tanstack/react-query";
import type { SegmentContextSettings } from "./segment-context-api";

export const segmentContextKey = ["segment-context-settings"] as const;

export async function commitSegmentContextResponse(
	client: QueryClient,
	response: SegmentContextSettings,
	accept: (persisted: SegmentContextSettings) => void,
) {
	await client.cancelQueries({ queryKey: segmentContextKey });
	const persisted = client.setQueryData<SegmentContextSettings>(
		segmentContextKey,
		(current) =>
			current && current.revision > response.revision ? current : response,
	);
	if (persisted) accept(persisted);
}
