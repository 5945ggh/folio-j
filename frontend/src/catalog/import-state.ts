import type {
	Mutation,
	MutationOptions,
	QueryClient,
} from "@tanstack/react-query";
import type { components } from "../api/schema";

export type ImportResult = components["schemas"]["MaterialImportResponse"];
export type ImportInput = {
	sourceId: string;
	file: File;
};
export type ImportTask = {
	id: number;
	status: "idle" | "pending" | "error" | "success";
	input: ImportInput;
	data: ImportResult | undefined;
	error: Error | null;
	invalidated: boolean;
};
export const importKey = ["material-import"] as const;
const deletedMaterials = new WeakMap<QueryClient, Set<string>>();
const deletedSources = new WeakMap<QueryClient, Set<string>>();

export function importTask(
	client: QueryClient,
	mutation: Mutation<ImportResult, Error, ImportInput>,
): ImportTask {
	const input = mutation.state.variables;
	const materialId = mutation.state.data?.material.id;
	return {
		id: mutation.mutationId,
		status: mutation.state.status,
		input: input as ImportInput,
		data: mutation.state.data,
		error: mutation.state.error,
		invalidated: Boolean(
			(input && deletedSources.get(client)?.has(input.sourceId)) ||
				(materialId && deletedMaterials.get(client)?.has(materialId)),
		),
	};
}

export function importOptions(
	client: QueryClient,
	upload: (sourceId: string, file: File) => Promise<ImportResult>,
): MutationOptions<ImportResult, Error, ImportInput> {
	return {
		mutationKey: importKey,
		// A failed upload must retain its original File until the user retries or removes it.
		gcTime: Infinity,
		retry: false,
		mutationFn: ({ sourceId, file }) => upload(sourceId, file),
		onSuccess: (result, input) => {
			const { sourceId } = input;
			if (
				deletedMaterials.get(client)?.has(result.material.id) ||
				deletedSources.get(client)?.has(sourceId)
			) {
				for (const mutation of client
					.getMutationCache()
					.findAll({ mutationKey: importKey }))
					if (mutation.state.variables === input)
						client.getMutationCache().remove(mutation);
				return;
			}
			void Promise.all(
				[
					["catalog"],
					["materials", "source", sourceId],
					["source", sourceId],
					["sources"],
					["source-entry"],
				].map((queryKey) => client.invalidateQueries({ queryKey })),
			);
		},
	};
}

/** Deletion wins over both cached successes and upload responses still in flight. */
export function forgetDeletedMaterialImports(
	client: QueryClient,
	materialId: string,
): void {
	const ids = deletedMaterials.get(client) ?? new Set<string>();
	ids.add(materialId);
	deletedMaterials.set(client, ids);
	forgetCompletedImports(client, [materialId]);
}

export function forgetSourceImports(
	client: QueryClient,
	sourceId: string,
): void {
	const ids = deletedSources.get(client) ?? new Set<string>();
	ids.add(sourceId);
	deletedSources.set(client, ids);
	for (const mutation of client
		.getMutationCache()
		.findAll({ mutationKey: importKey })) {
		const input = mutation.state.variables as ImportInput | undefined;
		if (input?.sourceId === sourceId)
			client.getMutationCache().remove(mutation);
	}
}

/** Recent import activity is independent of the catalog's filters and pagination. */
export function visibleImportTasks(
	tasks: readonly ImportTask[],
	bookIds: readonly string[],
	sourceId?: string,
): ImportTask[] {
	const shown = new Set(bookIds);
	return tasks.filter((task) => {
		if (
			task.invalidated ||
			task.status === "idle" ||
			(sourceId && task.input.sourceId !== sourceId)
		)
			return false;
		if (task.status !== "success") return true;
		const id = task.data?.material.id;
		if (!id || shown.has(id)) return false;
		shown.add(id);
		return true;
	});
}

/** Retire consumed success entries so a later deletion cannot revive an import card. */
export function forgetCompletedImports(
	client: QueryClient,
	bookIds: readonly string[],
): void {
	const ids = new Set(bookIds);
	for (const mutation of client.getMutationCache().findAll({
		mutationKey: importKey,
		status: "success",
	})) {
		const data = mutation.state.data as ImportResult | undefined;
		if (data && ids.has(data.material.id))
			client.getMutationCache().remove(mutation);
	}
}
