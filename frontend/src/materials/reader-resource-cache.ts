import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

// Estimated retained cache data, not browser RSS, decoded images, DOM, or in-flight work.
export const READER_CACHE_BYTES = 64 * 1024 * 1024;
export const READER_CACHE_ITEMS = 512;
const ENTRY_BYTES = 64;

type Entry = {
	bytes: number;
	evict: () => void;
	pinned: () => boolean;
};
type Limits = { maxBytes?: number; maxItems?: number };

/** One LRU for independently owned resources. Values stay with their original owner. */
export class ReaderResourceBudget {
	private readonly entries = new Map<object, Entry>();
	private bytes = 0;
	private trimming = false;
	readonly maxBytes: number;
	readonly maxItems: number;

	constructor({
		maxBytes = READER_CACHE_BYTES,
		maxItems = READER_CACHE_ITEMS,
	}: Limits = {}) {
		if (
			!Number.isFinite(maxBytes) ||
			!Number.isInteger(maxItems) ||
			maxBytes < 1 ||
			maxItems < 1
		)
			throw new Error("阅读缓存限额必须为正数");
		this.maxBytes = maxBytes;
		this.maxItems = maxItems;
	}

	retain(
		key: object,
		bytes: number,
		evict: () => void,
		pinned = () => false,
	): boolean {
		this.release(key);
		const entry = { bytes: Math.max(0, bytes) + ENTRY_BYTES, evict, pinned };
		// A cold oversized response is still returned to its caller, without displacing useful cache data.
		if (entry.bytes > this.maxBytes && !pinned()) {
			evict();
			return false;
		}
		this.entries.set(key, entry);
		this.bytes += entry.bytes;
		this.trim();
		return this.entries.has(key);
	}

	touch(key: object): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.entries.set(key, entry);
	}

	/** Forget accounting after the resource owner already released its value. */
	release(key: object): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.bytes -= entry.bytes;
		this.entries.delete(key);
	}

	trim(): void {
		if (this.trimming) return;
		this.trimming = true;
		try {
			for (const [key, entry] of this.entries) {
				if (this.bytes <= this.maxBytes && this.entries.size <= this.maxItems)
					break;
				if (entry.pinned()) continue;
				this.release(key);
				entry.evict();
			}
		} finally {
			this.trimming = false;
		}
	}

	get diagnostics() {
		let pinnedBytes = 0;
		let pinnedItems = 0;
		for (const entry of this.entries.values()) {
			if (!entry.pinned()) continue;
			pinnedBytes += entry.bytes;
			pinnedItems++;
		}
		return {
			bytes: this.bytes,
			items: this.entries.size,
			pinnedBytes,
			pinnedItems,
		};
	}
}

/** Conservative UTF-16/container estimate; shared object references are counted once per entry. */
export function readerResourceBytes(value: unknown): number {
	const seen = new Set<object>();
	const pending: unknown[] = [value];
	let bytes = 0;
	while (pending.length) {
		const item = pending.pop();
		if (typeof item === "string") bytes += item.length * 2;
		else if (typeof item === "number" || typeof item === "bigint") bytes += 8;
		else if (typeof item === "boolean") bytes += 4;
		else if (item && typeof item === "object" && !seen.has(item)) {
			seen.add(item);
			bytes += 64;
			if (item instanceof Blob) bytes += item.size;
			else if (Array.isArray(item)) {
				bytes += item.length * 8;
				for (const child of item) pending.push(child);
			} else {
				for (const [key, child] of Object.entries(item)) {
					bytes += key.length * 2 + 8;
					pending.push(child);
				}
				if (item instanceof Error) {
					// Native Error diagnostics are normally non-enumerable; causes can retain whole response graphs.
					for (const key of ["name", "message", "stack", "cause"] as const) {
						if (
							key in item &&
							!Object.prototype.propertyIsEnumerable.call(item, key)
						) {
							bytes += key.length * 2 + 8;
							pending.push(item[key]);
						}
					}
					if (
						item instanceof AggregateError &&
						!Object.prototype.propertyIsEnumerable.call(item, "errors")
					)
						pending.push(item.errors);
				}
			}
		}
	}
	return bytes;
}

/** Reading payload families, including shared translation details, without unrelated app queries. */
export function isReaderResourceQuery(key: QueryKey): boolean {
	if (key[0] === "materials") return true;
	return (
		key[0] === "translation-result" ||
		key[0] === "translation-task" ||
		key[0] === "translation-identity" ||
		key[0] === "translations" ||
		key[0] === "material-chapter-segments" ||
		key[0] === "material-chapter-translations" ||
		key[0] === "material-translation-activity"
	);
}

/** QueryCache adapter; publication/observer use updates recency, without a second data store. */
class ReaderQueryResources extends ReaderResourceBudget {
	constructor(client: QueryClient, limits?: Limits) {
		super(limits);
		const cache = client.getQueryCache();
		const dirty = new Set<Query>();
		const measured = new WeakMap<
			Query,
			{ data: unknown; error: unknown; bytes: number }
		>();
		let scheduled = false;
		const synchronize = () => {
			scheduled = false;
			for (const query of dirty) {
				dirty.delete(query);
				if (cache.get(query.queryHash) !== query) {
					this.release(query);
					continue;
				}
				let weight = measured.get(query);
				if (
					!weight ||
					weight.data !== query.state.data ||
					weight.error !== query.state.error
				) {
					weight = {
						data: query.state.data,
						error: query.state.error,
						bytes:
							readerResourceBytes(query.queryKey) +
							readerResourceBytes(query.state.data) +
							readerResourceBytes(query.state.error),
					};
					measured.set(query, weight);
				}
				this.retain(
					query,
					weight.bytes,
					() => cache.remove(query),
					() =>
						query.getObserversCount() > 0 || query.state.fetchStatus !== "idle",
				);
			}
			this.trim();
		};
		const changed = (query: Query) => {
			if (!isReaderResourceQuery(query.queryKey)) return;
			dirty.add(query);
			if (scheduled) return;
			scheduled = true;
			// Wait for the current notification/observer attachment to finish before eviction.
			queueMicrotask(synchronize);
		};
		cache.subscribe((event) => {
			if (event.type === "removed") {
				dirty.delete(event.query);
				measured.delete(event.query);
				this.release(event.query);
			} else if (event.type !== "observerOptionsUpdated") changed(event.query);
		});
		for (const query of cache.getAll()) changed(query);
	}
}

const resources = new WeakMap<QueryClient, ReaderResourceBudget>();
export function readerResourceCache(
	client: QueryClient,
	limits?: Limits,
): ReaderResourceBudget {
	let budget = resources.get(client);
	if (!budget) {
		budget = new ReaderQueryResources(client, limits);
		resources.set(client, budget);
	}
	return budget;
}
