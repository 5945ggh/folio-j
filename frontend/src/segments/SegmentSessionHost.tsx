import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import {
	advanceRetainedSession,
	emptyRetainedSession,
} from "../navigation/retained-session";
import { ViewActivityProvider } from "../navigation/view-activity";
import { SegmentDetail, type SegmentSessionEntry } from "../SegmentPage";
import { segmentSessionRoute } from "./segment-session-route";

/** Keeps one Segment and its drafts mounted during its explicit settings visit. */
export function SegmentSessionHost() {
	const location = useLocation();
	const route = segmentSessionRoute(location.pathname, location.state);
	const segmentId = route?.kind === "segment" ? route.segmentId : undefined;
	const current = useMemo(
		() =>
			segmentId ? { key: segmentId, value: { segmentId, location } } : null,
		[segmentId, location],
	);
	const [state, setState] = useState(emptyRetainedSession<SegmentSessionEntry>);
	const next = advanceRetainedSession(
		state,
		current,
		route?.kind === "settings" && state.entry?.key === route.segmentId,
		Date.now(),
		// Drafts survive the entire settings visit; leaving its route scope releases them.
		null,
	);
	if (next !== state) setState(next);
	const activity = useMemo(
		() => ({ active: state.active, activation: state.activation }),
		[state.active, state.activation],
	);
	if (!state.entry) return null;
	return (
		<div
			key={state.instance}
			data-segment-session={state.active ? "active" : "paused"}
			hidden={!state.active}
			inert={!state.active}
			aria-hidden={!state.active || undefined}
		>
			<ViewActivityProvider value={activity}>
				<SegmentDetail entry={state.entry.value} />
			</ViewActivityProvider>
		</div>
	);
}
