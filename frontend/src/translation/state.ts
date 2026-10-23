import type { MaterialProvenance } from "../materials/study-api.ts";
import type { TranslationInput } from "./api.ts";

/** Identity excludes display chapter, selection rectangles and annotation generations. */
export function translationTargetKey(reference: MaterialProvenance): string {
	return JSON.stringify([
		reference.material_id,
		reference.version_id,
		reference.contract_version,
		reference.ranges.map(
			({ resource_id, spine_index, start, end, exact, text_sha256 }) => [
				resource_id,
				spine_index,
				start,
				end,
				exact,
				text_sha256,
			],
		),
	]);
}
export function targetText(reference: MaterialProvenance): string {
	return reference.ranges
		.map((range) => range.exact)
		.join("")
		.normalize("NFC");
}

/** A lost response may only retry its frozen request; editing creates a new identity. */
export class TranslationSubmission<T> {
	private pending: { key: string; request: T } | null = null;
	prepare(key: string, create: () => T): T {
		if (this.pending && this.pending.key !== key)
			throw new Error("上次提交尚未核实，请先重试原请求。");
		this.pending ??= { key, request: create() };
		return this.pending.request;
	}
	get current(): T | undefined {
		return this.pending?.request;
	}
	clear() {
		this.pending = null;
	}
}

export type TranslationBudget = {
	before_sentences: number;
	before_characters: number;
	after_sentences: number;
	after_characters: number;
};

/** Reader-owned state survives keyed target remounts and late submission responses. */
export type TranslationSession = {
	version: number;
	listeners: Set<() => void>;
	request: TranslationSubmission<TranslationInput>;
	pending: boolean;
	uncertain: boolean;
	autoStartConsumed: boolean;
	taskId: string | null;
	error: Error | null;
	draft?: {
		before: string;
		after: string;
		budget: TranslationBudget;
		edited: boolean;
		initialized: boolean;
		localError: Error | null;
	};
};
export function createTranslationSession(): TranslationSession {
	return {
		version: 0,
		listeners: new Set(),
		request: new TranslationSubmission<TranslationInput>(),
		pending: false,
		uncertain: false,
		autoStartConsumed: false,
		taskId: null,
		error: null,
	};
}
export function notifyTranslationSession(session: TranslationSession) {
	session.version++;
	for (const listener of session.listeners) listener();
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
export function targetIdentity(reference: MaterialProvenance): Promise<string> {
	return sha256(
		JSON.stringify([
			reference.material_id,
			reference.version_id,
			reference.ranges.map((r) => [
				r.resource_id,
				r.spine_index,
				r.start,
				r.end,
			]),
		]),
	);
}
export function activeTranslation(
	task: { status: string } | undefined,
): boolean {
	return !!task && ["queued", "running", "stopping"].includes(task.status);
}
