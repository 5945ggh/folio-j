import type { Chapter } from "./api.ts";
import { type Projection, visibleContentRect } from "./dom.ts";
import {
	captureSelectionGuard,
	distance,
	FOCUS_TIMING,
	isReaderFrameTarget,
	ordinaryTap,
	type Point,
} from "./focus.ts";
import {
	clearStudyHighlights,
	prepareStudyUnderlines,
	projectedBaseRanges,
	uncoveredStudyRanges,
} from "./highlight.ts";
import { captureNativeSelection, referenceParts } from "./reader-selection.ts";
import type { MaterialProvenance, StudyTarget } from "./study-api.ts";
import { type StudyMarginEntry, studyMarginEntries } from "./study-margin.ts";
import { readingViewport } from "./viewport.ts";

export type ScreenAnchor = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};
export type StudySelection = { target: StudyTarget; anchor: ScreenAnchor };
export type StudyMarkKind = "segment" | "translation";
export type StudyMark = (
	| { segment_id: string }
	| { translation_id: string }
) & {
	material_provenance: MaterialProvenance;
};
export type StudyMarkHit = {
	segmentIds: string[];
	translationIds?: string[];
	anchor: ScreenAnchor;
	fixed?: boolean;
	anchorPlacement?: "text" | "margin-left" | "margin-right" | "margin-bottom";
};
export type StudyBinding = {
	materialId: string;
	versionId: string;
	chapterId: string;
	onSelection: (value: StudySelection | null) => void;
	onMarks: (value: StudyMarkHit | null) => void;
	onEntries?: (entries: StudyMarginEntry[]) => void;
	onBackgroundTap?: () => boolean;
};
type StudyFrame = {
	index: number;
	doc: Document;
	element: HTMLIFrameElement;
	chapter: Chapter;
	valid: () => boolean;
	projection: () => Projection;
	viewport?: HTMLElement | null;
};
type MountedFrame = StudyFrame & { dispose: () => void; cancel: () => void };
type MarkTarget = { id: string; kind: StudyMarkKind };
type MarkRanges = MarkTarget & { ranges: Range[] };
function markTarget(mark: StudyMark): MarkTarget {
	return "segment_id" in mark
		? { id: mark.segment_id, kind: "segment" }
		: { id: mark.translation_id, kind: "translation" };
}
const SELECTION_SETTLE_MS = 32;

function screenAnchor(
	element: HTMLIFrameElement,
	rect: ScreenAnchor,
): ScreenAnchor {
	const outer = element.getBoundingClientRect();
	const left = outer.left + (element.clientLeft || 0),
		top = outer.top + (element.clientTop || 0);
	return {
		left: left + rect.left,
		right: left + rect.right,
		top: top + rect.top,
		bottom: top + rect.bottom,
	};
}
function bounds(ranges: readonly Range[]): ScreenAnchor | null {
	let result: ScreenAnchor | null = null;
	for (const range of ranges)
		for (const rect of Array.from(range.getClientRects())) {
			if (rect.width <= 0 || rect.height <= 0) continue;
			result = result
				? {
						left: Math.min(result.left, rect.left),
						right: Math.max(result.right, rect.right),
						top: Math.min(result.top, rect.top),
						bottom: Math.max(result.bottom, rect.bottom),
					}
				: {
						left: rect.left,
						right: rect.right,
						top: rect.top,
						bottom: rect.bottom,
					};
		}
	return result;
}

/** Anchor to the clicked line/column while the full target remains highlighted. */
function visibleMarkAnchor(
	frame: StudyFrame,
	ranges: readonly Range[],
	hit: DOMRect,
	vertical: boolean,
): ScreenAnchor | null {
	const viewport = frame.viewport?.getBoundingClientRect();
	const view = frame.element.ownerDocument?.defaultView;
	let result: ScreenAnchor | null = null;
	for (const range of ranges) {
		for (const rect of Array.from(range.getClientRects())) {
			if (
				vertical
					? rect.left >= hit.right || rect.right <= hit.left
					: rect.top >= hit.bottom || rect.bottom <= hit.top
			)
				continue;
			const visible = visibleContentRect(
				frame.doc,
				rect,
				range.startContainer.parentElement,
			);
			if (!visible) continue;
			const screen = screenAnchor(frame.element, {
				left: Math.max(0, visible.left),
				right: Math.min(frame.element.clientWidth, visible.right),
				top: Math.max(0, visible.top),
				bottom: Math.min(frame.element.clientHeight, visible.bottom),
			});
			const clipped = {
				left: Math.max(0, screen.left, viewport?.left ?? 0),
				right: Math.min(
					screen.right,
					viewport?.right ?? Infinity,
					view?.innerWidth ?? Infinity,
				),
				top: Math.max(0, screen.top, viewport?.top ?? 0),
				bottom: Math.min(
					screen.bottom,
					viewport?.bottom ?? Infinity,
					view?.innerHeight ?? Infinity,
				),
			};
			if (clipped.left >= clipped.right || clipped.top >= clipped.bottom)
				continue;
			result = result
				? {
						left: Math.min(result.left, clipped.left),
						right: Math.max(result.right, clipped.right),
						top: Math.min(result.top, clipped.top),
						bottom: Math.max(result.bottom, clipped.bottom),
					}
				: clipped;
		}
	}
	return result;
}

function originalTarget(event: Event): boolean {
	const node = event.target as Node | null;
	const element =
		node?.nodeType === 1 ? (node as Element) : node?.parentElement;
	return !element?.closest?.(
		"rt,rp,button,a,input,textarea,select,summary,img,[contenteditable],[role=button],[role=dialog],[data-reader-control]",
	);
}
function modified(event: PointerEvent): boolean {
	return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}
function point(event: PointerEvent): Point {
	return { x: event.clientX, y: event.clientY };
}
function selected(doc: Document): boolean {
	const selection = doc.getSelection();
	return !!selection && !selection.isCollapsed;
}
function selectionKey(event: KeyboardEvent): boolean {
	return (
		(event.shiftKey && /^(Arrow|Home$|End$|Page)/.test(event.key)) ||
		event.key === "Shift" ||
		((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
	);
}

/** Frame adapter for native selection and persisted marks; callers only see values and screen rectangles. */
export class ReaderStudy {
	private binding: StudyBinding | null = null;
	private readonly frames = new Map<number, MountedFrame>();
	private config: {
		chapter: Chapter;
		marks: readonly StudyMark[];
		visible: boolean;
		margins: boolean;
		theme: "white" | "black";
	} | null = null;
	private emphasized: MarkTarget | null = null;
	private readonly hits = new Map<number, MarkRanges[]>();
	private preservingPreview = false;
	private readonly layoutScroll = new Map<
		HTMLElement,
		{ left: number; top: number }
	>();
	private readonly restoredScrollEvents = new WeakSet<Event>();
	/** Inline output changes geometry without dismissing a record the user just opened. */
	preservePreviewDuringLayout(update: () => void): void {
		const previous = this.preservingPreview;
		this.preservingPreview = true;
		try {
			update();
		} finally {
			this.preservingPreview = previous;
			for (const frame of this.frames.values()) {
				const viewport = frame.viewport;
				if (viewport && this.current(frame))
					this.layoutScroll.set(viewport, {
						left: viewport.scrollLeft,
						top: viewport.scrollTop,
					});
			}
		}
	}
	bind(binding: StudyBinding | null): void {
		const changed =
			binding?.materialId !== this.binding?.materialId ||
			binding?.versionId !== this.binding?.versionId ||
			binding?.chapterId !== this.binding?.chapterId;
		this.binding = binding;
		if (changed) {
			this.layoutScroll.clear();
			this.hits.clear();
			this.emphasized = null;
			for (const frame of this.frames.values()) {
				frame.cancel();
				clearStudyHighlights(frame.doc);
			}
			binding?.onEntries?.([]);
			binding?.onSelection(null);
			binding?.onMarks(null);
		}
	}
	private sameBinding(frame: StudyFrame): boolean {
		const binding = this.binding;
		return (
			!!binding &&
			frame.chapter.id === binding.chapterId &&
			frame.chapter.material_id === binding.materialId &&
			frame.chapter.version_id === binding.versionId
		);
	}
	private active(frame: StudyFrame): boolean {
		return frame.valid() && this.sameBinding(frame);
	}
	private current(frame: StudyFrame): boolean {
		return this.frames.get(frame.index) === frame && this.active(frame);
	}
	private hasSelection(): boolean {
		return [...this.frames.values()].some(
			(frame) => this.current(frame) && selected(frame.doc),
		);
	}
	private dismissMarks(): void {
		if (this.emphasized !== null) {
			this.emphasized = null;
			this.refresh();
		}
		this.binding?.onMarks(null);
	}
	clear(): void {
		this.layoutScroll.clear();
		this.hits.clear();
		this.emphasized = null;
		for (const frame of this.frames.values()) frame.dispose();
		this.frames.clear();
		this.binding?.onEntries?.([]);
		this.binding?.onSelection(null);
		this.binding?.onMarks(null);
	}
	clearSelection(): boolean {
		const hadSelection = this.hasSelection();
		for (const frame of this.frames.values()) {
			frame.cancel();
			if (this.current(frame)) frame.doc.getSelection()?.removeAllRanges();
		}
		this.binding?.onSelection(null);
		return hadSelection;
	}
	geometryChanged(refresh = true): void {
		this.hits.clear();
		if (!this.preservingPreview) this.emphasized = null;
		for (const frame of this.frames.values()) frame.cancel();
		this.binding?.onSelection(null);
		if (!this.preservingPreview) this.binding?.onMarks(null);
		this.binding?.onEntries?.([]);
		for (const frame of this.frames.values()) clearStudyHighlights(frame.doc);
		if (refresh) this.refresh();
	}
	setMarks(
		chapter: Chapter,
		marks: readonly StudyMark[],
		visible: boolean,
		theme: "white" | "black",
		margins = false,
	): void {
		this.config = { chapter, marks, visible, theme, margins };
		if (!marks.some((mark) => this.isEmphasized(markTarget(mark))))
			this.emphasized = null;
		this.refresh();
	}
	private isEmphasized(target: MarkTarget): boolean {
		return (
			this.emphasized?.id === target.id && this.emphasized.kind === target.kind
		);
	}
	emphasize(id: string | null, kind: StudyMarkKind = "segment"): void {
		if (
			id === null ? this.emphasized === null : this.isEmphasized({ id, kind })
		)
			return;
		this.emphasized = id === null ? null : { id, kind };
		this.refresh();
	}
	refresh(): void {
		this.hits.clear();
		const config = this.config;
		const activeFrames = [...this.frames.values()].filter(
			(frame) =>
				this.current(frame) &&
				frame.chapter.id === config?.chapter.id &&
				frame.chapter.material_id === config?.chapter.material_id &&
				frame.chapter.version_id === config?.chapter.version_id,
		);
		if (!config) {
			for (const frame of this.frames.values()) clearStudyHighlights(frame.doc);
			return;
		}
		const geometry: (MarkTarget & { rects: ScreenAnchor[] })[] = [];
		const hitRanges = new Map<number, MarkRanges[]>();
		const ranges = new Map<number, Range[]>(),
			emphasis = new Map<number, Range[]>();
		const translationRanges = new Map<number, Range[]>(),
			translationEmphasis = new Map<number, Range[]>();
		const projections = new Map<number, Projection>();
		for (const mark of config.marks) {
			const target = markTarget(mark);
			const emphasized = this.isEmphasized(target);
			if (
				mark.material_provenance.material_id !== config.chapter.material_id ||
				mark.material_provenance.version_id !== config.chapter.version_id
			)
				continue;
			try {
				const parts = referenceParts(
					config.chapter,
					mark.material_provenance.ranges,
				);
				const planned: [number, Range[]][] = [];
				for (const [index, intervals] of parts) {
					const frame = this.frames.get(index);
					if (!frame || !activeFrames.includes(frame))
						throw new Error("标记正文尚未完整显示");
					let projection = projections.get(index);
					if (!projection) {
						projection = frame.projection();
						projections.set(index, projection);
					}
					const projected = intervals.flatMap(({ start, end }) =>
						projectedBaseRanges(frame.doc, projection, start, end),
					);
					prepareStudyUnderlines(frame.doc, projected, [], config.theme);
					planned.push([index, projected]);
				}
				for (const [index, projected] of planned) {
					if (config.visible || emphasized)
						hitRanges.set(index, [
							...(hitRanges.get(index) ?? []),
							{ ...target, ranges: projected },
						]);
					const paint = target.kind === "segment" ? ranges : translationRanges;
					const active =
						target.kind === "segment" ? emphasis : translationEmphasis;
					paint.set(index, [...(paint.get(index) ?? []), ...projected]);
					if (emphasized)
						active.set(index, [...(active.get(index) ?? []), ...projected]);
				}
				geometry.push({
					...target,
					rects: planned.flatMap(([index, projected]) => {
						const frame = this.frames.get(index);
						if (!frame) return [];
						return projected.flatMap((range) =>
							Array.from(range.getClientRects()).flatMap((rect) => {
								const visible = visibleContentRect(
									frame.doc,
									rect,
									range.startContainer.parentElement,
								);
								if (!visible) return [];
								const clipped = {
									left: Math.max(0, visible.left),
									right: Math.min(frame.element.clientWidth, visible.right),
									top: Math.max(0, visible.top),
									bottom: Math.min(frame.element.clientHeight, visible.bottom),
								};
								return clipped.left < clipped.right &&
									clipped.top < clipped.bottom
									? [screenAnchor(frame.element, clipped)]
									: [];
							}),
						);
					}),
				});
			} catch {
				/* A partially available mark is never painted or made clickable. */
			}
		}
		for (const frame of this.frames.values()) {
			if (!activeFrames.includes(frame)) {
				clearStudyHighlights(frame.doc);
				continue;
			}
			try {
				const solid = config.visible ? (ranges.get(frame.index) ?? []) : [];
				const activeSolid = emphasis.get(frame.index) ?? [];
				const covered = [...solid, ...activeSolid];
				prepareStudyUnderlines(
					frame.doc,
					solid,
					activeSolid,
					config.theme,
					uncoveredStudyRanges(
						frame.doc,
						config.visible ? (translationRanges.get(frame.index) ?? []) : [],
						covered,
					),
					uncoveredStudyRanges(
						frame.doc,
						translationEmphasis.get(frame.index) ?? [],
						covered,
					),
				)();
				this.hits.set(frame.index, hitRanges.get(frame.index) ?? []);
			} catch {
				clearStudyHighlights(frame.doc);
			}
		}
		const viewport = activeFrames[0]?.viewport;
		const view = viewport?.ownerDocument?.defaultView;
		if (config.margins && viewport && view) {
			const outer = viewport.getBoundingClientRect();
			const content = activeFrames.reduce<ScreenAnchor>((bounds, frame) => {
				const rect = frame.element.getBoundingClientRect();
				return {
					left: Math.min(bounds.left, rect.left),
					right: Math.max(bounds.right, rect.right),
					top: Math.min(bounds.top, rect.top),
					bottom: Math.max(bounds.bottom, rect.bottom),
				};
			}, outer);
			const dx = viewport.scrollLeft - outer.left - viewport.clientLeft;
			const dy = viewport.scrollTop - outer.top - viewport.clientTop;
			const local = (rect: ScreenAnchor): ScreenAnchor => ({
				left: rect.left + dx,
				right: rect.right + dx,
				top: rect.top + dy,
				bottom: rect.bottom + dy,
			});
			this.binding?.onEntries?.(
				studyMarginEntries(
					geometry,
					readingViewport(viewport, view.getComputedStyle(viewport)),
					{ width: view.innerWidth, height: view.innerHeight },
					viewport.classList.contains("material-vertical"),
					content,
				).map((entry) => ({
					...entry,
					anchor: local(entry.anchor),
					left: entry.left + dx,
					top: entry.top + dy,
				})),
			);
		} else this.binding?.onEntries?.([]);
	}
	/** A caret is only a candidate: require the pointer to be inside a real base-character rect. */
	private markAt(frame: StudyFrame, event: PointerEvent): StudyMarkHit | null {
		const marks = this.hits.get(frame.index);
		if (!marks?.length) return null;
		const doc = frame.doc as Document & {
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
		};
		const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
		const fallback = !caret
			? doc.caretRangeFromPoint?.(event.clientX, event.clientY)
			: null;
		const node = caret?.offsetNode ?? fallback?.startContainer;
		const offset = caret?.offset ?? fallback?.startOffset;
		if (
			!node ||
			offset === undefined ||
			!isReaderFrameTarget(doc, node) ||
			(node.parentElement?.closest("rt,rp") ?? false) ||
			!frame.projection().entries.some((entry) => entry.node === node)
		)
			return null;
		const text = node as Text;
		let start = 0;
		for (const character of text.data) {
			const end = start + character.length;
			if (start <= offset && end >= offset && !/\s/u.test(character)) {
				const ids = marks.filter((mark) =>
					mark.ranges.some(
						(range) =>
							range.startContainer === node &&
							range.endContainer === node &&
							range.startOffset <= start &&
							range.endOffset >= end,
					),
				);
				if (ids.length) {
					const range = doc.createRange();
					range.setStart(node, start);
					range.setEnd(node, end);
					for (const rect of Array.from(range.getClientRects())) {
						const visible = visibleContentRect(doc, rect, node.parentElement);
						if (
							visible &&
							event.clientX >= Math.max(0, visible.left) &&
							event.clientX <
								Math.min(frame.element.clientWidth, visible.right) &&
							event.clientY >= Math.max(0, visible.top) &&
							event.clientY <
								Math.min(frame.element.clientHeight, visible.bottom)
						) {
							const anchor = visibleMarkAnchor(
								frame,
								ids.flatMap((mark) => mark.ranges),
								rect,
								doc.defaultView
									?.getComputedStyle?.(node.parentElement ?? doc.body)
									.writingMode?.startsWith("vertical") ?? false,
							);
							return anchor
								? {
										segmentIds: [
											...new Set(
												ids
													.filter((mark) => mark.kind === "segment")
													.map((mark) => mark.id),
											),
										],
										...(ids.some((mark) => mark.kind === "translation")
											? {
													translationIds: [
														...new Set(
															ids
																.filter((mark) => mark.kind === "translation")
																.map((mark) => mark.id),
														),
													],
												}
											: {}),
										anchor,
									}
								: null;
						}
					}
				}
			}
			start = end;
			if (start > offset) break;
		}
		return null;
	}
	private capture(frame: StudyFrame): StudySelection | null {
		const binding = this.binding;
		if (
			!binding ||
			!this.current(frame) ||
			[...this.frames.values()].filter(
				(item) => this.current(item) && selected(item.doc),
			).length !== 1
		)
			return null;
		const part = frame.chapter.parts[frame.index],
			resource = frame.chapter.resources.find(
				(item) => item.id === part?.resource_id,
			);
		if (!part || !resource) return null;
		const projection = frame.projection();
		const reference = captureNativeSelection(
			frame.doc,
			projection,
			part,
			resource,
			binding.materialId,
			binding.versionId,
		);
		const range = reference.ranges[0];
		if (!range) return null;
		const rect = bounds(
			projectedBaseRanges(
				frame.doc,
				projection,
				range.start - part.start,
				range.end - part.start,
			),
		);
		return rect
			? {
					target: { reference, chapter: structuredClone(frame.chapter) },
					anchor: screenAnchor(frame.element, rect),
				}
			: null;
	}
	mount(input: StudyFrame): () => void {
		this.frames.get(input.index)?.dispose();
		let selectionTimer: ReturnType<typeof setTimeout> | null = null;
		let disposed = false;
		let pointer = false,
			keyActive = false;
		let tap: {
			point: Point;
			time: number;
			id: number;
			moved: boolean;
			selection: ReturnType<typeof captureSelectionGuard>;
		} | null = null;
		const cancelSelection = () => {
			if (selectionTimer !== null) clearTimeout(selectionTimer);
			selectionTimer = null;
		};
		const cancel = () => {
			cancelSelection();
			pointer = false;
			tap = null;
			keyActive = false;
		};
		const frame: MountedFrame = {
			...input,
			cancel,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				cancel();
				for (const [type, listener] of listeners)
					input.doc.removeEventListener(type, listener);
				input.viewport?.removeEventListener("scroll", scroll);
				this.hits.delete(input.index);
				clearStudyHighlights(input.doc, true);
				if (this.frames.get(input.index) === frame) {
					this.frames.delete(input.index);
					if (this.sameBinding(frame)) {
						this.binding?.onSelection(null);
						this.dismissMarks();
					}
					this.refresh();
				}
			},
		};
		const notify = () => {
			selectionTimer = null;
			if (!this.current(frame) || pointer || keyActive) return;
			let value: StudySelection | null = null;
			try {
				value = this.capture(frame);
			} catch {
				/* Invalid native endpoints keep the toolbar closed. */
			}
			this.binding?.onSelection(value);
		};
		const schedule = () => {
			cancelSelection();
			if (!pointer && !keyActive)
				selectionTimer = setTimeout(notify, SELECTION_SETTLE_MS);
		};
		const down = (raw: Event) => {
			const event = raw as PointerEvent;
			tap = null;
			if (
				!this.current(frame) ||
				!originalTarget(event) ||
				!isReaderFrameTarget(input.doc, event.target) ||
				event.defaultPrevented ||
				event.button !== 0 ||
				event.isPrimary === false
			)
				return;
			cancelSelection();
			pointer = true;
			if (!modified(event))
				tap = {
					point: point(event),
					time: event.timeStamp,
					id: event.pointerId,
					moved: false,
					selection: captureSelectionGuard(
						[...this.frames.values()]
							.filter((item) => this.current(item))
							.map((item) => item.doc),
					),
				};
			this.binding?.onSelection(null);
		};
		const move = (raw: Event) => {
			if (
				tap &&
				distance(tap.point, point(raw as PointerEvent)) >= FOCUS_TIMING.drag
			)
				tap.moved = true;
		};
		const up = (raw: Event) => {
			const event = raw as PointerEvent;
			const candidate = tap;
			tap = null;
			pointer = false;
			if (!this.current(frame)) return;
			schedule();
			if (
				!candidate ||
				candidate.moved ||
				candidate.id !== event.pointerId ||
				event.defaultPrevented ||
				event.button !== 0 ||
				event.isPrimary === false ||
				modified(event) ||
				candidate.selection.hasNewSelection() ||
				keyActive ||
				!originalTarget(event) ||
				!isReaderFrameTarget(input.doc, event.target) ||
				!ordinaryTap(
					candidate.point,
					point(event),
					event.timeStamp - candidate.time,
				)
			)
				return;
			if (candidate.selection.hadSelection) {
				this.clearSelection();
				this.binding?.onBackgroundTap?.();
				event.preventDefault();
				return;
			}
			let hit: StudyMarkHit | null = null;
			try {
				hit = this.markAt(frame, event);
			} catch {
				/* Stale projection is never guessed. */
			}
			if (hit) {
				event.preventDefault();
				this.binding?.onMarks(hit);
			} else if (this.binding?.onBackgroundTap?.()) event.preventDefault();
		};
		const selectionChanged = () => {
			if (tap?.selection.hasNewSelection()) tap = null;
			if (this.current(frame)) schedule();
		};
		const keydown = (raw: Event) => {
			if (
				!this.current(frame) ||
				!originalTarget(raw) ||
				!isReaderFrameTarget(input.doc, raw.target)
			)
				return;
			const event = raw as KeyboardEvent;
			if (selectionKey(event)) {
				keyActive = true;
				cancelSelection();
			}
		};
		const keyup = (raw: Event) => {
			if (!this.current(frame)) return;
			const event = raw as KeyboardEvent;
			if (selectionKey(event) || keyActive) {
				keyActive = false;
				schedule();
			}
		};
		const scroll = (event: Event) => {
			if (!this.current(frame)) return;
			if (this.restoredScrollEvents.has(event)) return;
			const viewport = input.viewport;
			const expected = viewport ? this.layoutScroll.get(viewport) : undefined;
			// Restoration can emit a scroll event even when its final pixel offset is
			// unchanged. Native wheel/touch input and a different offset still dismiss.
			if (
				event.type === "scroll" &&
				viewport &&
				expected &&
				viewport.scrollLeft === expected.left &&
				viewport.scrollTop === expected.top
			) {
				this.layoutScroll.delete(viewport);
				// Every mounted frame listens to the same viewport event.
				this.restoredScrollEvents.add(event);
				return;
			}
			if (viewport) this.layoutScroll.delete(viewport);
			cancel();
			this.binding?.onSelection(null);
			this.dismissMarks();
		};
		const listeners: [string, EventListener][] = [
			["pointerdown", down],
			["pointerup", up],
			["pointermove", move],
			["pointercancel", cancel],
			["selectionchange", selectionChanged],
			["keydown", keydown],
			["keyup", keyup],
			["wheel", scroll],
			["touchmove", scroll],
		];
		this.frames.set(input.index, frame);
		for (const [type, listener] of listeners)
			input.doc.addEventListener(type, listener, {
				passive: type !== "pointerup",
			});
		input.viewport?.addEventListener("scroll", scroll, { passive: true });
		this.refresh();
		return frame.dispose;
	}
}
