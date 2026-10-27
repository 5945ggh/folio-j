import type { Illustration } from "./api";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 400;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/** Owned by one retained Reader instance. Only original image bytes are cached. */
export class ReaderImageCache {
	private readonly blobs = new Map<string, Blob>();
	private readonly items = new Map<number, Illustration>();
	private readonly sources = new Map<string, string>();
	private readonly pending = new Map<
		string,
		{ controller: AbortController; promise: Promise<Blob>; waiters: number }
	>();
	private bytes = 0;
	private sourceBytes = 0;
	private total = 0;
	private closed = false;

	remember(items: readonly Illustration[], total: number) {
		if (this.closed) return;
		this.total = total;
		for (const item of items) {
			this.items.delete(item.ordinal);
			this.items.set(item.ordinal, item);
			while (this.items.size > MAX_ITEMS) {
				const oldest = this.items.keys().next().value;
				if (oldest === undefined) break;
				this.items.delete(oldest);
			}
		}
	}

	item(ordinal: number): Illustration | undefined {
		return this.items.get(ordinal);
	}

	locate(chapter: string, part: number, image: number) {
		for (const item of this.items.values()) {
			if (
				item.chapter_id === chapter &&
				item.part_index === part &&
				item.image_id === image
			)
				return { item, total: this.total };
		}
		return undefined;
	}

	/** Connect a validated occurrence URL to the exact source from its loaded chapter. */
	rememberSource(url: string, source: string) {
		if (this.closed || !source.startsWith("data:image/")) return;
		const size = source.length * 2;
		if (size > MAX_SOURCE_BYTES) return;
		const previous = this.sources.get(url);
		if (previous) this.sourceBytes -= previous.length * 2;
		this.sources.delete(url);
		while (this.sourceBytes + size > MAX_SOURCE_BYTES) {
			const oldest = this.sources.keys().next().value;
			if (oldest === undefined) break;
			const discarded = this.sources.get(oldest);
			if (discarded) this.sourceBytes -= discarded.length * 2;
			this.sources.delete(oldest);
		}
		this.sources.set(url, source);
		this.sourceBytes += size;
		const blob = this.blobs.get(url);
		if (blob) {
			this.blobs.delete(url);
			if (this.blobs.has(source)) this.bytes -= blob.size;
			else this.blobs.set(source, blob);
		}
	}

	async get(url: string, signal: AbortSignal): Promise<Blob> {
		if (this.closed) throw new Error("图片会话已关闭");
		signal.throwIfAborted();
		url = this.sources.get(url) ?? url;
		const cached = this.blobs.get(url);
		if (cached) {
			this.blobs.delete(url);
			this.blobs.set(url, cached);
			return cached;
		}
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
		if (!this.closed && blob.size <= MAX_BYTES) {
			url = this.sources.get(url) ?? url;
			this.deleteBlob(url);
			while (this.bytes + blob.size > MAX_BYTES) {
				const oldest = this.blobs.keys().next().value;
				if (oldest === undefined) break;
				this.deleteBlob(oldest);
			}
			this.blobs.set(url, blob);
			this.bytes += blob.size;
		}
		return blob;
	}

	delete(url: string) {
		this.deleteBlob(this.sources.get(url) ?? url);
	}

	private deleteBlob(url: string) {
		const blob = this.blobs.get(url);
		if (blob) this.bytes -= blob.size;
		this.blobs.delete(url);
	}

	close() {
		this.closed = true;
		for (const entry of this.pending.values()) entry.controller.abort();
		this.pending.clear();
		this.blobs.clear();
		this.items.clear();
		this.sources.clear();
		this.bytes = 0;
		this.sourceBytes = 0;
	}
}
