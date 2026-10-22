export const FOCUS_TIMING = {
	idle: 3000,
	jitter: 4,
	clickDelay: 240,
	drag: 6,
	longPress: 500,
} as const;
export type Point = { x: number; y: number };
export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
export function ordinaryTap(
	start: Point,
	end: Point,
	elapsed: number,
): boolean {
	return (
		distance(start, end) < FOCUS_TIMING.drag && elapsed < FOCUS_TIMING.longPress
	);
}
const HOVER_CONTROL =
	"button,input,textarea,select,summary,a,[role=button],[data-reader-control]";
const CONTROL =
	'a,button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="dialog"],[data-reader-control],img,ruby';
function element(event: Event): Element | null {
	const target = event.target as Node | null;
	return target?.nodeType === 1
		? (target as Element)
		: (target?.parentElement ?? null);
}
const originalFrameTargets = new WeakMap<Document, WeakSet<Element>>();
/** Capture before extension UI injection; rebinding the same document never broadens this boundary. */
export function snapshotReaderFrameTargets(doc: Document): void {
	if (!originalFrameTargets.has(doc))
		originalFrameTargets.set(
			doc,
			new WeakSet(doc.querySelectorAll<Element>("*")),
		);
}
/** Explicitly register only reader-created nodes; extension descendants remain outside the boundary. */
export function registerReaderFrameTargets(
	doc: Document,
	targets: Element[],
): void {
	snapshotReaderFrameTargets(doc);
	const original = originalFrameTargets.get(doc);
	for (const target of targets) original?.add(target);
}
export function isReaderFrameTarget(
	doc: Document,
	target: EventTarget | null,
): boolean {
	if (target === doc) return true;
	const node = target as Node | null;
	const candidate =
		node?.nodeType === 1 ? (node as Element) : node?.parentElement;
	return Boolean(candidate && originalFrameTargets.get(doc)?.has(candidate));
}
export type FocusOptions = {
	root: HTMLElement;
	focus?: boolean;
	onVisibilityChange: (visible: boolean) => void;
	onFocusChange?: (enabled: boolean) => void;
	/** React integrations can flushSync their tools state before native Tab navigation. */
	onTabReveal?: (event: KeyboardEvent, wasHidden: boolean) => void;
	hasOverlay?: () => boolean;
	onEscapeOverlay?: () => boolean;
	onBackgroundTap?: () => boolean;
};
/** Bind every loaded same-origin frame; dispose its binding before replacing the document. */
export function createFocusController(options: FocusOptions) {
	let enabled = options.focus ?? true;
	let visible = true;
	let disposed = false;
	let keyboard = false;
	let pressed = false;
	let hovered: Element | null = null;
	let lastPoint: Point | null = null;
	let down: { point: Point; time: number; id: number; moved: boolean } | null =
		null;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let click: ReturnType<typeof setTimeout> | undefined;
	const docs = new Set<Document>([options.root.ownerDocument]);
	const cleanups = new Set<() => void>();
	const frameBindings = new Map<Document, () => void>();
	const selected = () =>
		[...docs].some((doc) => {
			const s = doc.getSelection();
			return Boolean(s && !s.isCollapsed && s.toString());
		});
	const blocked = () =>
		Boolean(
			pressed ||
				down ||
				selected() ||
				(hovered?.isConnected && hovered.getClientRects().length > 0) ||
				options.hasOverlay?.() ||
				(keyboard &&
					[...docs].some((doc) => {
						const active = doc.activeElement;
						return (
							active &&
							active !== doc.body &&
							active.closest("[data-reader-tools], [data-reader-control]")
						);
					})),
		);
	const setVisible = (value: boolean) => {
		if (visible !== value) {
			visible = value;
			options.onVisibilityChange(value);
		}
	};
	const refresh = () => {
		clearTimeout(idle);
		if (disposed || !enabled || !visible || blocked()) return;
		idle = setTimeout(() => {
			if (!blocked()) setVisible(false);
		}, FOCUS_TIMING.idle);
	};
	const show = () => {
		setVisible(true);
		refresh();
	};
	const cancel = () => {
		down = null;
		pressed = false;
		clearTimeout(click);
		refresh();
	};
	const setFocus = (value: boolean) => {
		if (enabled === value) return;
		enabled = value;
		options.onFocusChange?.(value);
		show();
	};
	function bind(target: HTMLElement | Document, frame?: HTMLIFrameElement) {
		const doc = frame ? (target as Document) : options.root.ownerDocument;
		if (frame) {
			snapshotReaderFrameTargets(doc);
			frameBindings.get(doc)?.();
			docs.add(doc);
		}
		const events: Array<[EventTarget, string, EventListener]> = [];
		const listen = (
			type: string,
			fn: EventListener,
			surface: EventTarget = target,
		) => {
			surface.addEventListener(type, fn);
			events.push([surface, type, fn]);
		};
		const point = (e: PointerEvent): Point => {
			const root = options.root.getBoundingClientRect();
			const box = frame?.getBoundingClientRect();
			return {
				x: e.clientX + (box?.left ?? 0) - root.left,
				y: e.clientY + (box?.top ?? 0) - root.top,
			};
		};
		listen("pointerdown", (raw) => {
			const e = raw as PointerEvent;
			if (frame && !isReaderFrameTarget(doc, e.target)) {
				cancel();
				return;
			}
			keyboard = false;
			pressed = true;
			lastPoint = point(e);
			clearTimeout(click);
			down =
				!e.defaultPrevented &&
				!selected() &&
				e.isPrimary !== false &&
				e.button === 0 &&
				!e.altKey &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.shiftKey &&
				!element(e)?.closest(CONTROL)
					? { point: point(e), time: Date.now(), id: e.pointerId, moved: false }
					: null;
			refresh();
		});
		listen("pointermove", (raw) => {
			const e = raw as PointerEvent;
			if (frame && !isReaderFrameTarget(doc, e.target)) return;
			const p = point(e);
			if (down && distance(down.point, p) >= FOCUS_TIMING.drag)
				down.moved = true;
			if (
				e.pointerType !== "touch" &&
				(!lastPoint || distance(lastPoint, p) >= FOCUS_TIMING.jitter)
			) {
				lastPoint = p;
				show();
			}
		});
		listen("pointerup", (raw) => {
			const e = raw as PointerEvent;
			if (frame && !isReaderFrameTarget(doc, e.target)) {
				cancel();
				return;
			}
			const candidate = down;
			pressed = false;
			down = null;
			if (
				candidate &&
				candidate.id === e.pointerId &&
				e.button === 0 &&
				e.isPrimary !== false &&
				!candidate.moved &&
				!e.defaultPrevented &&
				!e.altKey &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.shiftKey &&
				ordinaryTap(candidate.point, point(e), Date.now() - candidate.time) &&
				!selected() &&
				!element(e)?.closest(CONTROL)
			) {
				if (!frame && options.onBackgroundTap?.()) {
					e.preventDefault();
					refresh();
					return;
				}
				clearTimeout(click);
				click = setTimeout(() => {
					if (
						!e.defaultPrevented &&
						!disposed &&
						enabled &&
						!selected() &&
						!blocked()
					) {
						setVisible(!visible);
						refresh();
					}
				}, FOCUS_TIMING.clickDelay);
			}
			refresh();
		});
		listen("dblclick", (event) => {
			if (frame && !isReaderFrameTarget(doc, event.target)) {
				cancel();
				return;
			}
			clearTimeout(click);
			down = null;
			show();
		});
		listen("pointercancel", cancel);
		listen("pointerover", (e) => {
			if (frame && !isReaderFrameTarget(doc, e.target)) {
				hovered = null;
				refresh();
				return;
			}
			if ((e as PointerEvent).pointerType === "touch") return;
			hovered = element(e)?.closest(HOVER_CONTROL) ?? null;
			if (hovered) show();
		});
		listen("pointerout", (e) => {
			const next = (e as PointerEvent).relatedTarget as Element | null;
			hovered =
				frame && !isReaderFrameTarget(doc, next)
					? null
					: (next?.closest?.(HOVER_CONTROL) ?? null);
			refresh();
		});
		listen(
			"keydown",
			(raw) => {
				const e = raw as KeyboardEvent;
				if (
					e.defaultPrevented ||
					e.isComposing ||
					(frame && !isReaderFrameTarget(doc, e.target))
				)
					return;
				if (
					!frame &&
					(options.root.isConnected === false ||
						(doc.activeElement &&
							doc.activeElement !== doc.body &&
							doc.activeElement !== doc.documentElement &&
							!options.root.contains(doc.activeElement)))
				)
					return;
				if (e.key === "Tab") {
					keyboard = true;
					const wasHidden = !visible;
					show();
					options.onTabReveal?.(e, wasHidden);
				} else if (e.key === "Escape") {
					if (options.onEscapeOverlay?.()) {
						e.preventDefault();
					} else if (
						!element(e)?.closest("input,textarea,select,[contenteditable]")
					) {
						setFocus(false);
						e.preventDefault();
					}
				}
			},
			doc,
		);
		listen("focusin", (event) => {
			if (frame && !isReaderFrameTarget(doc, event.target)) return;
			if (keyboard) show();
		});
		listen("focusout", () => {
			queueMicrotask(refresh);
		});
		const selection = () => {
			if (selected()) clearTimeout(click);
			refresh();
		};
		doc.addEventListener("selectionchange", selection);
		let bound = true;
		const cleanup = () => {
			if (!bound) return;
			bound = false;
			for (const [surface, type, fn] of events)
				surface.removeEventListener(type, fn);
			doc.removeEventListener("selectionchange", selection);
			if (frame) {
				docs.delete(doc);
				frameBindings.delete(doc);
			}
			cleanups.delete(cleanup);
			hovered = null;
			cancel();
		};
		cleanups.add(cleanup);
		if (frame) frameBindings.set(doc, cleanup);
		return cleanup;
	}
	bind(options.root);
	const win = options.root.ownerDocument.defaultView;
	const blur = () => {
		hovered = null;
		keyboard = false;
		cancel();
		clearTimeout(idle);
	};
	const visibility = () => {
		if (options.root.ownerDocument.hidden) blur();
		else show();
	};
	const outsideUp = () => {
		if (pressed) cancel();
	};
	win?.addEventListener("pointerup", outsideUp);
	win?.addEventListener("pointercancel", outsideUp);
	win?.addEventListener("blur", blur);
	win?.addEventListener("focus", show);
	options.root.ownerDocument.addEventListener("visibilitychange", visibility);
	options.onVisibilityChange(true);
	refresh();
	return {
		bindFrame: (doc: Document, frame: HTMLIFrameElement) => bind(doc, frame),
		setFocus,
		show,
		refresh,
		get visible() {
			return visible;
		},
		dispose() {
			disposed = true;
			clearTimeout(idle);
			clearTimeout(click);
			for (const cleanup of [...cleanups]) cleanup();
			win?.removeEventListener("pointerup", outsideUp);
			win?.removeEventListener("pointercancel", outsideUp);
			win?.removeEventListener("blur", blur);
			win?.removeEventListener("focus", show);
			options.root.ownerDocument.removeEventListener(
				"visibilitychange",
				visibility,
			);
		},
	};
}
