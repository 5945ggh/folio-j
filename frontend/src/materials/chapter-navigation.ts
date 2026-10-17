import type { Chapter, Position, Settings } from "./api.ts";

export class ChapterSwitch {
	#pending: { ticket: number; generation: number | null } | null = null;

	get busy(): boolean {
		return this.#pending !== null;
	}

	begin(ticket: number): boolean {
		if (this.#pending) return false;
		this.#pending = { ticket, generation: null };
		return true;
	}

	accept(ticket: number, generation: number): void {
		if (this.#pending?.ticket === ticket) this.#pending.generation = generation;
	}

	finish(generation: number): boolean {
		if (this.#pending?.generation !== generation) return false;
		this.#pending = null;
		return true;
	}

	cancel(ticket?: number): boolean {
		if (
			!this.#pending ||
			(ticket !== undefined && this.#pending.ticket !== ticket)
		)
			return false;
		this.#pending = null;
		return true;
	}
}

export function adjacentChapters<T extends { id: string }>(
	chapters: readonly T[],
	currentId: string,
): { previous: T | null; next: T | null } {
	const index = chapters.findIndex((chapter) => chapter.id === currentId);
	if (index < 0) return { previous: null, next: null };
	return {
		previous: chapters[index - 1] ?? null,
		next: chapters[index + 1] ?? null,
	};
}

export function chapterDestination(
	chapter: Chapter,
	saved: Position | undefined,
	versionId: string,
	settings: Settings,
	beginning = false,
): { target: Position; beginning: boolean } {
	const part = chapter.parts[0];
	if (!part) throw new Error("章节没有可阅读内容");
	if (saved && !beginning)
		return { target: { ...saved, settings }, beginning: false };
	const image = part.html.match(/data-epub-image="(\d+)"/);
	return {
		target: {
			version_id: versionId,
			chapter_id: chapter.id,
			part_index: 0,
			resource_id: part.resource_id,
			at_chapter_end: false,
			settings,
			...(part.end > part.start
				? { kind: "text", offset: part.start }
				: {
						kind: "image",
						image_id: Number(image?.[1] ?? 0),
						image_progress: 0,
					}),
		},
		beginning: true,
	};
}
