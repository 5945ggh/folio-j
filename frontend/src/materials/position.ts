export function rawBoundary(raw: string, offset: number): number {
	if (!Number.isInteger(offset) || offset < 0 || offset > raw.length)
		throw new Error("边界超出正文");
	if (
		offset > 0 &&
		offset < raw.length &&
		/[\uD800-\uDBFF]/.test(raw[offset - 1] ?? "") &&
		/[\uDC00-\uDFFF]/.test(raw[offset] ?? "")
	)
		throw new Error("边界切开字符");
	const before = raw.slice(0, offset).normalize("NFC");
	if (before + raw.slice(offset).normalize("NFC") !== raw.normalize("NFC"))
		throw new Error("边界切开 NFC 组合");
	return [...before].length;
}
export function rawOffset(raw: string, point: number): number {
	if (!Number.isInteger(point) || point < 0) throw new Error("码点无效");
	if (raw === raw.normalize("NFC")) {
		let count = 0,
			offset = 0;
		for (const c of raw) {
			if (count === point) return offset;
			count++;
			offset += c.length;
		}
		if (count === point) return offset;
		throw new Error("码点越界");
	}
	const normalized = raw.normalize("NFC");
	const segments = Array.from(
		new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw),
	);
	if (
		segments.map((value) => value.segment.normalize("NFC")).join("") !==
		normalized
	)
		throw new Error("浏览器分段无法验证 NFC 正文");
	let count = 0;
	for (const { segment, index } of segments) {
		const length = Array.from(segment.normalize("NFC")).length;
		if (point >= count && point <= count + length) {
			for (let local = 0; local <= segment.length; local++) {
				try {
					if (rawBoundary(raw, index + local) === point) return index + local;
				} catch {
					/* Unstable boundary. */
				}
			}
		}
		count += length;
		if (count > point) break;
	}
	throw new Error("无法恢复码点");
}
export function scrollProgress(distance: number, extent: number): number {
	return extent <= 0 ? 0 : Math.max(0, Math.min(1, distance / extent));
}
/** A serial CAS queue retains only the latest observed position. A conflict stops writing. */
export class PositionQueue<T> {
	revision: number;
	pending: T | undefined;
	private flight: Promise<void> | null = null;
	private stopped = false;
	private save: (value: T, revision: number) => Promise<number>;
	private status: (
		state: "saving" | "saved" | "error",
		error?: unknown,
	) => void;
	constructor(
		revision: number,
		save: (value: T, revision: number) => Promise<number>,
		status: (state: "saving" | "saved" | "error", error?: unknown) => void,
	) {
		this.revision = revision;
		this.save = save;
		this.status = status;
	}
	enqueue(value: T) {
		if (this.stopped) return;
		this.pending = value;
		void this.flush();
	}
	flush(): Promise<void> {
		if (this.flight) return this.flight;
		if (this.stopped || this.pending === undefined) return Promise.resolve();
		this.flight = this.drain();
		return this.flight;
	}
	private async drain(): Promise<void> {
		try {
			while (this.pending !== undefined && !this.stopped) {
				const value = this.pending;
				this.pending = undefined;
				this.status("saving");
				this.revision = await this.save(value, this.revision);
			}
			if (!this.stopped) this.status("saved");
		} catch (error) {
			this.stopped = true;
			this.pending = undefined;
			this.status("error", error);
		} finally {
			this.flight = null;
		}
	}
	stop() {
		this.stopped = true;
		this.pending = undefined;
	}
}

export function imageFraction(
	coordinate: number,
	start: number,
	size: number,
	vertical: boolean,
): number {
	return scrollProgress(
		vertical ? start + size - coordinate : coordinate - start,
		size,
	);
}
export function imageCoordinate(
	progress: number,
	start: number,
	size: number,
	vertical: boolean,
): number {
	return vertical ? start + size - size * progress : start + size * progress;
}
/** Search monotonic line coordinates, bounded to logarithmic probes even for very long paragraphs. */
export function nearestLineBoundary(
	length: number,
	target: number,
	coordinate: (index: number) => number,
): number {
	if (length <= 0) return 0;
	let low = 0,
		high = length - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (coordinate(middle) < target) low = middle + 1;
		else high = middle;
	}
	// Keep the first character of the chosen line rather than the arbitrary last character on it.
	const chosen = coordinate(low);
	let left = 0,
		right = low;
	while (left < right) {
		const middle = Math.floor((left + right) / 2);
		if (coordinate(middle) < chosen) left = middle + 1;
		else right = middle;
	}
	return left;
}
export function currentSurface(
	token: number,
	current: number,
	connected: boolean,
	expected: boolean,
): boolean {
	return token === current && connected && expected;
}

/** During a reflow, the DOM is provisional. Preserve the stable anchor without sampling it. */
export function anchorBeforeLayout<T>(
	restoring: boolean,
	previous: T | null,
	capture: () => T | null,
): T | null {
	return restoring ? previous : (capture() ?? previous);
}
