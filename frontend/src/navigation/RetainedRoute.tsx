import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type Location,
	matchPath,
	Route,
	Routes,
	useLocation,
} from "react-router";
import {
	advanceRetainedSession,
	DEFAULT_RETENTION_MS,
	emptyRetainedSession,
} from "./retained-session";

type ViewActivity = { active: boolean; activation: number };
export const ViewActivityContext = createContext<ViewActivity>({
	active: true,
	activation: 0,
});

/** Effects and asynchronous work consult activity; final unmount still disposes resources. */
export function useViewActivity() {
	return useContext(ViewActivityContext);
}

export function ViewActivityProvider({
	value,
	children,
}: {
	value: ViewActivity;
	children: ReactNode;
}) {
	return <ViewActivityContext value={value}>{children}</ViewActivityContext>;
}

/**
 * Keeps one component route's DOM and location/params for a bounded excursion.
 * Views pause work through activity; data-router loaders/actions stay outside this scope.
 * Routes' location override reports POP inside the view, so navigation-type policies
 * must be supplied separately if a future consumer depends on PUSH/REPLACE.
 */
export function RetainedRoute({
	path,
	retainOn,
	retentionMs = DEFAULT_RETENTION_MS,
	children,
}: {
	path: string;
	retainOn: (location: Location) => boolean;
	retentionMs?: number;
	children: ReactNode;
}) {
	const location = useLocation();
	const match = matchPath(path, location.pathname);
	const [state, setState] = useState(emptyRetainedSession<Location>);
	const current = match ? { key: match.pathname, value: location } : null;
	const next = advanceRetainedSession(
		state,
		current,
		retainOn(location),
		Date.now(),
		retentionMs,
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
							retentionMs,
						),
			);
		};
		timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
		return () => clearTimeout(timer);
	}, [state.expiresAt, retentionMs]);
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
				<Routes location={state.entry.value}>
					<Route path={path} element={children} />
				</Routes>
			</ViewActivityProvider>
		</div>
	);
}
