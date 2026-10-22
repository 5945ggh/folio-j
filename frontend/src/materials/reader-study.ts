import type { Chapter } from "./api.ts";
import { type Projection, visibleContentRect } from "./dom.ts";
import { isReaderFrameTarget } from "./focus.ts";
import {
	clearStudyHighlights,
	prepareStudyUnderlines,
	projectedBaseRanges,
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
export type StudyMark = {
	segment_id: string;
	material_provenance: MaterialProvenance;
};
export type StudyMarkHit = {
	segmentIds: string[];
	anchor: ScreenAnchor;
	fixed?: boolean;
};
export type StudyBinding = {
	materialId: string;
	versionId: string;
	chapterId: string;
	onSelection: (value: StudySelection | null) => void;
	onMarks: (value: StudyMarkHit | null) => void;
	onEntries?: (entries: StudyMarginEntry[]) => void;
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

function originalTarget(event: Event): boolean {
	const node = event.target as Node | null;
	const element =
		node?.nodeType === 1 ? (node as Element) : node?.parentElement;
	return !element?.closest?.(
		"rt,rp,button,a,input,textarea,select,[contenteditable],[role=dialog],[data-reader-control]",
	);
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
	private emphasized: string | null = null;
	bind(binding: StudyBinding | null): void {
		const changed =
			binding?.materialId !== this.binding?.materialId ||
			binding?.versionId !== this.binding?.versionId ||
			binding?.chapterId !== this.binding?.chapterId;
		this.binding = binding;
		if (changed) {
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
	private dismissMarks(): void {
		if (this.emphasized !== null) {
			this.emphasized = null;
			this.refresh();
		}
		this.binding?.onMarks(null);
	}
	clear(): void {
		this.emphasized = null;
		for (const frame of this.frames.values()) frame.dispose();
		this.frames.clear();
		this.binding?.onEntries?.([]);
		this.binding?.onSelection(null);
		this.binding?.onMarks(null);
	}
	clearSelection(): void {
		for (const frame of this.frames.values()) {
			frame.cancel();
			if (this.current(frame)) frame.doc.getSelection()?.removeAllRanges();
		}
		this.binding?.onSelection(null);
	}
	geometryChanged(refresh = true): void {
		this.emphasized = null;
		for (const frame of this.frames.values()) frame.cancel();
		this.binding?.onSelection(null);
		this.binding?.onMarks(null);
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
		if (!marks.some((mark) => mark.segment_id === this.emphasized))
			this.emphasized = null;
		this.refresh();
	}
	emphasize(id: string | null): void {
		if (this.emphasized === id) return;
		this.emphasized = id;
		this.refresh();
	}
	refresh(): void {
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
		const geometry: { id: string; rects: ScreenAnchor[] }[] = [];
		const ranges = new Map<number, Range[]>(),
			emphasis = new Map<number, Range[]>();
		const projections = new Map<number, Projection>();
		for (const mark of config.marks) {
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
					ranges.set(index, [...(ranges.get(index) ?? []), ...projected]);
					if (mark.segment_id === this.emphasized)
						emphasis.set(index, [...(emphasis.get(index) ?? []), ...projected]);
				}
				geometry.push({
					id: mark.segment_id,
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
				prepareStudyUnderlines(
					frame.doc,
					config.visible ? (ranges.get(frame.index) ?? []) : [],
					emphasis.get(frame.index) ?? [],
					config.theme,
				)();
			} catch {
				clearStudyHighlights(frame.doc);
			}
		}
		const viewport = activeFrames[0]?.viewport;
		const view = viewport?.ownerDocument?.defaultView;
		if (config.margins && viewport && view) {
			const reserved = Array.from(
				viewport.ownerDocument.querySelectorAll(
					".reader-top,.reader-bottom,[data-reader-panel-side],.reader-study-notice",
				),
				(node) => node.getBoundingClientRect(),
			);
			this.binding?.onEntries?.(
				studyMarginEntries(
					geometry,
					readingViewport(viewport, view.getComputedStyle(viewport)),
					{ width: view.innerWidth, height: view.innerHeight },
					viewport.classList.contains("material-vertical"),
					reserved,
				),
			);
		} else this.binding?.onEntries?.([]);
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
		let pointer = false,
			keyActive = false;
		const cancelSelection = () => {
			if (selectionTimer !== null) clearTimeout(selectionTimer);
			selectionTimer = null;
		};
		const cancel = () => {
			cancelSelection();
			pointer = false;
			keyActive = false;
		};
		const frame: MountedFrame = {
			...input,
			cancel,
			dispose: () => {
				cancel();
				for (const [type, listener] of listeners)
					input.doc.removeEventListener(type, listener);
				input.viewport?.removeEventListener("scroll", scroll);
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
			this.binding?.onSelection(null);
		};
		const up = () => {
			pointer = false;
			if (this.current(frame)) schedule();
		};
		const selectionChanged = () => {
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
		const scroll = () => {
			if (!this.current(frame)) return;
			cancel();
			this.binding?.onSelection(null);
			this.dismissMarks();
			this.refresh();
		};
		const listeners: [string, EventListener][] = [
			["pointerdown", down],
			["pointerup", up],
			["pointercancel", cancel],
			["selectionchange", selectionChanged],
			["keydown", keydown],
			["keyup", keyup],
			["wheel", scroll],
			["touchmove", scroll],
		];
		this.frames.set(input.index, frame);
		for (const [type, listener] of listeners)
			input.doc.addEventListener(type, listener, { passive: true });
		input.viewport?.addEventListener("scroll", scroll, { passive: true });
		this.refresh();
		return frame.dispose;
	}
}
