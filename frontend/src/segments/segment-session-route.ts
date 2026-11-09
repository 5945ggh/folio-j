import { matchRoutes } from "react-router";
import { settingsPageReturn } from "../navigation.ts";

const segmentRoutes = [{ path: "/segments/:id" }];

/** Only the explicit settings round trip can retain the current Segment. */
export function segmentSessionRoute(pathname: string, state?: unknown) {
	const settings = /^\/settings\/?$/i.test(pathname);
	const destination = settings ? settingsPageReturn(state)?.to : pathname;
	const match = destination
		? matchRoutes(segmentRoutes, destination)?.[0]
		: null;
	const segmentId = match?.params.id;
	return segmentId
		? {
				kind: settings ? ("settings" as const) : ("segment" as const),
				segmentId,
			}
		: null;
}
