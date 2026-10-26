import { useEffect, useMemo, useState } from "react";
import { matchRoutes, useLocation } from "react-router";
import {
	advanceRetainedSession,
	DEFAULT_RETENTION_MS,
	emptyRetainedSession,
} from "../navigation/retained-session";
import { ViewActivityProvider } from "../navigation/view-activity";
import {
	MaterialReaderSession,
	type ReaderSessionEntry,
} from "./MaterialReader";

const readerRoute = [{ path: "/materials/:id" }];

/** Keeps one reading session across Segment visits without replacing router context. */
export function ReaderSessionHost() {
	const location = useLocation();
	const materialId = matchRoutes(readerRoute, location)?.[0]?.params.id;
	const current = useMemo(
		() =>
			materialId ? { key: materialId, value: { materialId, location } } : null,
		[materialId, location],
	);
	const [state, setState] = useState(emptyRetainedSession<ReaderSessionEntry>);
	const next = advanceRetainedSession(
		state,
		current,
		/^\/segments\/[^/]+$/.test(location.pathname),
		Date.now(),
	);
	if (next !== state) setState(next);
	useEffect(() => {
		if (state.expiresAt === null) return;
		const deadline = state.expiresAt;
		let timer: ReturnType<typeof setTimeout>;
		const expire = () => {
			const remaining = deadline - Date.now();
			if (remaining > 0) {
				timer = setTimeout(expire, remaining);
				return;
			}
			setState((previous) =>
				previous.active || previous.expiresAt !== deadline
					? previous
					: advanceRetainedSession(
							previous,
							null,
							true,
							Date.now(),
							DEFAULT_RETENTION_MS,
						),
			);
		};
		timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
		return () => clearTimeout(timer);
	}, [state.expiresAt]);
	const activity = useMemo(
		() => ({ active: state.active, activation: state.activation }),
		[state.active, state.activation],
	);
	if (!state.entry) return null;
	return (
		<div
			key={state.instance}
			data-retained-view={state.active ? "active" : "paused"}
			hidden={!state.active}
			inert={!state.active}
			aria-hidden={!state.active || undefined}
		>
			<ViewActivityProvider value={activity}>
				<MaterialReaderSession entry={state.entry.value} />
			</ViewActivityProvider>
		</div>
	);
}
