import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import {
	chapterTranslationsKey,
	translationActivityKey,
} from "../materials/chapter-translations-query";
import type { MaterialProvenance } from "../materials/study-api";
import { useViewActivity } from "../navigation/RetainedRoute";
import {
	createTranslation,
	getTranslationHistory,
	getTranslationSettings,
	stopTranslation,
	type TranslationTask,
	translationSettingsKey,
} from "./api";
import {
	createTranslationSessions,
	emptyTranslationSnapshot,
	type TranslationHistory,
	type TranslationQueryAdapter,
	type TranslationSession,
	type TranslationSessions,
} from "./session";
import {
	activeTranslation,
	targetIdentity,
	translationTargetKey,
} from "./state";

/** Existing HTTP functions and Query caches form the production adapter. */
export function translationQueryAdapter(
	client: QueryClient,
): TranslationQueryAdapter {
	const identityKey = (reference: MaterialProvenance) =>
		["translation-identity", reference] as const;
	const historyKey = (reference: MaterialProvenance) => {
		const identity = client.getQueryData<string>(identityKey(reference));
		return identity
			? (["translations", reference.material_id, identity, 0] as const)
			: undefined;
	};
	return {
		settings: () =>
			client.fetchQuery({
				queryKey: translationSettingsKey,
				queryFn: getTranslationSettings,
				staleTime: Infinity,
				retry: false,
			}),
		async history(reference) {
			const identity = await client.fetchQuery({
				queryKey: identityKey(reference),
				queryFn: () => targetIdentity(reference),
				staleTime: Infinity,
			});
			return client.fetchQuery({
				queryKey: ["translations", reference.material_id, identity, 0],
				queryFn: () =>
					getTranslationHistory(reference.material_id, 0, identity),
				staleTime: 0,
				retry: false,
			});
		},
		peekHistory(reference) {
			const key = historyKey(reference);
			if (!key) return undefined;
			const state = client.getQueryState<TranslationHistory>(key);
			return state?.status === "success" && state.fetchStatus === "idle"
				? state.data
				: undefined;
		},
		hasActiveTask(reference, acceptedTaskId) {
			const key = historyKey(reference);
			const history = key
				? client.getQueryData<TranslationHistory>(key)
				: undefined;
			const accepted = acceptedTaskId
				? client.getQueryData<TranslationTask>([
						"translation-task",
						acceptedTaskId,
					])
				: undefined;
			const activity = client.getQueryData<{ tasks: TranslationTask[] }>(
				translationActivityKey(reference.material_id),
			);
			const facts = [
				...(history?.tasks ?? []),
				...(accepted ? [accepted] : []),
				...(activity?.tasks ?? []),
			].filter(
				(task) =>
					translationTargetKey(task.material_provenance) ===
					translationTargetKey(reference),
			);
			// A task never becomes active again after a terminal server fact. Polling
			// another cache can leave an older queued copy behind after a card closes.
			return facts.some(
				(task) =>
					activeTranslation(task) &&
					!facts.some(
						(other) => other.id === task.id && !activeTranslation(other),
					),
			);
		},
		async submit(materialId, input) {
			try {
				return await createTranslation(materialId, input);
			} finally {
				void client.invalidateQueries({
					queryKey: translationActivityKey(materialId),
				});
			}
		},
		accept(task) {
			client.setQueryData(["translation-task", task.id], task);
			const key = translationActivityKey(task.material_id);
			client.setQueryData<{ tasks: TranslationTask[]; resultIds: string[] }>(
				key,
				(previous) => ({
					tasks: [
						...(previous?.tasks.filter((item) => item.id !== task.id) ?? []),
						task,
					],
					resultIds: [
						...new Set([
							...(previous?.resultIds ?? []),
							...(task.result_id ? [task.result_id] : []),
						]),
					],
				}),
			);
			void client.invalidateQueries({
				queryKey: ["translations", task.material_id],
			});
			void client.invalidateQueries({ queryKey: key });
			if (task.result_id)
				void client.invalidateQueries({
					queryKey: chapterTranslationsKey(task.material_id),
				});
		},
		async stop(taskId) {
			// Mutations are commands; their returned server facts are written by accept().
			return stopTranslation(taskId);
		},
		uuid: () => crypto.randomUUID(),
	};
}

/** Reader owns this binding; passing an existing registry creates no second owner. */
export function useTranslationSessions(
	existing?: TranslationSessions,
): TranslationSessions {
	const { active } = useViewActivity();
	const client = useQueryClient();
	const local = useMemo(
		() => createTranslationSessions(translationQueryAdapter(client)),
		[client],
	);
	const sessions = existing ?? local;
	useLayoutEffect(
		() => (existing || !active ? undefined : sessions.bindOwner()),
		[active, existing, sessions],
	);
	return sessions;
}
const noSubscription = () => () => {};
const emptySnapshot = () => emptyTranslationSnapshot;
export function useTranslationSession(session: TranslationSession | null) {
	return useSyncExternalStore(
		session?.subscribe ?? noSubscription,
		session?.getSnapshot ?? emptySnapshot,
	);
}
