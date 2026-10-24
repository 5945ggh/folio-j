import type { Projection } from "./dom.ts";
import { registerReaderFrameTargets } from "./focus.ts";
import { rawOffset } from "./position.ts";
import {
	INLINE_MOTION_EASING,
	INLINE_MOTION_MS,
} from "./reader-flow-motion.ts";

type Mutate = (update: () => void) => void;
const generated = new WeakMap<Document, Set<HTMLElement>>();
type ClosingGeometry = {
	height: number;
	opacity: string;
	clip: string;
	paddingTop: string;
	paddingBottom: string;
};
function geometry(node: HTMLElement): ClosingGeometry {
	const css = node.ownerDocument.defaultView?.getComputedStyle(node);
	return {
		height: node.getBoundingClientRect().height,
		opacity: css?.opacity || ".8",
		clip: css?.clipPath || "inset(0 0 0% 0)",
		paddingTop: css?.paddingTop || "0px",
		paddingBottom: css?.paddingBottom || "0px",
	};
}
const sizeTransition = `opacity ${INLINE_MOTION_MS}ms ${INLINE_MOTION_EASING}, height ${INLINE_MOTION_MS}ms ${INLINE_MOTION_EASING}, padding-top ${INLINE_MOTION_MS}ms ${INLINE_MOTION_EASING}, padding-bottom ${INLINE_MOTION_MS}ms ${INLINE_MOTION_EASING}`;
function translationFontSize(doc: Document): string {
	const body = Number.parseFloat(
		doc.defaultView?.getComputedStyle(doc.body).fontSize ?? "",
	);
	return Number.isFinite(body) ? `${Math.max(14, body * 0.85)}px` : "inherit";
}
/** Cancel only the preceding paragraph's positive margin, then restore that gap after the translation. */
function paragraphSpacing(
	doc: Document,
	node: HTMLElement,
	paragraph: HTMLElement | null,
): void {
	const computed = paragraph
		? Number.parseFloat(
				doc.defaultView?.getComputedStyle(paragraph).marginBottom ?? "",
			)
		: 0;
	const gap = Number.isFinite(computed) ? Math.max(0, computed) : 0;
	node.style.setProperty("margin-block-start", `${-gap}px`, "important");
	node.style.setProperty("margin-block-end", `${gap}px`, "important");
}

/** Only nodes created here qualify; author or extension data attributes grant no privileges. */
export function inlineTranslationInRange(
	doc: Document,
	range: Range,
): HTMLElement | null {
	for (const node of generated.get(doc) ?? [])
		if (node.isConnected && range.intersectsNode(node)) return node;
	return null;
}

function insertion(doc: Document, projection: Projection, end: number) {
	const view = doc.defaultView;
	if (!view) return null;
	const finish = rawOffset(projection.raw, end);
	const preceding = projection.raw.slice(0, finish).trimEnd().length;
	const entry = projection.entries.find(
		(item) => item.start < preceding && item.end >= preceding,
	);
	if (!entry) return null;
	const style = (node: Element) => view.getComputedStyle(node);
	const unchangedCoordinates = (css: CSSStyleDeclaration) =>
		[css.transform, css.scale, css.rotate, css.perspective].every(
			(value) => !value || value === "none",
		) &&
		(!css.zoom ||
			css.zoom === "normal" ||
			css.zoom === "100%" ||
			Number(css.zoom) === 1);
	if (!unchangedCoordinates(style(doc.documentElement))) return null;
	const ordinary = (node: Element) => {
		const css = style(node);
		return (
			css.writingMode === "horizontal-tb" &&
			unchangedCoordinates(css) &&
			/^(static|relative)$/.test(css.position) &&
			css.float === "none" &&
			(css.columnCount === "auto" || css.columnCount === "1") &&
			css.columnWidth === "auto" &&
			(node === doc.body ||
				!(
					/^(hidden|clip|auto|scroll)$/.test(css.overflowX) ||
					/^(hidden|clip|auto|scroll)$/.test(css.overflowY)
				))
		);
	};
	let container = entry.node.parentElement;
	while (container && !/^(P|DIV|BODY)$/.test(container.tagName)) {
		if (
			!/^(inline|contents|ruby|ruby-base|ruby-text-container)$/.test(
				style(container).display,
			) ||
			!ordinary(container)
		)
			return null;
		container = container.parentElement;
	}
	if (
		!container ||
		!ordinary(container) ||
		!/^(block|flow-root)$/.test(style(container).display)
	)
		return null;
	let parent: HTMLElement, before: ChildNode | null;
	if (container.tagName === "P") {
		if (!container.parentElement) return null;
		parent = container.parentElement;
		before = container.nextSibling;
	} else {
		parent = container;
		let child: Node = entry.node;
		while (child.parentElement && child.parentElement !== container)
			child = child.parentElement;
		const siblings = Array.from(container.childNodes);
		const start = siblings.indexOf(child as ChildNode);
		if (start < 0) return null;
		before = null;
		for (const candidate of siblings.slice(start)) {
			if (candidate.nodeType === 1) {
				const element = candidate as HTMLElement;
				if (
					!/^(inline|contents|ruby)$/.test(style(element).display) ||
					!ordinary(element)
				)
					return null;
			}
			const content = projection.entries
				.filter(
					(item) => candidate === item.node || candidate.contains(item.node),
				)
				.map((item) => item.node.data)
				.join("");
			const newline = content.indexOf("\n");
			if (newline < 0) continue;
			// A single locator leaf containing multiple paragraphs cannot be split safely.
			if (content.slice(newline + 1).trim()) return null;
			before = candidate.nextSibling;
			break;
		}
		// A complete div paragraph ends outside its original container, just as p does.
		if (!before && container !== doc.body && container.parentElement) {
			parent = container.parentElement;
			before = container.nextSibling;
		}
	}
	for (
		let ancestor: HTMLElement | null = parent;
		ancestor;
		ancestor = ancestor.parentElement
	) {
		if (
			!ordinary(ancestor) ||
			!/^(block|flow-root|list-item)$/.test(style(ancestor).display)
		)
			return null;
		if (ancestor === doc.body) break;
	}
	if (
		parent.closest(
			"[data-locator-leaf],ruby,rt,rp,table,thead,tbody,tfoot,tr,ul,ol",
		)
	)
		return null;
	return { parent, before, paragraph: parent === container ? null : container };
}

/** Owns one noncanonical paragraph, its animation, and removal. Original DOM is never moved or wrapped. */
export class InlineTranslation {
	private readonly beforeRemove: () => void;
	constructor(beforeRemove = () => {}) {
		this.beforeRemove = beforeRemove;
	}
	get element(): HTMLElement | null {
		return this.active?.node ?? null;
	}
	get closing(): boolean {
		return this.active?.closing ?? false;
	}
	isShowing(doc: Document, end: number, text: string): boolean {
		return !!(
			this.active?.doc === doc &&
			this.active.end === end &&
			this.active.text === text &&
			this.active.node.isConnected &&
			!this.active.closing
		);
	}
	get animations(): Animation[] {
		return this.active?.node.getAnimations?.() ?? [];
	}
	get fullHeight(): number {
		return (
			this.active?.expanded?.height ??
			this.active?.node.getBoundingClientRect().height ??
			0
		);
	}
	get growth(): {
		node: HTMLElement;
		fromHeight: number;
		fullHeight: number;
	} | null {
		const active = this.active;
		return active?.expanded && active.growingFrom !== null && !active.closing
			? {
					node: active.node,
					fromHeight: active.growingFrom,
					fullHeight: active.expanded.height,
				}
			: null;
	}
	/** Capture before the flow controller releases a closing height effect. */
	prepareReopen(): void {
		if (this.active?.closing)
			this.active.reopening = geometry(this.active.node);
	}
	restoreNatural(): void {
		const active = this.active;
		if (!active || active.closing) return;
		active.growingFrom = null;
		active.node.style.setProperty("transition", "none", "important");
		active.node.style.setProperty("height", "auto", "important");
		active.node.style.setProperty("padding-top", ".35em", "important");
		active.node.style.setProperty("padding-bottom", ".65em", "important");
		active.node.style.setProperty("opacity", ".8", "important");
		active.node.style.setProperty("clip-path", "inset(0 0 0% 0)", "important");
		active.expanded = geometry(active.node);
	}
	private grow(
		node: HTMLElement,
		from: ClosingGeometry,
		full: ClosingGeometry,
	): void {
		const view = node.ownerDocument.defaultView;
		if (!view || view.matchMedia("(prefers-reduced-motion: reduce)").matches)
			return;
		if (this.active) this.active.growingFrom = from.height;
		node.style.setProperty("transition", "none", "important");
		node.style.setProperty("height", `${from.height}px`, "important");
		node.style.setProperty("padding-top", from.paddingTop, "important");
		node.style.setProperty("padding-bottom", from.paddingBottom, "important");
		node.style.setProperty("opacity", from.opacity, "important");
		node.style.setProperty("clip-path", "inset(0 0 0% 0)", "important");
		void view.getComputedStyle(node).height;
		node.style.setProperty("transition", sizeTransition, "important");
		node.style.setProperty("height", `${full.height}px`, "important");
		node.style.setProperty("padding-top", full.paddingTop, "important");
		node.style.setProperty("padding-bottom", full.paddingBottom, "important");
		node.style.setProperty("opacity", ".8", "important");
		void view.getComputedStyle(node).height;
	}
	private active: {
		doc: Document;
		node: HTMLElement;
		paragraph: HTMLElement | null;
		end: number;
		text: string;
		mutate: Mutate;
		valid: () => boolean;
		stopWaiting: () => void;
		closeTimer: ReturnType<typeof setTimeout> | null;
		closing: boolean;
		expanded: ClosingGeometry | null;
		reopening: ClosingGeometry | null;
		growingFrom: number | null;
	} | null = null;
	set(
		doc: Document,
		projection: Projection,
		end: number,
		text: string,
		mutate: Mutate,
		valid = () => true,
	): boolean {
		if (
			this.active?.doc === doc &&
			this.active.end === end &&
			this.active.text === text &&
			this.active.node.isConnected &&
			valid()
		) {
			this.active.mutate = mutate;
			this.active.valid = valid;
			if (this.active.closing) {
				const active = this.active;
				const from = active.reopening ?? geometry(active.node);
				if (active.closeTimer !== null) clearTimeout(active.closeTimer);
				active.closeTimer = null;
				active.stopWaiting();
				active.closing = false;
				active.reopening = null;
				mutate(() => this.restoreNatural());
				active.expanded = geometry(active.node);
				this.grow(active.node, from, active.expanded);
			}
			return true;
		}
		this.clear();
		if (!text.trim() || !valid()) return false;
		const target = insertion(doc, projection, end);
		if (!target) return false;
		const node = doc.createElement("div");
		node.dataset.readerInlineTranslation = "";
		node.setAttribute("lang", "");
		node.setAttribute("dir", "auto");
		node.setAttribute("aria-label", "译文");
		node.textContent = text;
		const properties: Record<string, string> = {
			all: "initial",
			display: "block",
			position: "static",
			float: "none",
			clear: "both",
			"box-sizing": "border-box",
			"font-family": "system-ui, sans-serif",
			"font-size": translationFontSize(doc),
			"line-height": "1.75",
			color: "inherit",
			"-webkit-text-fill-color": "currentColor",
			"writing-mode": "horizontal-tb",
			"text-align": "start",
			"text-indent": "0",
			"white-space": "pre-wrap",
			"overflow-wrap": "anywhere",
			"word-break": "normal",
			"user-select": "text",
			"-webkit-user-select": "text",
			width: "auto",
			"min-width": "0",
			"max-width": "100%",
			height: "auto",
			"min-height": "0",
			"max-height": "none",
			margin: "0",
			padding: ".35em 0 .65em",
			border: "0",
			background: "transparent",
			opacity: ".8",
			"clip-path": "inset(0 0 0% 0)",
			overflow: "hidden",
			"pointer-events": "auto",
			transition: "none",
			animation: "none",
			transform: "none",
			"text-shadow": "none",
			"text-decoration": "none",
		};
		for (const [key, value] of Object.entries(properties))
			node.style.setProperty(key, value, "important");
		paragraphSpacing(doc, node, target.paragraph);
		const nodes = generated.get(doc) ?? new Set<HTMLElement>();
		generated.set(doc, nodes);
		nodes.add(node);
		registerReaderFrameTargets(doc, [node]);
		const active = {
			doc,
			node,
			paragraph: target.paragraph,
			end,
			text,
			mutate,
			valid,
			stopWaiting: () => {},
			closeTimer: null as ReturnType<typeof setTimeout> | null,
			closing: false,
			expanded: null as ClosingGeometry | null,
			reopening: null as ClosingGeometry | null,
			growingFrom: null as number | null,
		};
		this.active = active;
		const view = doc.defaultView;
		const animate =
			!!view?.requestAnimationFrame &&
			!view.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (animate) node.style.setProperty("opacity", "0", "important");
		// One expanded measurement gives the iframe its target; native CSS handles intermediate sizes.
		mutate(() => target.parent.insertBefore(node, target.before));
		active.expanded = geometry(node);
		if (animate)
			this.grow(
				node,
				{
					...active.expanded,
					height: 0,
					opacity: "0",
					paddingTop: "0px",
					paddingBottom: "0px",
				},
				active.expanded,
			);
		return true;
	}
	refresh(): void {
		const active = this.active;
		if (active) {
			this.restoreNatural();
			active.node.style.setProperty(
				"font-size",
				translationFontSize(active.doc),
				"important",
			);
			paragraphSpacing(active.doc, active.node, active.paragraph);
			active.expanded = geometry(active.node);
		}
	}
	hide(mutate: Mutate): boolean {
		const active = this.active;
		if (!active) return false;
		active.mutate = mutate;
		if (active.closing) return false;
		if (!active.valid()) {
			this.clear(false);
			return false;
		}
		const view = active.doc.defaultView;
		if (
			!view?.requestAnimationFrame ||
			view.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			this.clear();
			return false;
		}
		active.closing = true;
		active.growingFrom = null;
		const from = geometry(active.node);
		active.expanded ??= from;
		active.reopening = null;
		active.node.style.setProperty("transition", "none", "important");
		active.node.style.setProperty("opacity", from.opacity, "important");
		active.node.style.setProperty("clip-path", from.clip, "important");
		active.node.style.setProperty("height", `${from.height}px`, "important");
		active.node.style.setProperty("padding-top", from.paddingTop, "important");
		active.node.style.setProperty(
			"padding-bottom",
			from.paddingBottom,
			"important",
		);
		void view.getComputedStyle(active.node).height;
		active.node.style.setProperty("transition", sizeTransition, "important");
		active.node.style.setProperty("opacity", "0", "important");
		active.node.style.setProperty("height", "0px", "important");
		active.node.style.setProperty("padding-top", "0px", "important");
		active.node.style.setProperty("padding-bottom", "0px", "important");
		void view.getComputedStyle(active.node).opacity;
		const fade = this.animations.find(
			(animation) =>
				(animation as CSSTransition).transitionProperty === "opacity",
		);
		const finish = () => {
			if (this.active === active && active.closing) this.clear();
		};
		fade?.addEventListener("finish", finish, { once: true });
		active.stopWaiting = () => fade?.removeEventListener("finish", finish);
		// Height and padding contract during the fade; removal only disposes the empty box.
		// The deadline is a fallback for a detached/non-rendered document, not another animation stage.
		active.closeTimer = setTimeout(finish, INLINE_MOTION_MS + (fade ? 50 : 0));
		return true;
	}
	clear(reflow = true): void {
		const active = this.active;
		if (!active) return;
		this.active = null;
		active.stopWaiting();
		if (active.closeTimer !== null) clearTimeout(active.closeTimer);
		this.beforeRemove();
		generated.get(active.doc)?.delete(active.node);
		if (reflow) active.mutate(() => active.node.remove());
		else active.node.remove();
	}
}
