import type { Chapter } from "./api.ts";
import type { Projection } from "./dom.ts";
import { FOCUS_TIMING, isReaderFrameTarget } from "./focus.ts";
import {
	clearStudyHighlights,
	prepareStudyUnderlines,
	projectedBaseRanges,
} from "./highlight.ts";
import { captureNativeSelection, referenceParts } from "./reader-selection.ts";
import type { MaterialProvenance, StudyTarget } from "./study-api.ts";

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
export type StudyMarkHit = { segmentIds: string[]; anchor: ScreenAnchor };
export type StudyBinding = {
	materialId: string;
	versionId: string;
	chapterId: string;
	onSelection: (value: StudySelection | null) => void;
	onMarks: (value: StudyMarkHit | null) => void;
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
type LocalMark = { id: string; intervals: { start: number; end: number }[] };
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
		theme: "white" | "black";
	} | null = null;
	private readonly local = new Map<number, LocalMark[]>();
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
			this.local.clear();
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
		this.local.clear();
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
	geometryChanged(): void {
		this.emphasized = null;
		for (const frame of this.frames.values()) frame.cancel();
		this.binding?.onSelection(null);
		this.binding?.onMarks(null);
		this.refresh();
	}
	setMarks(
		chapter: Chapter,
		marks: readonly StudyMark[],
		visible: boolean,
		theme: "white" | "black",
	): void {
		this.config = { chapter, marks, visible, theme };
		if (!visible) {
			this.emphasized = null;
			this.binding?.onMarks(null);
		}
		this.refresh();
	}
	emphasize(id: string | null): void {
		if (this.emphasized === id) return;
		this.emphasized = id;
		this.refresh();
	}
	refresh(): void {
		this.local.clear();
		const config = this.config;
		const activeFrames = [...this.frames.values()].filter(
			(frame) =>
				this.current(frame) &&
				frame.chapter.id === config?.chapter.id &&
				frame.chapter.material_id === config?.chapter.material_id &&
				frame.chapter.version_id === config?.chapter.version_id,
		);
		if (!config?.visible) {
			for (const frame of this.frames.values()) clearStudyHighlights(frame.doc);
			return;
		}
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
				const planned: [number, Range[], { start: number; end: number }[]][] =
					[];
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
					planned.push([index, projected, intervals]);
				}
				for (const [index, projected, intervals] of planned) {
					ranges.set(index, [...(ranges.get(index) ?? []), ...projected]);
					if (mark.segment_id === this.emphasized)
						emphasis.set(index, [...(emphasis.get(index) ?? []), ...projected]);
					const local = this.local.get(index) ?? [];
					local.push({ id: mark.segment_id, intervals });
					this.local.set(index, local);
				}
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
					ranges.get(frame.index) ?? [],
					emphasis.get(frame.index) ?? [],
					config.theme,
				)();
			} catch {
				clearStudyHighlights(frame.doc);
				this.local.delete(frame.index);
			}
		}
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
	private hit(frame: StudyFrame, x: number, y: number): StudyMarkHit | null {
		if (!this.config?.visible || !this.current(frame) || selected(frame.doc))
			return null;
		this.refresh();
		const local = this.local.get(frame.index);
		if (!local?.length) return null;
		const doc = frame.doc as Document & {
			caretPositionFromPoint?: (
				x: number,
				y: number,
			) => { offsetNode: Node; offset: number } | null;
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
		};
		const caret = doc.caretPositionFromPoint?.(x, y);
		const range = caret ? null : doc.caretRangeFromPoint?.(x, y);
		const node = caret?.offsetNode ?? range?.startContainer,
			offset = caret?.offset ?? range?.startOffset;
		if (!node || offset === undefined || node.parentElement?.closest("rt,rp"))
			return null;
		const projection = frame.projection(),
			entry = projection.entries.find((item) => item.node === node);
		if (!entry || offset < 0 || offset > entry.node.length) return null;
		const boundary = Array.from(
			projection.raw.slice(0, entry.start + offset).normalize("NFC"),
		).length;
		const length = Array.from(projection.raw.normalize("NFC")).length;
		const points = [boundary, boundary - 1].filter(
			(point) => point >= 0 && point < length,
		);
		const hits = new Set<string>();
		let anchor: ScreenAnchor | null = null;
		for (const point of points) {
			const covering = local.filter((mark) =>
				mark.intervals.some((item) => item.start <= point && point < item.end),
			);
			if (!covering.length) continue;
			let rect: DOMRect | undefined;
			try {
				rect = projectedBaseRanges(doc, projection, point, point + 1)
					.flatMap((item) => Array.from(item.getClientRects()))
					.find(
						(item) =>
							item.width > 0 &&
							item.height > 0 &&
							x >= item.left &&
							x < item.right &&
							y >= item.top &&
							y < item.bottom,
					);
			} catch {
				continue;
			}
			if (!rect) continue;
			anchor ??= rect;
			for (const mark of covering) hits.add(mark.id);
		}
		return hits.size && anchor
			? { segmentIds: [...hits], anchor: screenAnchor(frame.element, anchor) }
			: null;
	}
	mount(input: StudyFrame): () => void {
		this.frames.get(input.index)?.dispose();
		let selectionTimer: ReturnType<typeof setTimeout> | null = null,
			clickTimer: ReturnType<typeof setTimeout> | null = null;
		let pointer: {
			id: number;
			x: number;
			y: number;
			at: number;
			moved: boolean;
			hadSelection: boolean;
		} | null = null;
		let clickAllowed = false,
			keyActive = false;
		const cancelSelection = () => {
			if (selectionTimer !== null) clearTimeout(selectionTimer);
			selectionTimer = null;
		};
		const cancelClick = () => {
			if (clickTimer !== null) clearTimeout(clickTimer);
			clickTimer = null;
			clickAllowed = false;
		};
		const cancel = () => {
			cancelSelection();
			cancelClick();
			pointer = null;
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
					this.local.delete(input.index);
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
			cancelClick();
			pointer = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				at: event.timeStamp,
				moved: false,
				hadSelection: selected(input.doc),
			};
			this.binding?.onSelection(null);
			this.dismissMarks();
		};
		const move = (raw: Event) => {
			const event = raw as PointerEvent;
			if (
				pointer &&
				pointer.id === event.pointerId &&
				Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >=
					FOCUS_TIMING.drag
			)
				pointer.moved = true;
		};
		const up = (raw: Event) => {
			if (
				!this.current(frame) ||
				!originalTarget(raw) ||
				!isReaderFrameTarget(input.doc, raw.target)
			) {
				pointer = null;
				return;
			}
			const event = raw as PointerEvent,
				candidate = pointer;
			pointer = null;
			clickAllowed =
				!!candidate &&
				candidate.id === event.pointerId &&
				!candidate.moved &&
				!candidate.hadSelection &&
				event.timeStamp - candidate.at < FOCUS_TIMING.longPress &&
				Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) <
					FOCUS_TIMING.drag;
			schedule();
		};
		const click = (raw: Event) => {
			const event = raw as MouseEvent,
				allowed = clickAllowed;
			cancelClick();
			if (
				!allowed ||
				event.detail !== 1 ||
				!this.current(frame) ||
				!originalTarget(event) ||
				!isReaderFrameTarget(input.doc, event.target) ||
				selected(input.doc) ||
				event.defaultPrevented
			)
				return;
			clickTimer = setTimeout(() => {
				clickTimer = null;
				if (this.current(frame) && !selected(input.doc))
					this.binding?.onMarks(this.hit(frame, event.clientX, event.clientY));
			}, FOCUS_TIMING.clickDelay);
		};
		const selectionChanged = () => {
			if (!this.current(frame)) return;
			if (selected(input.doc)) {
				cancelClick();
				this.dismissMarks();
			}
			schedule();
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
				cancelClick();
				this.dismissMarks();
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
		};
		const listeners: [string, EventListener][] = [
			["pointerdown", down],
			["pointermove", move],
			["pointerup", up],
			["pointercancel", cancel],
			["click", click],
			["dblclick", cancelClick],
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
