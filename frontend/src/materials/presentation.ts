import {
	isReaderFrameTarget,
	ordinaryTap,
	type Point,
	snapshotReaderFrameTargets,
} from "./focus.ts";
import type { BookUiPreferences } from "./preferences";
export const READER_FONT_FAMILIES = {
	mincho: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif',
	gothic:
		'"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans CJK JP", sans-serif',
};
/** Presentation only: preserve all original text/image leaves and ruby geometry. */
export function applyFramePresentation(
	doc: Document,
	theme: "white" | "black",
	preferences: BookUiPreferences,
): () => void {
	snapshotReaderFrameTargets(doc);
	let style = doc.getElementById(
		"folio-reader-presentation",
	) as HTMLStyleElement | null;
	if (!style) {
		style = doc.createElement("style");
		style.id = "folio-reader-presentation";
		doc.head.append(style);
	}
	doc.documentElement.dataset.readerRuby = preferences.ruby;
	doc.documentElement.dataset.readerRubyScope =
		preferences.rubyScope ?? "original";
	style.textContent = `html,body { background: ${theme === "black" ? "#191919" : "#fff"} !important; color: ${theme === "black" ? "#e5e5e5" : "#282828"} !important; } body { font-family: ${READER_FONT_FAMILIES[preferences.font]} !important; } body :not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; font-family: inherit !important; } rt { opacity: ${preferences.ruby === "hide" || preferences.ruby === "on-demand" ? 0 : 1} !important; } @media (hover:hover) { html[data-reader-ruby="on-demand"] ruby:hover rt { opacity: 1 !important; } } html[data-reader-ruby="on-demand"][data-reader-ruby-keyboard] rt, html[data-reader-ruby="on-demand"] ruby[data-reader-ruby-selected] rt, html[data-reader-ruby="on-demand"] ruby[data-reader-ruby-open] rt { opacity: 1 !important; }`;
	let tap: { point: Point; time: number; id: number } | null = null;
	const selected = () => {
		const selection = doc.getSelection();
		return Boolean(selection && !selection.isCollapsed && selection.toString());
	};
	const down = (raw: Event) => {
		const e = raw as PointerEvent;
		tap =
			isReaderFrameTarget(doc, e.target) &&
			e.pointerType === "touch" &&
			e.isPrimary &&
			e.button === 0 &&
			!e.defaultPrevented &&
			!selected()
				? {
						point: { x: e.clientX, y: e.clientY },
						time: Date.now(),
						id: e.pointerId,
					}
				: null;
	};
	const cancel = () => {
		tap = null;
	};
	const reveal = (raw: Event) => {
		const e = raw as PointerEvent;
		const candidate = tap;
		tap = null;
		if (
			doc.documentElement.dataset.readerRuby !== "on-demand" ||
			!candidate ||
			!isReaderFrameTarget(doc, e.target) ||
			e.defaultPrevented ||
			selected() ||
			candidate.id !== e.pointerId ||
			!ordinaryTap(
				candidate.point,
				{ x: e.clientX, y: e.clientY },
				Date.now() - candidate.time,
			)
		)
			return;
		const target = e.target as Element | null;
		const ruby = target?.closest?.("ruby");
		for (const open of doc.querySelectorAll("ruby[data-reader-ruby-open]")) {
			if (open !== ruby) open.removeAttribute("data-reader-ruby-open");
		}
		if (ruby) ruby.toggleAttribute("data-reader-ruby-open");
	};
	const selectionChanged = () => {
		const selection = doc.getSelection();
		for (const ruby of doc.querySelectorAll("ruby"))
			if (isReaderFrameTarget(doc, ruby))
				ruby.toggleAttribute(
					"data-reader-ruby-selected",
					Boolean(
						selection &&
							!selection.isCollapsed &&
							selection.containsNode(ruby, true),
					),
				);
		if (selected()) tap = null;
	};
	const keyboard = (event: KeyboardEvent) => {
		if (
			event.key.toLowerCase() === "r" &&
			isReaderFrameTarget(doc, event.target) &&
			!event.defaultPrevented &&
			!event.repeat &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!event.isComposing &&
			doc.documentElement.dataset.readerRuby === "on-demand"
		)
			doc.documentElement.toggleAttribute("data-reader-ruby-keyboard");
	};
	const copy = (event: ClipboardEvent) => {
		const selection = doc.getSelection();
		if (
			!selection ||
			selection.isCollapsed ||
			!event.clipboardData ||
			!isReaderFrameTarget(doc, selection.anchorNode)
		)
			return;
		const fragment = doc.createElement("div");
		for (let i = 0; i < selection.rangeCount; i++)
			fragment.append(selection.getRangeAt(i).cloneContents());
		for (const reading of fragment.querySelectorAll("rt,rp")) reading.remove();
		event.clipboardData.setData("text/plain", fragment.textContent ?? "");
		event.preventDefault();
	};
	doc.addEventListener("keydown", keyboard);
	doc.addEventListener("copy", copy);
	doc.addEventListener("pointerdown", down);
	doc.addEventListener("pointerup", reveal);
	doc.addEventListener("pointercancel", cancel);
	doc.addEventListener("selectionchange", selectionChanged);
	selectionChanged();
	return () => {
		doc.removeEventListener("keydown", keyboard);
		doc.removeEventListener("copy", copy);
		doc.removeEventListener("pointerdown", down);
		doc.removeEventListener("pointerup", reveal);
		doc.removeEventListener("pointercancel", cancel);
		doc.removeEventListener("selectionchange", selectionChanged);
	};
}

export type ImageSize = { width: number; height: number };
/** Preserve original aspect ratio; never enlarge a small author's inline image. */
export function fitReaderImage(
	intrinsic: ImageSize,
	author: ImageSize,
	viewport: ImageSize,
): ImageSize | null {
	if (
		![intrinsic.width, intrinsic.height, viewport.width, viewport.height].every(
			(value) => Number.isFinite(value) && value > 0,
		)
	)
		return null;
	const width =
		Number.isFinite(author.width) && author.width > 0
			? author.width
			: intrinsic.width;
	const height =
		Number.isFinite(author.height) && author.height > 0
			? author.height
			: intrinsic.height;
	const scale = Math.min(
		1,
		width / intrinsic.width,
		height / intrinsic.height,
		viewport.width / intrinsic.width,
		viewport.height / intrinsic.height,
	);
	return { width: intrinsic.width * scale, height: intrinsic.height * scale };
}
const IMAGE_PROPERTIES = [
	"width",
	"height",
	"max-width",
	"max-height",
	"object-fit",
] as const;
const authorImageStyles = new WeakMap<
	HTMLImageElement,
	Array<[string, string, string]>
>();
/** Measure original author styling against the real reader viewport, before the iframe's 1px resize probe. */
export function normalizeFrameImages(doc: Document, viewport: ImageSize): void {
	const win = doc.defaultView;
	if (!win || viewport.width <= 0 || viewport.height <= 0) return;
	const frame = win.frameElement as HTMLIFrameElement | null;
	const previousFrame = frame ? [frame.style.width, frame.style.height] : null;
	if (frame) {
		frame.style.width = `${viewport.width}px`;
		frame.style.height = `${viewport.height}px`;
	}
	try {
		for (const image of doc.images) {
			let author = authorImageStyles.get(image);
			if (!author) {
				author = IMAGE_PROPERTIES.map((property) => [
					property,
					image.style.getPropertyValue(property),
					image.style.getPropertyPriority(property),
				]);
				authorImageStyles.set(image, author);
			}
			for (const [property, value, priority] of author) {
				if (value) image.style.setProperty(property, value, priority);
				else image.style.removeProperty(property);
			}
			const computed = win.getComputedStyle(image);
			const authorSize = {
				width: Number.parseFloat(computed.width),
				height: Number.parseFloat(computed.height),
			};
			const bounds = { ...viewport };
			// Only explicit clipping ancestors constrain this image; ordinary text parents keep their layout.
			for (
				let parent = image.parentElement;
				parent && parent !== doc.body;
				parent = parent.parentElement
			) {
				const css = win.getComputedStyle(parent);
				if (/^(hidden|clip)$/.test(css.overflowX) && parent.clientWidth > 0)
					bounds.width = Math.min(bounds.width, parent.clientWidth);
				if (/^(hidden|clip)$/.test(css.overflowY) && parent.clientHeight > 0)
					bounds.height = Math.min(bounds.height, parent.clientHeight);
			}
			const size = fitReaderImage(
				{ width: image.naturalWidth, height: image.naturalHeight },
				authorSize,
				bounds,
			);
			if (!size) continue; // Pending or broken images retain original declarations until the next valid resize.
			image.style.setProperty("width", `${size.width}px`, "important");
			image.style.setProperty("height", `${size.height}px`, "important");
			image.style.setProperty("max-width", `${bounds.width}px`, "important");
			image.style.setProperty("max-height", `${bounds.height}px`, "important");
			image.style.setProperty("object-fit", "contain", "important");
		}
	} finally {
		if (frame && previousFrame) {
			frame.style.width = previousFrame[0] ?? "";
			frame.style.height = previousFrame[1] ?? "";
		}
	}
}
