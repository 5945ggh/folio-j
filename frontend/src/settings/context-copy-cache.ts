import type { QueryClient } from "@tanstack/react-query";
import type { ContextCopySettings } from "./context-copy-api.ts";

export const contextCopyKey = ["context-copy-settings"] as const;

export function newestContextCopySettings(
	current: ContextCopySettings | undefined,
	response: ContextCopySettings,
): ContextCopySettings {
	return current && current.revision > response.revision ? current : response;
}

/** Cancel reads before publishing a saved revision to every reader. */
export async function commitContextCopyResponse(
	client: QueryClient,
	response: ContextCopySettings,
) {
	await client.cancelQueries({ queryKey: contextCopyKey });
	return client.setQueryData<ContextCopySettings>(contextCopyKey, (current) =>
		newestContextCopySettings(current, response),
	);
}
