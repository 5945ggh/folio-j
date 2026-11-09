import { api } from "../api/client";
import { requireData } from "../content";

export async function getDataLocation(signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/settings/data-location",
		{ signal },
	);
	return requireData(data, error, response.status);
}
