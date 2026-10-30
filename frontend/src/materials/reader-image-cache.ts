import type { Illustration } from "./api";
import {
	type ReaderResourceBudget,
	readerResourceBytes,
} from "./reader-resource-cache.ts";

type Resource<T> = { value: T; pins: number };

/** Owned by one retained Reader instance. Only original image bytes are cached. */
export class ReaderImageCache {
	private readonly blobs = new Map<string, Resource<Blob>>();
	private readonly items = new Map<number, Resource<Illustration>>();
	private readonly sources = new Map<string, Resource<string>>();
	private readonly pending = new Map<
		string,
		{ controller: AbortController; promise: Promise<Blob>; waiters: number }
	>();
	private total = 0;
	private closed = false;
	private readonly budget: ReaderResourceBudget;

	constructor(budget: ReaderResourceBudget) {
		this.budget = budget;
	}

	private rememberResource<K extends string | number, T>(
		map: Map<K, Resource<T>>,
		key: K,
		value: T,
		pins = 0,
	) {
		this.forgetResource(map, key);
		const entry = { value, pins };
		map.set(key, entry);
		this.retainResource(map, key, entry);
		return entry;
	}

	private retainResource<K extends string | number, T>(
		map: Map<K, Resource<T>>,
		key: K,
		entry: Resource<T>,
	) {
		this.budget.retain(
			entry,
			readerResourceBytes(key) + readerResourceBytes(entry.value),
			() => {
				if (map.get(key) === entry) map.delete(key);
			},
			() => entry.pins > 0,
		);
	}

	private forgetResource<K, T>(map: Map<K, Resource<T>>, key: K) {
		const entry = map.get(key);
		if (entry) this.budget.release(entry);
		map.delete(key);
	}

	private readResource<K, T>(map: Map<K, Resource<T>>, key: K): T | undefined {
		const entry = map.get(key);
		if (entry) this.budget.touch(entry);
		return entry?.value;
	}

	remember(items: readonly Illustration[], total: number) {
		if (this.closed) return;
		this.total = total;
		for (const item of items) {
			this.rememberResource(this.items, item.ordinal, item);
		}
	}

	item(ordinal: number): Illustration | undefined {
		return this.readResource(this.items, ordinal);
	}

	locate(chapter: string, part: number, image: number) {
		for (const entry of this.items.values()) {
			const item = entry.value;
			if (
				item.chapter_id === chapter &&
				item.part_index === part &&
				item.image_id === image
			) {
				this.budget.touch(entry);
				return { item, total: this.total };
			}
		}
		return undefined;
	}

	/** Connect a validated occurrence URL to the exact source from its loaded chapter. */
	rememberSource(url: string, source: string) {
		if (this.closed || !source.startsWith("data:image/")) return;
		const blob = this.blobs.get(url);
		if (blob) this.budget.touch(blob);
		this.rememberResource(this.sources, url, source);
		if (blob && url !== source) {
			if (this.blobs.has(source)) {
				// A displayed duplicate keeps its lease until its object URL is revoked.
				if (!blob.pins) this.forgetResource(this.blobs, url);
			} else {
				this.forgetResource(this.blobs, url);
				this.blobs.set(source, blob);
				this.retainResource(this.blobs, source, blob);
			}
		}
	}

	async get(url: string, signal: AbortSignal): Promise<Blob> {
		if (this.closed) throw new Error("图片会话已关闭");
		signal.throwIfAborted();
		url = this.readResource(this.sources, url) ?? url;
		const cached = this.readResource(this.blobs, url);
		if (cached) return cached;
		let entry = this.pending.get(url);
		if (!entry) {
			const controller = new AbortController();
			const created = {
				controller,
				promise: Promise.resolve(new Blob()),
				waiters: 0,
			};
			created.promise = this.load(url, controller.signal).finally(() => {
				if (this.pending.get(url) === created) this.pending.delete(url);
			});
			entry = created;
			this.pending.set(url, entry);
		}
		entry.waiters++;
		const current = entry;
		try {
			return await new Promise<Blob>((resolve, reject) => {
				const abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
				current.promise
					.then(resolve, reject)
					.finally(() => signal.removeEventListener("abort", abort));
				if (signal.aborted) abort();
			});
		} finally {
			current.waiters--;
			if (!current.waiters && this.pending.get(url) === current) {
				this.pending.delete(url);
				current.controller.abort();
			}
		}
	}

	/** A visible object URL borrows its Blob until the viewer revokes that URL. */
	async acquire(
		url: string,
		signal: AbortSignal,
	): Promise<{ blob: Blob; release: () => void }> {
		const blob = await this.get(url, signal);
		signal.throwIfAborted();
		if (this.closed) throw new Error("图片会话已关闭");
		let retained: Resource<Blob> | undefined;
		for (const entry of this.blobs.values()) {
			if (entry.value === blob) {
				retained = entry;
				retained.pins++;
				this.budget.touch(retained);
				break;
			}
		}
		const entry =
			retained ??
			this.rememberResource(
				this.blobs,
				this.readResource(this.sources, url) ?? url,
				blob,
				1,
			);
		let released = false;
		return {
			blob,
			release: () => {
				if (released) return;
				released = true;
				entry.pins--;
				this.budget.trim();
			},
		};
	}

	private async load(url: string, signal: AbortSignal): Promise<Blob> {
		let blob: Blob;
		if (url.startsWith("data:image/")) {
			const match =
				/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
					url,
				);
			if (!match?.[1] || !match[2]) throw new Error("图片数据不可用");
			const binary = atob(match[2]);
			const bytes = Uint8Array.from(binary, (character) =>
				character.charCodeAt(0),
			);
			blob = new Blob([bytes], { type: match[1] });
		} else {
			const response = await fetch(url, { signal });
			if (!response.ok) throw new Error("无法读取图片");
			blob = await response.blob();
		}
		signal.throwIfAborted();
		if (!this.closed) {
			url = this.readResource(this.sources, url) ?? url;
			this.rememberResource(this.blobs, url, blob);
		}
		return blob;
	}

	delete(url: string) {
		this.forgetResource(
			this.blobs,
			this.readResource(this.sources, url) ?? url,
		);
	}

	close() {
		this.closed = true;
		for (const entry of this.pending.values()) entry.controller.abort();
		this.pending.clear();
		for (const entry of this.blobs.values()) this.budget.release(entry);
		for (const entry of this.items.values()) this.budget.release(entry);
		for (const entry of this.sources.values()) this.budget.release(entry);
		this.blobs.clear();
		this.items.clear();
		this.sources.clear();
	}
}
