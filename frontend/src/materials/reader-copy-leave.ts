import { readerSessionRoute } from "../navigation/reader-session-route.ts";

export function shouldBlockReaderCopyLeave(
	materialId: string,
	nextPathname: string,
	protectedChanges: boolean,
) {
	const next = readerSessionRoute(nextPathname);
	return (
		protectedChanges &&
		!(next?.kind === "reader" && next.materialId === materialId)
	);
}

/** Cancelling a navigation cancels only the intent, never the submitted write. */
export function createReaderCopyLeaveAttempt() {
	let generation = 0;
	let waiting: Promise<void> | null = null;
	return {
		cancel() {
			generation += 1;
			waiting = null;
		},
		wait(save: () => Promise<boolean>, complete: (saved: boolean) => void) {
			if (waiting) return waiting;
			const started = generation;
			waiting = Promise.resolve()
				.then(save)
				.catch(() => false)
				.then((saved) => {
					if (started !== generation) return;
					waiting = null;
					complete(saved);
				});
			return waiting;
		},
	};
}
