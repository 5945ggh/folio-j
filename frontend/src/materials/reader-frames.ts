import type { Chapter, ReadingsResponse, Settings } from "./api.ts";
import {
	htmlEscape,
	imageTextOffset,
	type Projection,
	projectPart,
} from "./dom.ts";
import { isReaderFrameTarget, registerReaderFrameTargets } from "./focus.ts";
import {
	clearSearchHighlights,
	prepareHighlights,
	projectedBaseRanges,
	refreshSearchHighlightForeground,
	setSearchHighlightOpacity,
} from "./highlight.ts";
import { InlineTranslation } from "./inline-translation.ts";
import { currentSurface } from "./position.ts";
import type { BookUiPreferences } from "./preferences.ts";
import {
	applyFramePresentation,
	normalizeFrameImages,
} from "./presentation.ts";
import { copyReaderSelection } from "./reader-clipboard.ts";
import { ReaderFlowMotion } from "./reader-flow-motion.ts";
import {
	captureNativeSelection,
	type ReaderHighlightRange,
	referenceParts,
} from "./reader-selection.ts";
import {
	ReaderStudy,
	type StudyBinding,
	type StudyMark,
	type StudyMarkKind,
} from "./reader-study.ts";
import { applyAutomaticRuby } from "./ruby.ts";
import type { MaterialProvenance, StudyTarget } from "./study-api.ts";
import { readingViewport } from "./viewport.ts";

export type ReaderFrame = {
	element: HTMLIFrameElement;
	doc: Document;
	projection: Projection;
	imageOffsets: Map<number, number>;
	contentEnd: number | null;
	resize: () => void;
	cleanup: () => void;
	presentationCleanup: () => void;
	rubyApplied: boolean;
};
export function partDocument(
	part: Chapter["parts"][number],
	resource: Chapter["resources"][number],
	settings: Settings,
) {
	const attrs = (values: Record<string, string>) =>
		Object.entries(values)
			.filter(([key]) => ["class", "lang", "dir"].includes(key))
			.map(([k, v]) => `${k}="${htmlEscape(v)}"`)
			.join(" ");
	// Compiled author CSS is isolated in this document; CSP prevents external resource loads.
	return `<!doctype html><html ${attrs(resource.html_attributes)}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'"><style>${resource.css.replace(/<\/style/gi, "&lt;/style")}</style><style>html,body{margin:0!important;padding:0!important;background:transparent!important;}body{font-size:${settings.font_size}px!important;line-height:${settings.line_height}!important;writing-mode:${settings.writing_mode}!important;color:#292b28!important;}img{max-width:100%;object-fit:contain;}ruby rt{font-size:.55em;}html[data-reader-ruby-scope="original"] ruby[data-auto-ruby]{display:contents!important;}html[data-reader-ruby-scope="original"] ruby[data-auto-ruby] rt{display:none!important;}a{pointer-events:none;}html,body{overflow:hidden!important;}</style></head><body ${attrs(resource.body_attributes)}>${part.html}</body></html>`;
}
function applyDocumentSettings(doc: Document, settings: Settings) {
	doc.body.style.setProperty(
		"font-size",
		`${settings.font_size}px`,
		"important",
	);
	doc.body.style.setProperty(
		"line-height",
		String(settings.line_height),
		"important",
	);
	doc.body.style.setProperty(
		"writing-mode",
		settings.writing_mode,
		"important",
	);
}
type FrameContext = {
	active?: () => boolean;
	chapter: Chapter;
	readingGeneration: string;
	readings: ReadingsResponse | undefined;
	current: () => {
		settings: Settings;
		theme: "white" | "black";
		bookUi: BookUiPreferences;
	};
	generation: () => number;
	root: () => HTMLElement | null;
	bindFocus: (
		doc: Document,
		element: HTMLIFrameElement,
	) => (() => void) | undefined;
	key: (event: KeyboardEvent) => void;
	wheel: (event: WheelEvent) => void;
	touch: (event: TouchEvent) => void;
	interaction?: (event: Event) => void;
	image: (part: number, image: number) => void;
	ready: (generation: number, index: number) => void;
	error: (error: Error) => void;
};

/** Owns iframe lifetime and exact native-selection/reference projection. */
export class ReaderFrames {
	private readonly study = new ReaderStudy();
	private root: () => HTMLElement | null = () => null;
	private readonly flowMotion = new ReaderFlowMotion(
		() => this.frames.values(),
		() => this.root(),
	);
	private readonly inlineTranslation = new InlineTranslation(() =>
		this.flowMotion.beforeRemove(),
	);
	private measuringInlineLayout = false;
	get inlineMotionRunning(): boolean {
		return !this.measuringInlineLayout && this.flowMotion.running;
	}
	finishInlineMotion(): void {
		if (this.inlineTranslation.closing) this.inlineTranslation.clear();
		else this.inlineTranslation.restoreNatural();
		this.flowMotion.clear();
	}
	inlineMarginsChanged(): void {
		this.flowMotion.marginsChanged();
	}
	setInlineTranslation(
		chapter: Chapter,
		value: { reference: MaterialProvenance; text: string } | null,
		mutate: (update: () => void) => void,
	): boolean {
		if (!value) {
			const node = this.inlineTranslation.element;
			if (this.inlineTranslation.hide(mutate) && node) {
				this.flowMotion.collapse(node, this.inlineTranslation.fullHeight);
				this.flowMotion.synchronize(this.inlineTranslation.animations);
			}
			return true;
		}
		try {
			const reference = value.reference;
			if (
				reference.contract_version !== "1" ||
				reference.material_id !== chapter.material_id ||
				reference.version_id !== chapter.version_id
			)
				throw new Error("出处身份失配。");
			const targets = referenceParts(chapter, reference.ranges);
			let final: { index: number; end: number; projection: Projection } | null =
				null;
			for (const [index, intervals] of targets) {
				const projection = this.freshProjection(index, chapter);
				for (const interval of intervals)
					final = { index, end: interval.end, projection };
			}
			if (!final) throw new Error("没有可定位的出处。");
			const frame = this.frames.get(final.index),
				valid = this.validity.get(final.index);
			if (!frame || !valid) throw new Error("正文尚未显示。");
			const show = () =>
				this.inlineTranslation.set(
					frame.doc,
					final.projection,
					final.end,
					value.text,
					mutate,
					valid,
				);
			if (this.inlineTranslation.isShowing(frame.doc, final.end, value.text))
				return show();
			this.inlineTranslation.prepareReopen();
			const result = this.flowMotion.change(
				show,
				() => this.inlineTranslation.growth,
			);
			this.flowMotion.synchronize(this.inlineTranslation.animations);
			return result;
		} catch {
			this.inlineTranslation.clear();
			return false;
		}
	}
	bindStudy(binding: StudyBinding | null): void {
		this.study.bind(binding);
	}
	setStudyMarks(
		chapter: Chapter,
		marks: readonly StudyMark[],
		visible: boolean,
		theme: "white" | "black",
		margins = false,
	): void {
		this.flowMotion.measure(() =>
			this.study.setMarks(chapter, marks, visible, theme, margins),
		);
	}
	emphasizeStudyMark(id: string | null, kind: StudyMarkKind = "segment"): void {
		this.flowMotion.measure(() => this.study.emphasize(id, kind));
	}
	invalidateStudyGeometry(): void {
		this.study.geometryChanged(false);
	}
	refreshStudyGeometry(): void {
		this.flowMotion.measure(() => this.study.refresh());
	}
	preserveStudyPreviewDuringLayout(update: () => void): void {
		const previous = this.measuringInlineLayout;
		this.measuringInlineLayout = true;
		try {
			this.flowMotion.measure(() =>
				this.study.preservePreviewDuringLayout(update),
			);
		} finally {
			this.measuringInlineLayout = previous;
		}
	}
	clearStudySelection(): boolean {
		return this.study.clearSelection();
	}
	private freshProjection(index: number, chapter: Chapter): Projection {
		const frame = this.frames.get(index),
			part = chapter.parts[index];
		const resource = chapter.resources.find(
			(item) => item.id === part?.resource_id,
		);
		const mounted = this.origins.get(index),
			mountedPart = mounted?.parts[index];
		if (
			!frame ||
			!part ||
			!resource ||
			!this.validity.get(index)?.() ||
			mounted?.material_id !== chapter.material_id ||
			mounted?.version_id !== chapter.version_id ||
			mounted?.id !== chapter.id ||
			mountedPart?.resource_id !== part.resource_id ||
			mountedPart?.spine_index !== part.spine_index ||
			mountedPart?.start !== part.start ||
			mountedPart?.end !== part.end
		)
			throw new Error("原文尚未完整显示，已保留定位目标，请重试。");
		frame.projection = projectPart(
			frame.doc,
			Array.from(resource.text).slice(part.start, part.end).join(""),
			part.leaf_start,
		);
		return frame.projection;
	}
	validateStudyTarget(
		chapter: Chapter,
		ranges: readonly ReaderHighlightRange[],
	): void {
		const parts = referenceParts(chapter, ranges);
		for (const [index, intervals] of parts) {
			const projection = this.freshProjection(index, chapter),
				frame = this.frames.get(index);
			if (!frame) throw new Error("原文尚未完整显示，目标已保留。");
			for (const { start, end } of intervals)
				projectedBaseRanges(frame.doc, projection, start, end);
		}
	}
	private searchHighlightOpacity = 1;
	private readonly frames = new Map<number, ReaderFrame>();
	private readonly elements = new Map<number, HTMLIFrameElement>();
	private readonly validity = new Map<number, () => boolean>();
	private readonly origins = new Map<number, Chapter>();
	get(index: number) {
		return this.frames.get(index);
	}
	values() {
		return this.frames.values();
	}
	[Symbol.iterator]() {
		return this.frames[Symbol.iterator]();
	}
	register(index: number, element: HTMLIFrameElement | null) {
		if (element) this.elements.set(index, element);
		else this.elements.delete(index);
	}
	clear() {
		this.searchHighlightOpacity = 1;
		this.inlineTranslation.clear(false);
		this.flowMotion.clear();
		this.study.clear();
		for (const frame of this.frames.values()) {
			frame.cleanup();
			frame.presentationCleanup();
		}
		this.frames.clear();
		this.validity.clear();
		this.origins.clear();
	}
	captureStudyTarget(
		materialId: string,
		versionId: string,
		chapter: Chapter,
	): StudyTarget {
		this.finishInlineMotion();
		const selected = [...this.frames].filter(([, frame]) => {
			const selection = frame.doc.getSelection();
			return selection && !selection.isCollapsed;
		});
		if (selected.length !== 1)
			throw new Error("请在同一个正文区域内选择连续原文，不支持跨区域选择。");
		const chosen = selected[0];
		if (!chosen) throw new Error("请选择原文。");
		const [index, frame] = chosen;
		if (!this.validity.get(index)?.())
			throw new Error("原文显示已经改变，请重新选择。");
		const part = chapter.parts[index];
		const resource = chapter.resources.find(
			(item) => item.id === part?.resource_id,
		);
		if (!part || !resource) throw new Error("当前章节资源不可用。");
		frame.projection = projectPart(
			frame.doc,
			Array.from(resource.text).slice(part.start, part.end).join(""),
			part.leaf_start,
		);
		return {
			reference: captureNativeSelection(
				frame.doc,
				frame.projection,
				part,
				resource,
				materialId,
				versionId,
			),
			chapter: structuredClone(chapter),
		};
	}
	highlight(chapter: Chapter, ranges: readonly ReaderHighlightRange[]) {
		const targets = referenceParts(chapter, ranges);
		const paint: (() => void)[] = [];
		for (const [index, intervals] of targets) {
			const frame = this.frames.get(index);
			const part = chapter.parts[index];
			const resource = chapter.resources.find(
				(item) => item.id === part?.resource_id,
			);
			if (!frame || !part || !resource || !this.validity.get(index)?.())
				throw new Error("原文尚未完整显示，已保留定位目标，请重试。");
			frame.projection = projectPart(
				frame.doc,
				Array.from(resource.text).slice(part.start, part.end).join(""),
				part.leaf_start,
			);
			paint.push(prepareHighlights(frame.doc, frame.projection, intervals));
		}
		for (const commit of paint) commit();
		this.setSearchHighlightOpacity(this.searchHighlightOpacity);
	}
	setSearchHighlightOpacity(value: number): void {
		this.searchHighlightOpacity = value;
		for (const frame of this.frames.values())
			setSearchHighlightOpacity(frame.doc, value);
	}
	clearSearchHighlights(): void {
		this.searchHighlightOpacity = 1;
		for (const frame of this.frames.values()) clearSearchHighlights(frame.doc);
	}
	refreshSearchHighlightForeground(): void {
		for (const frame of this.frames.values())
			refreshSearchHighlightForeground(frame.doc);
	}
	update(
		chapter: Chapter,
		settings: Settings,
		theme: "white" | "black",
		bookUi: BookUiPreferences,
		readings: ReadingsResponse | undefined,
	) {
		this.flowMotion.clear();
		if (this.inlineTranslation.closing) this.inlineTranslation.clear(false);
		if (settings.writing_mode !== "horizontal-tb")
			this.inlineTranslation.clear(false);
		for (const [index, frame] of this.frames) {
			frame.presentationCleanup();
			frame.presentationCleanup = applyFramePresentation(
				frame.doc,
				theme,
				bookUi,
			);
			applyDocumentSettings(frame.doc, settings);
			const part = chapter.parts[index];
			const resource = chapter.resources.find(
				(item) => item.id === part?.resource_id,
			);
			if (
				bookUi.rubyScope === "all" &&
				!frame.rubyApplied &&
				part &&
				resource
			) {
				const asset = readings?.resources.find(
					(item) => item.resource_id === part.resource_id,
				);
				if (!asset) throw new Error("章节注音暂不可用，请重试。");
				registerReaderFrameTargets(
					frame.doc,
					applyAutomaticRuby(
						frame.doc,
						frame.projection,
						asset.tokens,
						part.start,
					),
				);
				frame.projection = projectPart(
					frame.doc,
					Array.from(resource.text).slice(part.start, part.end).join(""),
					part.leaf_start,
				);
				frame.rubyApplied = true;
			}
		}
		this.refreshSearchHighlightForeground();
		this.inlineTranslation.refresh();
		this.study.geometryChanged();
	}
	load(
		index: number,
		element: HTMLIFrameElement,
		token: number,
		context: FrameContext,
	) {
		this.root = context.root;
		const doc = element.contentDocument;
		let loaded = false;
		const valid = () =>
			currentSurface(
				token,
				context.generation(),
				element.isConnected,
				this.elements.get(index) === element &&
					!!context.root()?.contains(element) &&
					element.contentDocument === doc &&
					(!loaded || this.validity.get(index) === valid),
			);
		if (!valid()) return;
		const data = context.chapter;
		if (!doc || !data) return;
		const part = data.parts[index];
		if (!part) return;
		const resource = data.resources.find((r) => r.id === part.resource_id);
		if (!resource) return;
		try {
			this.inlineTranslation.clear(false);
			this.flowMotion.clear();
			applyDocumentSettings(doc, context.current().settings);
			let projection = projectPart(
				doc,
				Array.from(resource.text).slice(part.start, part.end).join(""),
				part.leaf_start,
			);
			if (context.current().bookUi.rubyScope === "all") {
				const asset = context.readings?.resources.find(
					(r) => r.resource_id === part.resource_id,
				);
				if (
					!asset ||
					context.readings?.generation_id !== context.readingGeneration
				)
					throw new Error("章节注音暂不可用，请重试。");
				registerReaderFrameTargets(
					doc,
					applyAutomaticRuby(doc, projection, asset.tokens, part.start),
				);
				projection = projectPart(
					doc,
					Array.from(resource.text).slice(part.start, part.end).join(""),
					part.leaf_start,
				);
			}
			const resize = () => {
				if (context.active?.() === false || !valid()) return;
				const vertical =
					context.current().settings.writing_mode === "vertical-rl";
				const root = context.root();
				if (!root) return;
				const viewport = readingViewport(root, getComputedStyle(root));
				normalizeFrameImages(doc, viewport);
				if (vertical) {
					element.style.height = `${viewport.height}px`;
					doc.body.style.setProperty("height", "100%", "important");
					doc.body.style.setProperty("width", "max-content", "important");
					element.style.width = "1px";
					element.style.width = `${Math.max(100, doc.body.scrollWidth, doc.documentElement.scrollWidth)}px`;
				} else {
					element.style.width = "100%";
					doc.body.style.setProperty("height", "auto", "important");
					doc.body.style.setProperty("width", "auto", "important");
					element.style.height = "1px";
					element.style.height = `${Math.max(32, doc.body.scrollHeight, doc.documentElement.scrollHeight)}px`;
				}
			};
			this.frames.get(index)?.cleanup();
			this.frames.get(index)?.presentationCleanup();
			const presentationCleanup = applyFramePresentation(
				doc,
				context.current().theme,
				context.current().bookUi,
			);
			const unbind = context.bindFocus(doc, element);
			const keydown = (event: KeyboardEvent) => {
				if (context.active?.() !== false && valid()) context.key(event);
			};
			const copy = (event: ClipboardEvent) => {
				if (
					context.active?.() === false ||
					!valid() ||
					!isReaderFrameTarget(doc, event.target)
				)
					return;
				const frame = this.frames.get(index);
				if (frame) copyReaderSelection(doc, frame.projection, event);
			};
			const pointerdown = (event: PointerEvent) => {
				if (
					context.active?.() !== false &&
					valid() &&
					isReaderFrameTarget(doc, event.target)
				)
					context.interaction?.(event);
			};
			const selectionchange = (event: Event) => {
				if (context.active?.() === false || !valid()) return;
				const selection = doc.getSelection();
				if (!selection || selection.isCollapsed) return;
				this.finishInlineMotion();
				if (
					isReaderFrameTarget(doc, selection.anchorNode) &&
					isReaderFrameTarget(doc, selection.focusNode)
				)
					context.interaction?.(event);
			};
			const wheel = (event: WheelEvent) => {
				if (
					context.active?.() !== false &&
					valid() &&
					isReaderFrameTarget(doc, event.target)
				)
					context.wheel(event);
			};
			const touchmove = (event: TouchEvent) => {
				if (context.active?.() !== false && valid()) context.touch(event);
			};
			const click = (event: MouseEvent) => {
				if (context.active?.() === false || !valid()) return;
				const target = event.target as Element | null;
				const image = target?.closest("img[data-epub-image]");
				if (image && !event.defaultPrevented) {
					event.preventDefault();
					context.image(index, Number(image.getAttribute("data-epub-image")));
				}
			};
			doc.addEventListener("keydown", keydown);
			doc.addEventListener("pointerdown", pointerdown);
			doc.addEventListener("copy", copy);
			doc.addEventListener("selectionchange", selectionchange);
			doc.addEventListener("wheel", wheel, { passive: false });
			doc.addEventListener("touchmove", touchmove, { passive: true });
			doc.addEventListener("click", click);
			let studyCleanup = () => {};
			const resourceCleanups: (() => void)[] = [];
			const cleanup = () => {
				clearSearchHighlights(doc, true);
				studyCleanup();
				for (const settle of resourceCleanups) settle();
				unbind?.();
				doc.removeEventListener("keydown", keydown);
				doc.removeEventListener("pointerdown", pointerdown);
				doc.removeEventListener("copy", copy);
				doc.removeEventListener("selectionchange", selectionchange);
				doc.removeEventListener("wheel", wheel);
				doc.removeEventListener("touchmove", touchmove);
				doc.removeEventListener("click", click);
			};
			loaded = true;
			this.validity.set(index, valid);
			this.origins.set(index, data);
			this.frames.set(index, {
				element,
				doc,
				projection,
				imageOffsets: new Map(
					Array.from(
						doc.querySelectorAll<HTMLElement>("[data-epub-image]"),
						(image) => [
							Number(image.dataset.epubImage),
							imageTextOffset(image, projection),
						],
					),
				),
				contentEnd: null,
				resize,
				cleanup,
				presentationCleanup,
				rubyApplied: context.current().bookUi.rubyScope === "all",
			});
			resize();
			studyCleanup = this.study.mount({
				index,
				doc,
				element,
				chapter: data,
				valid: () => context.active?.() !== false && valid(),
				projection: () => this.freshProjection(index, data),
				viewport: context.root(),
			});
			void Promise.all([
				doc.fonts.ready,
				...Array.from(doc.images).map((image) =>
					image.complete
						? Promise.resolve()
						: new Promise<void>((resolve) => {
								const settle = () => {
									image.removeEventListener("load", settle);
									image.removeEventListener("error", settle);
									resolve();
								};
								image.addEventListener("load", settle, { once: true });
								image.addEventListener("error", settle, { once: true });
								resourceCleanups.push(settle);
							}),
				),
			]).then(() => {
				if (!valid()) return;
				context.ready(token, index);
			});
		} catch (failure) {
			context.error(
				failure instanceof Error ? failure : new Error(String(failure)),
			);
		}
	}
}
