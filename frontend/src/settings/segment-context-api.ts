import { api } from "../api/client";
import type { components } from "../api/schema";
import { RequestError, requireData } from "../content";

export type SegmentContextSettings =
	components["schemas"]["SegmentContextSettingsResponse"];
export type ContextBudget = Omit<SegmentContextSettings, "revision">;
export type SegmentContextSettingsUpdate =
	components["schemas"]["SegmentContextSettingsUpdate"];
export { segmentContextKey } from "./segment-context-cache";

export async function getSegmentContextSettings(signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/settings/segment-context",
		{ signal },
	);
	return requireData(data, error, response.status);
}

export async function saveSegmentContextSettings(
	body: SegmentContextSettingsUpdate,
) {
	const { data, error, response } = await api.PUT(
		"/api/settings/segment-context",
		{ body },
	);
	if (response.status === 409)
		throw new RequestError("语境设置已在其他页面更新。", 409);
	return requireData(data, error, response.status);
}
