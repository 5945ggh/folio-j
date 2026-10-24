import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type ReaderSessionIdentity = {
	materialId: string;
	versionId: string;
	generationId: string;
};

/** Content owns the DOM lifetime; destinations belong to navigation within that lifetime. */
export function readerSessionIdentity(identity: ReaderSessionIdentity): string {
	return `${identity.materialId}:${identity.versionId}:${identity.generationId}`;
}

/** Compare only after pending local writes drain, so external CAS changes cannot be overwritten. */
export function canResumeReader(
	previous: ReaderSessionIdentity,
	next: ReaderSessionIdentity,
	drainedRevision: number,
	freshRevision: number,
	writerHealthy = true,
): boolean {
	return (
		writerHealthy &&
		readerSessionIdentity(previous) === readerSessionIdentity(next) &&
		drainedRevision === freshRevision
	);
}

/** After writes drain, retire old validation reads before starting this activation's reads. */
export async function cancelReaderSessionReads(
	client: QueryClient,
	queryKeys: readonly QueryKey[],
	current: () => boolean,
): Promise<boolean> {
	if (!current()) return false;
	await Promise.all(
		queryKeys.map((queryKey) =>
			client.cancelQueries({ queryKey, exact: true }),
		),
	);
	return current();
}
