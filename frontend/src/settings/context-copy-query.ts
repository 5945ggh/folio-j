import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useViewActivity } from "../navigation/view-activity";
import {
	type ContextCopySettings,
	getContextCopySettings,
} from "./context-copy-api";
import {
	contextCopyKey,
	newestContextCopySettings,
} from "./context-copy-cache";

export function contextCopyQueryOptions() {
	return queryOptions({
		queryKey: contextCopyKey,
		queryFn: ({ signal }) => getContextCopySettings(signal),
		retry: false,
		structuralSharing: (previous, response) =>
			newestContextCopySettings(
				previous as ContextCopySettings | undefined,
				response as ContextCopySettings,
			),
	});
}

export function useContextCopySettings(enabled = true) {
	const { active } = useViewActivity();
	return useQuery({ ...contextCopyQueryOptions(), enabled: active && enabled });
}

export function useReloadContextCopySettings() {
	const client = useQueryClient();
	return async () => {
		await client.cancelQueries({ queryKey: contextCopyKey });
		return client.fetchQuery({ ...contextCopyQueryOptions(), staleTime: 0 });
	};
}
