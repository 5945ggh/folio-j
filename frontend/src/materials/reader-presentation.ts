import type { Chapter, Position, ReadingsResponse, Settings } from "./api.ts";
import type { PositionQueue } from "./position.ts";
import type { BookUiPreferences } from "./preferences.ts";
import type { ReaderFrames } from "./reader-frames.ts";
import { ReaderLayout } from "./reader-layout.ts";
import type {
	ReaderNavigation,
	ReaderNavigationCompletion,
	ReaderNavigationDestination,
} from "./reader-navigation.ts";
import type { JumpReadingSession } from "./return-origin.ts";
import type { ViewportSize } from "./viewport.ts";

export type ReaderPresentationState = Readonly<{
	chapterId: string;
	settings: Settings;
	generation: number;
	layoutRevision: number;
}>;
export type ReaderRestoreIntent = {
	initialPresentation: boolean;
	beginning: boolean;
};
type RestoreResult = {
	located: boolean;
	error?: Error;
	afterRestore: () => void;
};
type PresentationDom = {
	size: () => ViewportSize | null;
	capture: () => Position | null;
	restore: (
		anchor: Position | null,
		intent: ReaderRestoreIntent,
	) => false | RestoreResult;
};
type PresentationContent = {
	state: ReaderPresentationState;
	chapter: Chapter;
	theme: "white" | "black";
	bookUi: BookUiPreferences;
	readings?: ReadingsResponse;
};
type PresentationDependencies = {
	frames: Pick<
		ReaderFrames,
		| "clear"
		| "load"
		| "measure"
		| "presentation"
		| "update"
		| "finishInlineMotion"
		| "inlineMotionRunning"
	>;
	navigation: Pick<ReaderNavigation, "suspend">;
	reading: Pick<JumpReadingSession, "pause">;
	writer: () => Pick<
		PositionQueue<Position>,
		"enqueue" | "flush" | "stop"
	> | null;
	changed: (state: ReaderPresentationState) => void;
};
type Receipt = {
	complete: (result: ReaderNavigationCompletion) => void;
};

/** Owns the transition from an accepted destination to stable, saveable content. */
export class ReaderPresentation {
	private readonly layout: ReaderLayout<Position>;
	private readonly initialAnchor: Position | null;
	private readonly dependencies: PresentationDependencies;
	private snapshot: ReaderPresentationState;
	private active = false;
	private receipt: Receipt | null = null;
	private beginning = false;
	private releaseTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		state: ReaderPresentationState,
		anchor: Position | null,
		dependencies: PresentationDependencies,
	) {
		this.snapshot = state;
		this.initialAnchor = anchor;
		this.layout = new ReaderLayout(anchor);
		this.dependencies = dependencies;
	}
	get state(): ReaderPresentationState {
		return this.snapshot;
	}
	private revise(changes: Partial<ReaderPresentationState> = {}): void {
		this.snapshot = {
			...this.snapshot,
			...changes,
			layoutRevision: this.snapshot.layoutRevision + 1,
		};
		this.dependencies.changed(this.snapshot);
	}
	private replace(chapterId: string): void {
		this.layout.invalidateSurface();
		this.dependencies.frames.clear();
		this.revise({ chapterId, generation: this.snapshot.generation + 1 });
	}
	present(
		destination: ReaderNavigationDestination | null,
		complete: Receipt["complete"],
		capture: () => Position | null,
	): void {
		if (!this.active) return;
		this.receipt = { complete };
		if (destination) this.beginning = destination.beginning;
		this.layout.setAnchor(destination?.target ?? this.layout.anchor(capture));
		if (
			destination &&
			destination.target.chapter_id !== this.snapshot.chapterId
		)
			this.replace(destination.target.chapter_id);
		else this.revise();
	}
	change(settings: Settings, capture: () => Position | null): void {
		if (!this.active) return;
		this.dependencies.frames.finishInlineMotion();
		const anchor = this.layout.anchor(capture);
		this.layout.setAnchor(anchor ? { ...anchor, settings } : null);
		this.revise({ settings });
	}
	retry(): void {
		if (this.active) this.replace(this.snapshot.chapterId);
	}
	commit(content: PresentationContent, dom: PresentationDom): void {
		const { state, chapter, theme, bookUi, readings } = content;
		if (
			!this.active ||
			state !== this.snapshot ||
			chapter.id !== state.chapterId
		)
			return;
		const { frames, reading } = this.dependencies;
		const { settings } = state;
		this.layout.commit(
			{
				generation: state.generation,
				parts: chapter.parts.length,
				geometry: [
					state.layoutRevision,
					settings.font_size,
					settings.line_height,
					settings.writing_mode,
					bookUi.font,
					bookUi.width,
					bookUi.rubyScope,
				].join("|"),
				size: () =>
					this.active && state === this.snapshot ? dom.size() : null,
				capture: dom.capture,
				measure: () => frames.measure(settings.writing_mode === "vertical-rl"),
				restore: (anchor, initialPresentation) => {
					const receipt = this.receipt;
					const result = dom.restore(anchor, {
						initialPresentation,
						beginning: this.beginning,
					});
					if (result === false) return false;
					return () => {
						// ReaderLayout invokes this only after the recovery ticket finishes.
						this.beginning = false;
						if (receipt && this.receipt === receipt) {
							this.receipt = null;
							receipt.complete({
								anchor,
								located: result.located,
								error: result.error,
							});
						}
						result.afterRestore();
					};
				},
			},
			() => frames.presentation(theme, bookUi),
			() => {
				reading.pause();
				frames.update(chapter, settings, theme, bookUi, readings);
			},
			() => frames.finishInlineMotion(),
		);
	}
	load(
		index: number,
		element: HTMLIFrameElement,
		generation: number,
		context: Omit<
			Parameters<ReaderFrames["load"]>[3],
			"generation" | "ready" | "active"
		>,
	): void {
		this.dependencies.frames.load(index, element, generation, {
			...context,
			active: () => this.active,
			generation: () => this.snapshot.generation,
			ready: (token, part) => this.layout.resourcesReady(token, part),
		});
	}
	canSample(size: ViewportSize): boolean {
		return (
			this.active &&
			!this.dependencies.frames.inlineMotionRunning &&
			this.layout.canSample(size)
		);
	}
	observe(size: ViewportSize, capture: () => Position | null): Position | null {
		if (!this.active || this.dependencies.frames.inlineMotionRunning)
			return null;
		return this.layout.observe(size, capture, (anchor) =>
			this.dependencies.writer()?.enqueue(anchor),
		);
	}
	presentedAnchor(
		capture: () => Position | null = () => null,
	): Position | null {
		return this.layout.presentedAnchor(capture);
	}
	reflow(update?: () => void, capture?: () => Position | null): void {
		// Inline translation motion intentionally bypasses commit's stabilization.
		if (this.active) this.layout.reflow(update, capture);
	}
	checkpoint(capture: () => Position | null): void {
		this.dependencies.frames.finishInlineMotion();
		this.layout.cancelSave();
		let sampled: Position | null = null;
		const anchor = this.layout.presentedAnchor(() => {
			sampled = capture();
			return sampled;
		});
		// Saving the last presented location must not replace a pending destination.
		this.layout.setAnchor(sampled ?? this.layout.anchor(() => null));
		if (anchor) {
			this.dependencies.writer()?.enqueue(anchor);
		}
	}
	setActive(active: boolean, discard = false): void {
		if (active) this.mount();
		if (this.active === active) return;
		this.active = active;
		if (active) {
			this.layout.setAnchor(
				this.layout.anchor(() => null) ?? this.initialAnchor,
			);
			this.revise();
			return;
		}
		this.layout.cancelSave();
		this.receipt = null;
		const writer = this.dependencies.writer();
		const anchor = this.layout.presentedAnchor(() => null);
		if (anchor && !discard) writer?.enqueue(anchor);
		if (!discard) void writer?.flush();
		this.dependencies.reading.pause();
		this.dependencies.navigation.suspend();
	}
	mount(): void {
		if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
		this.releaseTimer = null;
	}
	unmount(discard = false): void {
		this.setActive(false, discard);
		if (discard) this.dependencies.writer()?.stop();
		// StrictMode replays effects against retained DOM; only real removal releases it.
		this.mount();
		this.releaseTimer = setTimeout(() => {
			this.releaseTimer = null;
			this.dependencies.frames.clear();
			this.layout.invalidateSurface();
		}, 0);
	}
}
