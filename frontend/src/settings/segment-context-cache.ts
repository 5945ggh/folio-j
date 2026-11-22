import type { QueryClient } from "@tanstack/react-query";
import type { SegmentContextSettings } from "./segment-context-api";
import { commitVersionedSettings } from "./versioned-settings.ts";

export const segmentContextKey = ["segment-context-settings"] as const;

export async function commitSegmentContextResponse(
	client: QueryClient,
	response: SegmentContextSettings,
	accept: (persisted: SegmentContextSettings) => void,
) {
	accept(await commitVersionedSettings(client, segmentContextKey, response));
}
