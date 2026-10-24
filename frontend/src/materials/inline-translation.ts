import type { Projection } from "./dom.ts";
import { registerReaderFrameTargets } from "./focus.ts";
import { rawOffset } from "./position.ts";

type Mutate = (update: () => void) => void;
const FADE_MS = 160;
const generated = new WeakMap<Document, Set<HTMLElement>>();
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
	const ordinary = (node: Element) => {
		const css = style(node);
		return (
			css.writingMode === "horizontal-tb" &&
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
	private active: {
		doc: Document;
		node: HTMLElement;
		paragraph: HTMLElement | null;
		end: number;
		text: string;
		mutate: Mutate;
		valid: () => boolean;
		animation: number | null;
		closeTimer: ReturnType<typeof setTimeout> | null;
		closing: boolean;
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
			!this.active.closing &&
			this.active.node.isConnected &&
			valid()
		) {
			this.active.mutate = mutate;
			this.active.valid = valid;
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
			animation: null as number | null,
			closeTimer: null as ReturnType<typeof setTimeout> | null,
			closing: false,
		};
		this.active = active;
		const view = doc.defaultView;
		const animate =
			!!view?.requestAnimationFrame &&
			!view.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (animate) {
			node.style.setProperty("opacity", "0", "important");
			node.style.setProperty(
				"transition",
				`opacity ${FADE_MS}ms ease`,
				"important",
			);
		}
		// Reserve final geometry once. Opacity feedback never re-enters chapter layout.
		mutate(() => target.parent.insertBefore(node, target.before));
		if (animate && view) {
			// Commit the initial opacity before changing the transition target.
			void view.getComputedStyle(node).opacity;
			active.animation = view.requestAnimationFrame(() => {
				if (this.active !== active) return;
				active.animation = null;
				if (!valid() || !node.isConnected) {
					this.clear(false);
					return;
				}
				node.style.setProperty("opacity", ".8", "important");
			});
		}
		return true;
	}
	refresh(): void {
		const active = this.active;
		if (active) {
			active.node.style.setProperty(
				"font-size",
				translationFontSize(active.doc),
				"important",
			);
			paragraphSpacing(active.doc, active.node, active.paragraph);
		}
	}
	hide(mutate: Mutate): void {
		const active = this.active;
		if (!active) return;
		active.mutate = mutate;
		if (active.closing) return;
		if (!active.valid()) {
			this.clear(false);
			return;
		}
		const view = active.doc.defaultView;
		if (
			!view?.requestAnimationFrame ||
			view.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			this.clear();
			return;
		}
		if (active.animation !== null) view.cancelAnimationFrame(active.animation);
		active.animation = null;
		active.closing = true;
		active.node.style.setProperty(
			"transition",
			`opacity ${FADE_MS}ms ease`,
			"important",
		);
		active.node.style.setProperty("opacity", "0", "important");
		// Keep the paragraph's occupied height while fading; remove with one stable reflow.
		active.closeTimer = setTimeout(() => {
			if (this.active === active) this.clear();
		}, FADE_MS);
	}
	clear(reflow = true): void {
		const active = this.active;
		if (!active) return;
		this.active = null;
		if (active.animation !== null)
			active.doc.defaultView?.cancelAnimationFrame(active.animation);
		if (active.closeTimer !== null) clearTimeout(active.closeTimer);
		generated.get(active.doc)?.delete(active.node);
		if (reflow) active.mutate(() => active.node.remove());
		else active.node.remove();
	}
}
