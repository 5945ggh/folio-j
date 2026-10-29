import type { Location } from "react-router";

export type ReaderLeaveKind = "segment" | "copy";
export type ReaderLeaveParticipant = {
	kind: ReaderLeaveKind;
	shouldBlock: (destination: Location) => boolean;
	beforeUnload: () => boolean;
};
type LeaveState = {
	location: Location | null;
	participantId: string | null;
	attempt: number;
	action: "proceed" | "reset" | null;
};

/** One navigation is released only after each protected Reader draft agrees. */
export function createReaderLeaveCoordinator() {
	const participants = new Map<string, ReaderLeaveParticipant>();
	const accepted = new Set<string>();
	const listeners = new Set<() => void>();
	let state: LeaveState = {
		location: null,
		participantId: null,
		attempt: 0,
		action: null,
	};
	const publish = (patch: Partial<LeaveState>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const protectedParticipants = (location: Location) =>
		Array.from(participants.entries())
			.filter(([, participant]) => participant.shouldBlock(location))
			.sort(([, first], [, second]) =>
				first.kind === second.kind ? 0 : first.kind === "segment" ? -1 : 1,
			);
	const nextParticipant = () => {
		if (!state.location) return;
		const next = protectedParticipants(state.location).find(
			([id]) => !accepted.has(id),
		);
		publish({
			participantId: next?.[0] ?? null,
			action: next ? null : "proceed",
		});
	};
	return {
		getSnapshot: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		register(id: string, participant: ReaderLeaveParticipant) {
			participants.set(id, participant);
			if (
				state.location &&
				state.action === "proceed" &&
				!accepted.has(id) &&
				participant.shouldBlock(state.location)
			)
				nextParticipant();
			return () => {
				if (participants.get(id) !== participant) return;
				participants.delete(id);
				if (
					state.location &&
					!state.action &&
					!accepted.has(id) &&
					(id === state.participantId ||
						participant.shouldBlock(state.location))
				) {
					// Disappearing UI is not consent to lose an unresolved draft.
					publish({ participantId: null, action: "reset" });
				}
			};
		},
		shouldBlock: (location: Location) =>
			protectedParticipants(location).length > 0,
		beforeUnload: () =>
			Array.from(participants.values()).some((entry) => entry.beforeUnload()),
		begin(location: Location) {
			if (state.location?.key === location.key) return;
			accepted.clear();
			state = {
				location,
				participantId: null,
				attempt: state.attempt + 1,
				action: null,
			};
			nextParticipant();
		},
		end() {
			if (!state.location) return;
			accepted.clear();
			publish({
				location: null,
				participantId: null,
				attempt: state.attempt + 1,
				action: null,
			});
		},
		proceed(id: string, attempt: number) {
			if (
				state.attempt !== attempt ||
				state.participantId !== id ||
				state.action
			)
				return;
			accepted.add(id);
			nextParticipant();
		},
		reset(id: string, attempt: number) {
			if (
				state.attempt === attempt &&
				state.participantId === id &&
				!state.action
			)
				publish({ participantId: null, action: "reset" });
		},
	};
}
