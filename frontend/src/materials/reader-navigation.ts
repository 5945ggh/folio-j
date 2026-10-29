import type { Chapter, Position, Settings } from "./api.ts";
import { JumpReadingSession } from "./return-origin.ts";

type NavigationChapter = { id: string; title: string };
export type ReaderNavigationIntent =
	| { type: "chapter"; id: string }
	| { type: "beginning" }
	| { type: "adjacent"; direction: "previous" | "next" }
	| {
			type: "position";
			target: Position;
			mark?: { start: number; end: number };
	  }
	| { type: "return" };
type NavigationDraft = {
	target: Position;
	beginning: boolean;
	mark?: { start: number; end: number };
};
export type ReaderNavigationDestination = NavigationDraft & {
	chapter: Chapter;
	part: Chapter["parts"][number];
};
export type ReaderNavigationCompletion = {
	anchor: Position | null;
	located: boolean;
	error?: Error;
};
export type ReaderNavigationState = Readonly<{
	origin: Position | null;
	originProgress: number | null;
	error: Error | null;
	busy: boolean;
	adjacentDisabled: boolean;
	returning: boolean;
	previous: NavigationChapter | null;
	next: NavigationChapter | null;
}>;
export type ReaderNavigationContext = {
	versionId: string;
	chapterId: string;
	chapters: readonly NavigationChapter[];
	settings: Settings;
	unavailable?: boolean;
	remembered: (id: string) => Position | undefined;
	presentedAnchor: () => Position | null;
	progressFor: (anchor: Position) => number | null;
	atBeginning: () => boolean;
	loadChapter: (id: string) => Promise<Chapter>;
	saveDeparture: (anchor: Position) => void;
	// null attaches the initial surface without navigating or saving a position.
	present: (
		destination: ReaderNavigationDestination | null,
		complete: (result: ReaderNavigationCompletion) => void,
	) => void;
	closePanels: (side?: "left" | "right") => void;
	changed: (state: ReaderNavigationState) => void;
};
type Surface = {
	stable: boolean;
	adjacent: boolean;
	returning: { target: Position; revision: number } | null;
};

function chapterDestination(
	chapter: Chapter,
	saved: Position | undefined,
	versionId: string,
	settings: Settings,
	beginning: boolean,
): NavigationDraft {
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
function sameContent(target: Position, anchor: Position | null): boolean {
	return (
		anchor !== null &&
		target.version_id === anchor.version_id &&
		target.chapter_id === anchor.chapter_id &&
		target.part_index === anchor.part_index &&
		target.resource_id === anchor.resource_id &&
		target.kind === anchor.kind &&
		(target.kind === "text"
			? target.offset === anchor.offset
			: target.image_id === anchor.image_id)
	);
}

/** Owns navigation requests, accepted surfaces, chapter memory and the session return point. */
export class ReaderNavigation {
	private context: ReaderNavigationContext | null = null;
	private request = 0;
	private adjacentRequest = false;
	private surface: Surface | null = null;
	private chapterId = "";
	private origin: Position | null = null;
	private originProgress: number | null = null;
	private originRevision = 0;
	private error: Error | null = null;
	private snapshot: ReaderNavigationState = {
		origin: null,
		originProgress: null,
		error: null,
		busy: false,
		adjacentDisabled: true,
		returning: false,
		previous: null,
		next: null,
	};
	private readonly reading: JumpReadingSession;
	constructor(reading = new JumpReadingSession()) {
		this.reading = reading;
	}
	get state(): ReaderNavigationState {
		return this.snapshot;
	}
	bind(context: ReaderNavigationContext): void {
		const attaching = this.context === null;
		this.context = context;
		this.chapterId = context.chapterId;
		if (attaching) {
			const surface: Surface = {
				stable: false,
				adjacent: false,
				returning: null,
			};
			this.surface = surface;
			context.present(null, this.completion(surface));
		}
		if (context.unavailable) {
			this.adjacentRequest = false;
			if (this.surface) this.surface.adjacent = false;
		}
		this.publish();
	}
	suspend(): void {
		this.request++;
		this.adjacentRequest = false;
		this.surface = null;
		this.context = null;
		this.reading.pause();
	}
	invalidate(): void {
		this.request++;
		this.adjacentRequest = false;
		this.publish();
	}
	dismissError(): void {
		this.error = null;
		this.publish();
	}
	private publish(): void {
		const context = this.context;
		const index =
			context?.chapters.findIndex((item) => item.id === this.chapterId) ?? -1;
		const busy =
			this.adjacentRequest ||
			!!(this.surface?.adjacent && !this.surface.stable);
		const next: ReaderNavigationState = {
			origin: this.origin,
			originProgress: this.originProgress,
			error: this.error,
			busy,
			adjacentDisabled: busy || !this.surface?.stable || !!context?.unavailable,
			returning: !!this.surface?.returning,
			previous: index < 0 ? null : (context?.chapters[index - 1] ?? null),
			next: index < 0 ? null : (context?.chapters[index + 1] ?? null),
		};
		if (
			(Object.keys(next) as (keyof ReaderNavigationState)[]).every(
				(key) => next[key] === this.snapshot[key],
			)
		)
			return;
		this.snapshot = next;
		context?.changed(next);
	}
	private completion(
		surface: Surface,
	): (result: ReaderNavigationCompletion) => void {
		return (result) => {
			if (!this.context || this.surface !== surface) return;
			if (result.error) this.error = result.error;
			const returning = surface.returning;
			if (returning) {
				surface.returning = null;
				if (returning.revision === this.originRevision) {
					if (result.located && sameContent(returning.target, result.anchor)) {
						this.origin = null;
						this.originProgress = null;
						this.originRevision++;
					} else
						this.error = new Error(
							"无法返回跳转前的位置，已保留返回点，请重试。",
						);
				}
			}
			surface.stable = true;
			this.publish();
		};
	}
	async navigate(
		intent: ReaderNavigationIntent,
		source?: "left" | "right",
	): Promise<boolean> {
		const context = this.context;
		if (!context) return false;
		if (intent.type === "adjacent" && this.state.adjacentDisabled) return false;
		const adjacent =
			intent.type === "adjacent" ? this.state[intent.direction] : null;
		if (intent.type === "adjacent" && !adjacent) return false;
		this.invalidate();
		const request = this.request;
		const accepts = () => this.context !== null && this.request === request;
		if (intent.type === "chapter" && intent.id === this.chapterId) {
			if (source) context.closePanels(source);
			return false;
		}
		if (intent.type === "return" && !this.origin) return false;
		this.error = null;
		this.adjacentRequest = intent.type === "adjacent";
		this.publish();
		try {
			const explicit =
				intent.type === "position"
					? intent.target
					: intent.type === "return"
						? this.origin
						: null;
			if (explicit && explicit.version_id !== context.versionId)
				throw new Error("原位置版本已不可用。");
			const id =
				explicit?.chapter_id ??
				(intent.type === "chapter"
					? intent.id
					: (adjacent?.id ?? this.chapterId));
			const data = await context.loadChapter(id);
			if (!accepts()) return false;
			const active = this.context;
			if (!active) return false;
			if (data.version_id !== active.versionId)
				throw new Error("原位置版本已不可用。");
			if (data.id !== id)
				throw new Error("无法定位到原文位置，请重新打开目录或重试。");
			const draft: NavigationDraft = explicit
				? {
						target: { ...explicit, settings: active.settings },
						beginning: false,
						...(intent.type === "position" && intent.mark
							? { mark: intent.mark }
							: {}),
					}
				: chapterDestination(
						data,
						active.remembered(id),
						active.versionId,
						active.settings,
						intent.type === "beginning",
					);
			const target = draft.target;
			if (target.version_id !== active.versionId)
				throw new Error("原位置版本已不可用。");
			const part = data.parts[target.part_index];
			if (
				target.chapter_id !== data.id ||
				!part ||
				part.resource_id !== target.resource_id ||
				(target.kind === "text" &&
					((target.offset ?? -1) < part.start ||
						(target.offset ?? -1) > part.end)) ||
				(target.kind === "image" &&
					!part.html.includes(`data-epub-image="${target.image_id}"`))
			)
				throw new Error("无法定位到原文位置，请重新打开目录或重试。");
			const destination: ReaderNavigationDestination = {
				...draft,
				chapter: data,
				part,
			};
			const last = active.presentedAnchor();
			if (
				intent.type === "beginning" &&
				active.atBeginning() &&
				last?.version_id === target.version_id &&
				last.chapter_id === target.chapter_id
			) {
				if (source) active.closePanels(source);
				return false;
			}
			if (last) active.saveDeparture(last);
			if (intent.type !== "return") {
				const origin =
					intent.type === "beginning" ||
					(this.reading.shouldReplace && last !== null)
						? last
						: (this.origin ?? last);
				if (origin !== this.origin) {
					this.origin = origin;
					this.originProgress = origin ? active.progressFor(origin) : null;
				}
				this.originRevision++;
			}
			this.reading.reset();
			const surface: Surface = {
				stable: false,
				adjacent: intent.type === "adjacent",
				returning:
					intent.type === "return"
						? { target, revision: this.originRevision }
						: null,
			};
			this.surface = surface;
			this.chapterId = target.chapter_id;
			this.adjacentRequest = false;
			active.present(destination, this.completion(surface));
			if (intent.type === "return") active.closePanels();
			else if (source) active.closePanels(source);
			this.publish();
			return true;
		} catch (failure) {
			if (accepts()) {
				this.adjacentRequest = false;
				this.error =
					failure instanceof Error ? failure : new Error(String(failure));
				this.publish();
			}
			return false;
		}
	}
}
