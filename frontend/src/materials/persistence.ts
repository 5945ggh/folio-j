import type { QueryClient } from "@tanstack/react-query";

type Writer = { flush: () => Promise<void> };
const writers = new Map<string, { writer: Writer }>();
/** A return visit must not read before the previous reader's final write drains. */
export function registerPositionWriter(id: string, writer: Writer): () => void {
	const entry = { writer };
	writers.set(id, entry);
	return () => {
		void writer.flush().finally(() => {
			if (writers.get(id) === entry) writers.delete(id);
		});
	};
}
export async function waitForPositionWrites(id: string): Promise<void> {
	let entry = writers.get(id);
	while (entry) {
		await entry.writer.flush();
		const next = writers.get(id);
		if (next === entry) return;
		entry = next;
	}
}
export function cacheSavedPosition<T extends { reading_position: unknown }>(
	client: QueryClient,
	id: string,
	position: T["reading_position"],
): void {
	client.setQueryData<T>(["materials", id], (current) =>
		current ? { ...current, reading_position: position } : undefined,
	);
}
