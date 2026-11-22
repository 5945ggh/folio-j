import type { QueryClient } from "@tanstack/react-query";
import type { ContextCopySettings } from "./context-copy-api.ts";
import {
	commitVersionedSettings,
	newestRevision,
} from "./versioned-settings.ts";

export const contextCopyKey = ["context-copy-settings"] as const;

export const newestContextCopySettings = newestRevision<ContextCopySettings>;

/** Cancel reads before publishing a saved revision to every reader. */
export async function commitContextCopyResponse(
	client: QueryClient,
	response: ContextCopySettings,
) {
	return commitVersionedSettings(client, contextCopyKey, response);
}
