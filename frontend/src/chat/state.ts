import type { JobInput, Thread } from "./api";

export type Draft = { question: string; additional: string };

export function draftAfterAcceptance(
	current: Draft,
	submitted: JobInput,
): Draft {
	return current.question === submitted.question &&
		current.additional === submitted.additional_instructions
		? { question: "", additional: "" }
		: current;
}

export function submissionMayHaveSucceeded(error: unknown): boolean {
	if (error && typeof error === "object" && "status" in error) {
		const status = error.status;
		return typeof status !== "number" || status === 0 || status >= 500;
	}
	return true;
}

export function threadChanged(
	previous: Pick<Thread, "revision" | "active_job_id"> | null,
	current: Pick<Thread, "revision" | "active_job_id">,
): boolean {
	return (
		previous !== null &&
		(current.revision > previous.revision ||
			previous.active_job_id !== current.active_job_id)
	);
}
