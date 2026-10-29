import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { type Location, useBeforeUnload, useBlocker } from "react-router";
import {
	createReaderLeaveCoordinator,
	type ReaderLeaveKind,
} from "./reader-leave-coordinator";

type Coordinator = ReturnType<typeof createReaderLeaveCoordinator>;
const ReaderLeaveContext = createContext<{
	coordinator: Coordinator;
	dialogHost?: Element | null;
} | null>(null);

/** Route ownership controls the router hook; query readiness never does. */
export function ReaderLeaveProvider({
	active,
	dialogHost,
	children,
}: {
	active: boolean;
	dialogHost?: Element | null;
	children: ReactNode;
}) {
	const [coordinator] = useState(createReaderLeaveCoordinator);
	return (
		<ReaderLeaveContext value={{ coordinator, dialogHost }}>
			{children}
			{active && <ReaderLeaveRouter coordinator={coordinator} />}
		</ReaderLeaveContext>
	);
}

function ReaderLeaveRouter({ coordinator }: { coordinator: Coordinator }) {
	const blocker = useBlocker(({ nextLocation }) =>
		coordinator.shouldBlock(nextLocation),
	);
	const blockerRef = useRef(blocker);
	blockerRef.current = blocker;
	const state = useSyncExternalStore(
		coordinator.subscribe,
		coordinator.getSnapshot,
	);
	const completed = useRef<string | null>(null);
	useBeforeUnload(
		useCallback(
			(event) => {
				if (coordinator.beforeUnload()) {
					event.preventDefault();
					event.returnValue = "";
				}
			},
			[coordinator],
		),
	);
	useEffect(() => {
		if (blocker.state === "blocked") coordinator.begin(blocker.location);
		else {
			completed.current = null;
			coordinator.end();
		}
	}, [blocker, coordinator]);
	useEffect(() => {
		const current = blockerRef.current;
		const latest = coordinator.getSnapshot();
		if (
			current.state !== "blocked" ||
			!state.action ||
			!latest.action ||
			latest.location?.key !== current.location.key
		)
			return;
		const completion = `${latest.attempt}:${latest.action}`;
		if (completed.current === completion) return;
		completed.current = completion;
		if (latest.action === "proceed") current.proceed();
		else current.reset();
	}, [state, coordinator]);
	useEffect(() => () => coordinator.end(), [coordinator]);
	return null;
}

/** A participant sees a blocker only while its own draft is being resolved. */
export function useReaderLeaveBlocker(
	kind: ReaderLeaveKind,
	shouldBlock: (destination: Location) => boolean,
	beforeUnload: () => boolean,
): ReturnType<typeof useBlocker> {
	const context = useContext(ReaderLeaveContext);
	if (!context) throw new Error("Reader 离开保护需要 ReaderLeaveProvider。");
	const { coordinator } = context;
	const id = useId();
	const latest = useRef({ shouldBlock, beforeUnload });
	latest.current = { shouldBlock, beforeUnload };
	useLayoutEffect(
		() =>
			coordinator.register(id, {
				kind,
				shouldBlock: (destination) => latest.current.shouldBlock(destination),
				beforeUnload: () => latest.current.beforeUnload(),
			}),
		[coordinator, id, kind],
	);
	const state = useSyncExternalStore(
		coordinator.subscribe,
		coordinator.getSnapshot,
	);
	if (state.participantId === id && state.location && !state.action)
		return {
			state: "blocked",
			location: state.location,
			proceed: () => coordinator.proceed(id, state.attempt),
			reset: () => coordinator.reset(id, state.attempt),
		};
	return {
		state: "unblocked",
		location: undefined,
		proceed: undefined,
		reset: undefined,
	};
}

/** Keep confirmation dialogs visible while the retained Reader is suspended. */
export function ReaderLeaveDialog({ children }: { children: ReactNode }) {
	const context = useContext(ReaderLeaveContext);
	return context?.dialogHost
		? createPortal(children, context.dialogHost)
		: children;
}
