import type {
	MaterialProvenance,
	StudyTarget,
} from "../materials/study-api.ts";
import { prefillContext } from "../materials/study-context.ts";
import type {
	getTranslationHistory,
	TranslationInput,
	TranslationRemoval,
	TranslationSettings,
	TranslationTask,
} from "./api.ts";
import {
	activeTranslation,
	type TranslationBudget,
	targetText,
	translationTargetKey,
} from "./state.ts";

export type TranslationHistory = Awaited<
	ReturnType<typeof getTranslationHistory>
>;

/** Query owns server facts. The session owns eligibility, input and response identity. */
export interface TranslationQueryAdapter {
	settings(): Promise<TranslationSettings>;
	history(reference: MaterialProvenance): Promise<TranslationHistory>;
	peekHistory(reference: MaterialProvenance): TranslationHistory | undefined;
	hasActiveTask(
		reference: MaterialProvenance,
		acceptedTaskId: string | null,
	): boolean;
	submit(materialId: string, input: TranslationInput): Promise<TranslationTask>;
	accept(task: TranslationTask): void;
	stop(taskId: string): Promise<TranslationTask>;
	remove(reference: MaterialProvenance): Promise<TranslationRemoval>;
	uuid(): string;
}
export type TranslationOutcome =
	| { kind: "accepted"; key: string; requestId: string; taskId: string }
	| {
			kind: "not-executed";
			reason:
				| "busy"
				| "uncertain"
				| "inactive"
				| "history"
				| "model"
				| "draft"
				| "automatic"
				| "no-request";
	  }
	| { kind: "failed" | "uncertain"; error: Error };
export type TranslationSnapshot = Readonly<{
	draft: Readonly<{
		before: string;
		after: string;
		budget: Readonly<TranslationBudget>;
		initialized: boolean;
		edited: boolean;
		budgetEdited: boolean;
		localError: Error | null;
	}>;
	phase: "idle" | "submitting" | "uncertain" | "removing";
	acceptedTaskId: string | null;
	error: Error | null;
}>;
export type TranslationEdit =
	| { kind: "context"; before?: string; after?: string }
	| { kind: "budget"; value: TranslationBudget }
	| { kind: "refill" };
export interface TranslationSession {
	readonly key: string;
	readonly reference: MaterialProvenance;
	getSnapshot(): TranslationSnapshot;
	subscribe(listener: () => void): () => void;
	open(intent: {
		kind: "selection" | "history";
		newSelection?: boolean;
	}): Promise<TranslationOutcome>;
	edit(change: TranslationEdit): boolean;
	browseHistory(): void;
	execute(command: {
		kind: "translate" | "verify";
	}): Promise<TranslationOutcome>;
	stop(taskId: string): Promise<TranslationTask>;
	remove(): Promise<TranslationRemoval>;
}
export interface TranslationSessions {
	bindOwner(): () => void;
	forTarget(sourceId: string, target: StudyTarget): TranslationSession;
}

const failure = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));
const skipped = (
	reason: Extract<TranslationOutcome, { kind: "not-executed" }>["reason"],
): TranslationOutcome => ({ kind: "not-executed", reason });
function copyReference(reference: MaterialProvenance): MaterialProvenance {
	return Object.freeze({
		...reference,
		ranges: Object.freeze(
			reference.ranges.map((range) => Object.freeze({ ...range })),
		),
	}) as MaterialProvenance;
}
function snapshot(value: TranslationSnapshot): TranslationSnapshot {
	return Object.freeze({
		...value,
		draft: Object.freeze({
			...value.draft,
			budget: Object.freeze({ ...value.draft.budget }),
		}),
	});
}
export const emptyTranslationSnapshot: TranslationSnapshot = snapshot({
	draft: {
		before: "",
		after: "",
		budget: {
			before_sentences: 3,
			before_characters: 200,
			after_sentences: 0,
			after_characters: 0,
		},
		initialized: false,
		edited: false,
		budgetEdited: false,
		localError: null,
	},
	phase: "idle",
	acceptedTaskId: null,
	error: null,
});

export function createTranslationSessions(
	adapter: TranslationQueryAdapter,
): TranslationSessions {
	let epoch = 0;
	let bound = false;
	const sessions = new Map<string, TargetSession>();
	class TargetSession implements TranslationSession {
		readonly key: string;
		readonly reference: MaterialProvenance;
		private state = emptyTranslationSnapshot;
		private listeners = new Set<() => void>();
		private automatic: "none" | "waiting" | "consumed" = "none";
		private preparation: { epoch: number; promise: Promise<void> } | null =
			null;
		private generation = 0;
		private removal: Promise<TranslationRemoval> | null = null;
		private freshEpoch = -1;
		private initialization: Promise<void> | null = null;
		private operation: {
			posted: boolean;
			epoch: number;
		} | null = null;
		private frozen: TranslationInput | null = null;
		private chapter: WeakRef<StudyTarget["chapter"]> | undefined;
		private sourceId: string;
		constructor(sourceId: string, reference: MaterialProvenance) {
			this.sourceId = sourceId;
			this.reference = copyReference(reference);
			this.key = translationTargetKey(reference);
		}
		attach(target: StudyTarget) {
			if (this.chapter?.deref() !== target.chapter)
				this.chapter = new WeakRef(target.chapter);
		}
		getSnapshot = () => this.state;
		subscribe = (listener: () => void) => {
			this.listeners.add(listener);
			return () => {
				this.listeners.delete(listener);
			};
		};
		private update(value: Partial<TranslationSnapshot>) {
			this.state = snapshot({ ...this.state, ...value });
			for (const listener of this.listeners) listener();
		}
		private initialize(): Promise<void> {
			const chapter = this.chapter?.deref();
			if (this.state.draft.initialized || !chapter) return Promise.resolve();
			if (this.initialization) return this.initialization;
			this.initialization = adapter
				.settings()
				.then((settings) => {
					if (this.state.draft.initialized) return;
					const draft = this.state.draft;
					const budget = draft.budgetEdited
						? draft.budget
						: {
								before_sentences: settings.before_sentences,
								before_characters: settings.before_characters,
								after_sentences: settings.after_sentences,
								after_characters: settings.after_characters,
							};
					try {
						const fill = prefillContext(chapter, this.reference, {
							...budget,
							enabled: true,
						});
						this.update({
							draft: {
								...draft,
								budget,
								...(!draft.edited
									? { before: fill.before, after: fill.after }
									: {}),
								initialized: true,
								localError: null,
							},
						});
					} catch (error) {
						this.update({
							draft: {
								...draft,
								budget,
								initialized: true,
								localError: failure(error),
							},
						});
					}
				})
				.finally(() => {
					this.initialization = null;
				});
			return this.initialization;
		}
		private prepareHistory(
			currentEpoch: number,
			refresh = false,
		): Promise<void> {
			const generation = this.generation;
			if (!refresh && this.freshEpoch === currentEpoch)
				return Promise.resolve();
			if (this.preparation?.epoch === currentEpoch)
				return this.preparation.promise;
			const promise = adapter
				.history(this.reference)
				.then(() => {
					if (bound && epoch === currentEpoch && this.generation === generation)
						this.freshEpoch = currentEpoch;
				})
				.finally(() => {
					if (this.preparation?.promise === promise) this.preparation = null;
				});
			this.preparation = { epoch: currentEpoch, promise };
			return promise;
		}
		open = async ({
			kind,
			newSelection = false,
		}: {
			kind: "selection" | "history";
			newSelection?: boolean;
		}): Promise<TranslationOutcome> => {
			if (this.state.phase === "removing") return skipped("busy");
			if (kind === "selection" && newSelection) this.automatic = "none";
			if (kind === "selection" && this.automatic === "none")
				this.automatic = "waiting";
			const currentEpoch = epoch;
			const generation = this.generation;
			try {
				await Promise.all([
					this.initialize(),
					this.prepareHistory(currentEpoch),
				]);
			} catch {
				return skipped("history");
			}
			if (!bound || epoch !== currentEpoch || this.generation !== generation)
				return skipped("inactive");
			if (kind !== "selection" || this.automatic !== "waiting")
				return skipped("automatic");
			const history = adapter.peekHistory(this.reference);
			if (!history || this.freshEpoch !== currentEpoch)
				return skipped("history");
			if (
				history.results.length ||
				history.tasks.some(activeTranslation) ||
				history.next_offset !== null
			) {
				this.automatic = "consumed";
				return skipped("automatic");
			}
			if (!this.state.draft.initialized || this.state.draft.localError)
				return skipped("draft");
			return this.run({ kind: "translate" }, true);
		};
		edit = (change: TranslationEdit): boolean => {
			const draft = this.state.draft;
			if (change.kind === "budget") {
				this.update({
					draft: {
						...draft,
						budget: {
							before_sentences: change.value.before_sentences,
							before_characters: change.value.before_characters,
							after_sentences: change.value.after_sentences,
							after_characters: change.value.after_characters,
						},
						budgetEdited: true,
					},
				});
				return true;
			}
			if (
				this.state.phase !== "idle" ||
				adapter.hasActiveTask(this.reference, this.state.acceptedTaskId)
			)
				return false;
			if (change.kind === "context") {
				if (
					(change.before === undefined || change.before === draft.before) &&
					(change.after === undefined || change.after === draft.after) &&
					draft.edited
				)
					return true;
				this.update({
					draft: {
						...draft,
						...(change.before !== undefined ? { before: change.before } : {}),
						...(change.after !== undefined ? { after: change.after } : {}),
						edited: true,
					},
				});
				return true;
			}
			const chapter = this.chapter?.deref();
			if (!chapter) return false;
			try {
				const fill = prefillContext(chapter, this.reference, {
					...draft.budget,
					enabled: true,
				});
				this.update({
					draft: {
						...draft,
						before: fill.before,
						after: fill.after,
						edited: true,
						localError: null,
					},
				});
			} catch (error) {
				this.update({ draft: { ...draft, localError: failure(error) } });
			}
			return true;
		};
		browseHistory = () => {
			this.automatic = "consumed";
		};
		execute: TranslationSession["execute"] = (command) =>
			this.run(command, false);
		private run(
			command: Parameters<TranslationSession["execute"]>[0],
			automatic: boolean,
		): Promise<TranslationOutcome> {
			if (this.operation || this.state.phase === "removing")
				return Promise.resolve(skipped("busy"));
			if (command.kind !== "verify" && this.state.phase === "uncertain")
				return Promise.resolve(skipped("uncertain"));
			if (command.kind === "verify" && !this.frozen)
				return Promise.resolve(skipped("no-request"));
			if (!bound) return Promise.resolve(skipped("inactive"));
			const currentEpoch = epoch;
			const draft = this.state.draft;
			const values =
				command.kind === "verify"
					? null
					: {
							source_id: this.sourceId,
							material_provenance: this.reference,
							text: targetText(this.reference),
							context_before: draft.before,
							context_after: draft.after,
						};
			const reservation = {
				posted: false,
				epoch: currentEpoch,
			};
			this.operation = reservation;
			this.update({ phase: "submitting", error: null });
			// Deferring the body gives operation its synchronous reservation before any adapter call.
			const operation = Promise.resolve()
				.then(async (): Promise<TranslationOutcome> => {
					if (command.kind !== "verify") {
						try {
							const [settings] = await Promise.all([
								adapter.settings(),
								this.prepareHistory(currentEpoch, !automatic),
							]);
							if (
								this.operation !== reservation ||
								!bound ||
								epoch !== currentEpoch
							)
								return skipped("inactive");
							if (!settings.model_id) return skipped("model");
							if (!draft.initialized) return skipped("draft");
							const history = adapter.peekHistory(this.reference);
							if (!history || this.freshEpoch !== currentEpoch)
								return skipped("history");
							if (
								adapter.hasActiveTask(this.reference, this.state.acceptedTaskId)
							)
								return skipped("busy");
							if (
								automatic &&
								(this.automatic !== "waiting" ||
									history.results.length ||
									history.tasks.some(activeTranslation) ||
									history.next_offset !== null ||
									draft.localError)
							) {
								this.automatic = "consumed";
								return skipped("automatic");
							}
							if (!values) return skipped("draft");
							this.frozen = Object.freeze({
								...values,
								material_provenance: copyReference(values.material_provenance),
								request_id: adapter.uuid(),
							});
							this.automatic = "consumed";
						} catch (error) {
							if (this.operation !== reservation) return skipped("inactive");
							const value = failure(error);
							this.update({ error: value });
							return { kind: "failed", error: value };
						}
					}
					if (
						this.operation !== reservation ||
						!bound ||
						epoch !== currentEpoch
					)
						return skipped("inactive");
					const request = this.frozen;
					if (!request) return skipped("no-request");
					let task: TranslationTask;
					try {
						reservation.posted = true;
						task = await adapter.submit(this.reference.material_id, request);
					} catch (error) {
						const value = failure(error);
						const status = "status" in value ? value.status : undefined;
						const unknown =
							typeof status !== "number" || status === 0 || status >= 500;
						if (!unknown) this.frozen = null;
						this.update({
							phase: unknown ? "uncertain" : "idle",
							error: value,
						});
						return { kind: unknown ? "uncertain" : "failed", error: value };
					}
					this.frozen = null;
					this.update({ phase: "idle", error: null, acceptedTaskId: task.id });
					adapter.accept(task);
					return {
						kind: "accepted",
						key: this.key,
						requestId: request.request_id,
						taskId: task.id,
					};
				})
				.finally(() => {
					if (this.operation !== reservation) return;
					this.operation = null;
					if (this.state.phase === "submitting")
						this.update({ phase: this.frozen ? "uncertain" : "idle" });
				});
			return operation;
		}
		cancelPreflight(ownerEpoch: number) {
			if (this.operation?.epoch === ownerEpoch && !this.operation.posted) {
				this.operation = null;
				this.update({ phase: this.frozen ? "uncertain" : "idle", error: null });
			}
		}
		stop = async (taskId: string) => {
			const task = await adapter.stop(taskId);
			adapter.accept(task);
			return task;
		};
		remove = (): Promise<TranslationRemoval> => {
			if (this.removal) return this.removal;
			if (!bound) return Promise.reject(new Error("请返回阅读器后重试删除。"));
			if (this.operation?.posted || this.state.phase === "uncertain")
				return Promise.reject(new Error("请先核实原提交，再删除此处翻译。"));
			this.generation++;
			this.automatic = "consumed";
			this.freshEpoch = -1;
			this.preparation = null;
			this.operation = null;
			this.frozen = null;
			this.update({ phase: "removing", error: null });
			const operation = Promise.resolve()
				.then(() => adapter.remove(this.reference))
				.then((removed) => {
					this.update({ phase: "idle", acceptedTaskId: null, error: null });
					return removed;
				})
				.catch((error) => {
					this.update({ phase: "idle", error: failure(error) });
					throw error;
				})
				.finally(() => {
					if (this.removal === operation) this.removal = null;
				});
			this.removal = operation;
			return operation;
		};
	}
	function get(sourceId: string, reference: MaterialProvenance) {
		const key = translationTargetKey(reference);
		let session = sessions.get(key);
		if (!session) {
			session = new TargetSession(sourceId, reference);
			sessions.set(key, session);
		}
		return session;
	}
	return {
		bindOwner() {
			bound = true;
			const currentEpoch = ++epoch;
			return () => {
				if (epoch === currentEpoch) {
					bound = false;
					epoch++;
					for (const session of sessions.values())
						session.cancelPreflight(currentEpoch);
				}
			};
		},
		forTarget(sourceId, target) {
			const session = get(sourceId, target.reference);
			session.attach(target);
			return session;
		},
	};
}
