import { matchRoutes } from "react-router";

const sessionRoutes = [
	{ path: "/materials/:id", id: "reader" },
	{ path: "/segments/:id", id: "segment" },
];

type ReaderSessionRoute =
	| { kind: "reader"; materialId: string }
	| { kind: "segment"; segmentId: string };

/** Uses the page router's matching rules for both host mounting and retention. */
export function readerSessionRoute(
	pathname: string,
): ReaderSessionRoute | null {
	const match = matchRoutes(sessionRoutes, pathname)?.[0];
	const id = match?.params.id;
	if (!id) return null;
	return match.route.id === "reader"
		? { kind: "reader", materialId: id }
		: { kind: "segment", segmentId: id };
}
