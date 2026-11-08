import { matchRoutes } from "react-router";
import { settingsReadingReturn } from "../navigation.ts";

const sessionRoutes = [
	{ path: "/materials/:id", id: "reader" },
	{ path: "/segments/:id", id: "segment" },
];

type ReaderSessionRoute =
	| { kind: "reader"; materialId: string }
	| { kind: "segment"; segmentId: string }
	| { kind: "settings"; materialId: string };

/** Uses the page router's matching rules for both host mounting and retention. */
export function readerSessionRoute(
	pathname: string,
	state?: unknown,
): ReaderSessionRoute | null {
	if (/^\/settings\/?$/i.test(pathname)) {
		const reader = settingsReadingReturn(state);
		const match = reader && matchRoutes(sessionRoutes, reader.to)?.[0];
		return match?.route.id === "reader" && match.params.id
			? { kind: "settings", materialId: match.params.id }
			: null;
	}
	const match = matchRoutes(sessionRoutes, pathname)?.[0];
	const id = match?.params.id;
	if (!id) return null;
	return match.route.id === "reader"
		? { kind: "reader", materialId: id }
		: { kind: "segment", segmentId: id };
}
