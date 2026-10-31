import type { TranslationResult } from "../translation/api.ts";
import type { Chapter } from "./api.ts";
import { inlineTranslationAtHit, recordsAtHit } from "./chapter-records.ts";
import type { ChapterTranslation } from "./chapter-translations-query.ts";
import type { ReaderFrames } from "./reader-frames.ts";
import type {
	ReaderPanelKind,
	ReaderPanelSide,
	ReaderPanelsState,
} from "./reader-panel-logic.ts";
import type { StudyMarkHit, StudySelection } from "./reader-study.ts";
import type { ChapterSegment } from "./study-api.ts";

type Emphasis = { id: string; kind: "segment" | "translation" };
type HitRecords = {
	segments: readonly ChapterSegment[];
	translations: readonly ChapterTranslation[];
};
export type ReaderInlineRequest = Readonly<{
	chapterId: string;
	item: ChapterTranslation;
	hit: StudyMarkHit;
}>;
export type ReaderRecordState = Readonly<{
	selection: StudySelection | null;
	markHit: StudyMarkHit | null;
	manualPosition: { left: number; top: number } | null;
	inlineRequest: ReaderInlineRequest | null;
	previewSerial: number;
}>;
export type ReaderRecordContext = {
	active: boolean;
	alive: boolean;
	materialId: string;
	versionId: string;
	chapterId: string;
	chapter: Chapter | undefined;
	direction: "horizontal-tb" | "vertical-rl";
	panels: ReaderPanelsState;
	compactPanels: boolean;
	studyTargetActive: boolean;
	segments: readonly ChapterSegment[];
	translations: readonly ChapterTranslation[];
	settled: boolean;
};
type Dependencies = {
	current: () => ReaderRecordContext;
	frames: Pick<
		ReaderFrames,
		"clearStudySelection" | "emphasizeStudyMark" | "setInlineTranslation"
	>;
	closeStudyPanel: () => void;
	hideTranslation: () => void;
	showTools: () => void;
	changed: (state: ReaderRecordState) => void;
};
export const EMPTY_READER_RECORD_STATE: ReaderRecordState = {
	selection: null,
	markHit: null,
	manualPosition: null,
	inlineRequest: null,
	previewSerial: 0,
};

/** Owns record presentation rules; native selection and layout remain frame capabilities. */
export class ReaderRecordPresentation {
	private snapshot = EMPTY_READER_RECORD_STATE;
	private emphasis: Emphasis | null = null;
	private trigger: HTMLButtonElement | null = null;
	private hitCache: {
		segments: readonly ChapterSegment[];
		translations: readonly ChapterTranslation[];
		hit: StudyMarkHit | null;
		value: HitRecords;
	} | null = null;
	// Material/version changes replace the keyed Reader and this instance.
	private chapterId: string | null = null;
	private readonly dependencies: Dependencies;
	constructor(dependencies: Dependencies) {
		this.dependencies = dependencies;
	}
	get state(): ReaderRecordState {
		return this.snapshot;
	}
	get hitRecords(): HitRecords {
		const { segments, translations } = this.dependencies.current();
		const hit = this.snapshot.markHit;
		if (
			this.hitCache?.segments === segments &&
			this.hitCache.translations === translations &&
			this.hitCache.hit === hit
		)
			return this.hitCache.value;
		const value = recordsAtHit(segments, translations, hit);
		this.hitCache = { segments, translations, hit, value };
		return value;
	}
	get active(): boolean {
		return this.snapshot.selection !== null || this.snapshot.markHit !== null;
	}
	private update(patch: Partial<ReaderRecordState>): void {
		const next = { ...this.snapshot, ...patch };
		if (!next.markHit) next.manualPosition = null;
		if (
			(Object.keys(next) as (keyof ReaderRecordState)[]).every(
				(key) => next[key] === this.snapshot[key],
			)
		)
			return;
		// Frame clearing synchronously reenters selectionChanged; publish the new state first.
		this.snapshot = next;
		this.dependencies.changed(next);
	}
	private emphasize(value: Emphasis | null): void {
		this.emphasis = value;
		this.dependencies.frames.emphasizeStudyMark(value?.id ?? null, value?.kind);
	}
	private clearPreview(focus = false): void {
		this.update({ markHit: null });
		this.emphasize(null);
		this.dependencies.closeStudyPanel();
		if (focus) this.trigger?.focus({ preventScroll: true });
	}
	selectionChanged(value: StudySelection | null): void {
		const context = this.dependencies.current();
		if (!context.alive || !context.active) return;
		this.update({ selection: value });
		if (!value) return;
		if (
			!this.snapshot.markHit?.fixed &&
			!this.snapshot.manualPosition &&
			!this.snapshot.inlineRequest &&
			context.panels.right !== "study"
		) {
			this.update({ markHit: null });
			this.emphasize(null);
		}
		this.dependencies.showTools();
	}
	clearToolbar(): void {
		this.update({ selection: null });
	}
	markChanged(value: StudyMarkHit | null): void {
		const context = this.dependencies.current();
		if (!context.alive || !context.active) return;
		if (value) {
			if (!context.studyTargetActive) this.openTextMark(value);
		} else if (
			context.panels.right === "study" ||
			this.snapshot.manualPosition ||
			this.snapshot.inlineRequest ||
			this.snapshot.markHit?.fixed
		) {
			this.dependencies.frames.emphasizeStudyMark(
				this.emphasis?.id ?? null,
				this.emphasis?.kind,
			);
		} else {
			this.update({ markHit: null });
			this.emphasis = null;
		}
	}
	openPreview(
		value: StudyMarkHit,
		trigger: HTMLButtonElement | null = null,
	): void {
		this.closeInline();
		this.trigger = trigger;
		this.update({
			markHit: value,
			selection: null,
			previewSerial: this.snapshot.previewSerial + 1,
		});
		this.emphasize(null);
		this.dependencies.hideTranslation();
		this.dependencies.frames.clearStudySelection();
		this.dependencies.closeStudyPanel();
	}
	openTextMark(value: StudyMarkHit): void {
		const context = this.dependencies.current();
		const item = !this.snapshot.manualPosition
			? inlineTranslationAtHit(
					context.segments,
					context.translations,
					value,
					context.direction,
				)
			: null;
		if (!item) {
			this.openPreview(value);
			return;
		}
		if (
			this.snapshot.inlineRequest?.item.identity_sha256 === item.identity_sha256
		) {
			this.closeInline();
			return;
		}
		this.update({
			markHit: null,
			selection: null,
			inlineRequest: { chapterId: context.chapterId, item, hit: value },
		});
		this.dependencies.hideTranslation();
		this.dependencies.frames.clearStudySelection();
		this.dependencies.closeStudyPanel();
		this.emphasize({ id: item.identity_sha256, kind: "translation" });
	}
	closeInline(): void {
		const hadRequest = this.snapshot.inlineRequest !== null;
		this.update({ inlineRequest: null });
		if (hadRequest) this.emphasize(null);
	}
	closePreview(): void {
		this.closeInline();
		this.clearPreview(true);
	}
	private closeCompactPreview(): boolean {
		if (
			!this.snapshot.markHit ||
			this.snapshot.manualPosition ||
			this.snapshot.markHit.fixed ||
			this.dependencies.current().panels.right === "study"
		)
			return false;
		this.update({ markHit: null });
		this.emphasize(null);
		return true;
	}
	dismissBackground(): boolean {
		const hadToolbar = this.snapshot.selection !== null;
		const cleared = this.dependencies.frames.clearStudySelection();
		const closed = this.closeCompactPreview();
		return hadToolbar || cleared || closed;
	}
	escape(): boolean {
		const context = this.dependencies.current();
		if (this.snapshot.selection) {
			this.clearToolbar();
			return true;
		}
		if (this.snapshot.inlineRequest) {
			this.closeInline();
			return true;
		}
		if (
			this.snapshot.markHit &&
			!(
				context.panels.right === "study" &&
				context.compactPanels &&
				context.panels.activeSide === "left"
			)
		) {
			this.clearPreview(true);
			return true;
		}
		return false;
	}
	panelSelected(next: ReaderPanelKind): void {
		this.clearToolbar();
		if (
			!(
				this.dependencies.current().panels.right === "study" &&
				(next === "toc" || next === "bookmarks" || next === "search")
			)
		) {
			this.update({ markHit: null });
			this.emphasize(null);
		}
	}
	panelClosed(side?: ReaderPanelSide): void {
		if (
			(!side || side === "right") &&
			this.dependencies.current().panels.right === "study"
		) {
			this.update({ markHit: null });
			this.emphasize(null);
		}
	}
	setManualPosition(value: ReaderRecordState["manualPosition"]): void {
		this.update({ manualPosition: value });
	}
	emphasizePreview(
		serial: number,
		id: string | null,
		kind: "segment" | "translation" = "segment",
	): void {
		if (!this.snapshot.markHit || serial !== this.snapshot.previewSerial)
			return;
		this.emphasize(id ? { id, kind } : null);
	}
	translationRemoved(identity: string): void {
		if (this.snapshot.inlineRequest?.item.identity_sha256 === identity)
			this.closeInline();
		if (this.emphasis?.kind === "translation" && this.emphasis.id === identity)
			this.emphasize(null);
	}
	reconcile(): void {
		const context = this.dependencies.current();
		if (this.chapterId !== context.chapterId) {
			this.chapterId = context.chapterId;
			this.closeInline();
			this.clearPreview();
			return;
		}
		const hit = this.snapshot.markHit;
		const records = this.hitRecords;
		if (
			hit &&
			!hit.fixed &&
			context.settled &&
			!records.segments.length &&
			!records.translations.length
		)
			this.closePreview();
	}
	presentInline(
		request: ReaderInlineRequest | null,
		result: TranslationResult | undefined,
		failed: boolean,
		mutate: (update: () => void) => void,
	): void {
		// A late render/result cannot clear or reopen a superseding request.
		if (request !== this.snapshot.inlineRequest) return;
		const context = this.dependencies.current();
		const chapter = context.chapter;
		if (!context.active || !chapter) return;
		if (
			!request ||
			request.chapterId !== context.chapterId ||
			context.direction !== "horizontal-tb"
		) {
			this.dependencies.frames.setInlineTranslation(chapter, null, mutate);
			if (request) this.closeInline();
			return;
		}
		if (
			context.settled &&
			!inlineTranslationAtHit(
				context.segments,
				context.translations,
				request.hit,
				context.direction,
			)
		) {
			this.closeInline();
			return;
		}
		if (failed) {
			this.openPreview(request.hit);
			return;
		}
		if (!result) {
			this.dependencies.frames.setInlineTranslation(chapter, null, mutate);
			return;
		}
		const item = request.item;
		const matching =
			!result.reader_deleted &&
			result.id === item.result_id &&
			result.identity_sha256 === item.identity_sha256 &&
			result.material_provenance.material_id === context.materialId &&
			result.material_provenance.version_id === context.versionId;
		if (
			!matching ||
			!this.dependencies.frames.setInlineTranslation(
				chapter,
				{ reference: result.material_provenance, text: result.translation },
				mutate,
			)
		)
			this.openPreview(request.hit);
	}
}
