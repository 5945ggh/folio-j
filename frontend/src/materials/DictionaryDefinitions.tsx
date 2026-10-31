import {
	type CSSProperties,
	type MouseEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { LookupLevel } from "./DictionaryCards";
import type { DictionaryNode } from "./dictionary-api";
import {
	type DictionaryPassage,
	dictionaryPassage,
} from "./dictionary-passage";
import { FOCUS_TIMING } from "./focus";
import type { DictionaryMode } from "./ReaderDictionary";

function definitionStyle(
	style: DictionaryNode["style"],
): CSSProperties | undefined {
	if (!style) return undefined;
	const properties = Object.fromEntries(
		Object.entries(style).filter(([, value]) => value != null),
	);
	// Preserve the dictionary's colors on both reader papers.
	for (const [key, paper, percent] of [
		["color", "--reader-fg", 48],
		["backgroundColor", "--reader-bg", 24],
		["borderColor", "--reader-fg", 52],
	] as const) {
		const color = style[key];
		if (color)
			properties[key] =
				`light-dark(${color}, color-mix(in srgb, ${color} ${percent}%, var(${paper})))`;
	}
	return properties;
}

function entryContent(nodes: DictionaryNode[], path = "") {
	return nodes.map((node, i) => {
		const key = `${path}.${i}`;
		const Tag = node.tag ?? "span";
		if (Tag === "br") return <br key={key} />;
		return (
			<Tag
				key={key}
				lang={node.lang ?? undefined}
				data-dict-role={node.role ?? undefined}
				style={definitionStyle(node.style)}
			>
				{node.text}
				{node.content && entryContent(node.content, key)}
			</Tag>
		);
	});
}

function covers(coverage: Range | null | undefined, glyph: Range) {
	return (
		coverage?.startContainer.isConnected &&
		coverage.endContainer.isConnected &&
		coverage.compareBoundaryPoints(Range.START_TO_START, glyph) <= 0 &&
		coverage.compareBoundaryPoints(Range.END_TO_END, glyph) >= 0
	);
}

/** A Japanese definition remains selectable, with optional settled Shift pointing. */
export function DictionaryDefinitions({
	nodes,
	mode,
	enabled,
	pending = false,
	child,
	onLookup,
}: {
	nodes: DictionaryNode[];
	mode: DictionaryMode;
	enabled: boolean;
	pending?: boolean;
	child?: LookupLevel;
	onLookup: (passage: DictionaryPassage) => void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const latest = useRef({ nodes, mode, enabled, pending, child, onLookup });
	latest.current = { nodes, mode, enabled, pending, child, onLookup };
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const candidate = useRef<Range | null>(null);
	const lastLookup = useRef<Range | null>(null);
	const [inside, setInside] = useState(false);
	const pointer = useRef<{ x: number; y: number; buttons: number } | null>(
		null,
	);
	const press = useRef<{
		x: number;
		y: number;
		blocked: boolean;
	} | null>(null);
	const cancel = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
		candidate.current = null;
	}, []);
	const getPassage = useCallback((x: number, y: number) => {
		const element = container.current;
		if (
			!element?.isConnected ||
			!element.contains(element.ownerDocument.elementFromPoint(x, y))
		)
			return null;
		return dictionaryPassage(element, x, y);
	}, []);
	const alreadyOpen = useCallback((glyph: Range) => {
		const active = latest.current.child;
		const page = active?.pages[active.index];
		return covers(
			page && active?.origin.passage?.range(page.start, page.end),
			glyph,
		);
	}, []);
	const lookup = useCallback(
		(passage: DictionaryPassage, explicit = false) => {
			const glyph = passage.range(passage.offset, passage.offset + 1);
			if (
				!glyph ||
				alreadyOpen(glyph) ||
				((!explicit || latest.current.pending) &&
					covers(lastLookup.current, glyph))
			)
				return;
			lastLookup.current = glyph;
			latest.current.onLookup(passage);
		},
		[alreadyOpen],
	);
	const schedule = useCallback(() => {
		const position = pointer.current;
		const current = latest.current;
		if (
			!position ||
			position.buttons ||
			current.mode !== "hover" ||
			!current.enabled ||
			!container.current?.ownerDocument.getSelection()?.isCollapsed
		) {
			cancel();
			return;
		}
		const { x, y } = position;
		const passage = getPassage(x, y);
		const glyph = passage?.range(passage.offset, passage.offset + 1);
		if (!glyph || alreadyOpen(glyph) || covers(lastLookup.current, glyph)) {
			cancel();
			return;
		}
		if (covers(candidate.current, glyph)) return;
		cancel();
		candidate.current = glyph;
		const content = current.nodes;
		timer.current = setTimeout(() => {
			cancel();
			const active = latest.current;
			if (
				active.mode !== "hover" ||
				!active.enabled ||
				active.nodes !== content ||
				!container.current?.ownerDocument.getSelection()?.isCollapsed
			)
				return;
			const settled = getPassage(x, y);
			const settledGlyph = settled?.range(settled.offset, settled.offset + 1);
			if (settled && settledGlyph && covers(glyph, settledGlyph))
				lookup(settled);
		}, FOCUS_TIMING.dictionaryHover);
	}, [alreadyOpen, cancel, getPassage, lookup]);
	// Only the definition beneath the mouse listens globally. This also lets a
	// stationary mouse start pointing when Shift is pressed in the reader.
	useEffect(() => {
		if (!inside || mode !== "hover" || !enabled) return;
		const doc = container.current?.ownerDocument;
		if (!doc) return;
		const keys = (event: KeyboardEvent) => {
			if (
				event.key === "Shift" &&
				event.type === "keydown" &&
				event.shiftKey &&
				!event.altKey &&
				!event.ctrlKey &&
				!event.metaKey
			)
				schedule();
			else if (
				!event.shiftKey ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey
			)
				cancel();
		};
		const selected = () => {
			if (!doc.getSelection()?.isCollapsed) cancel();
		};
		doc.addEventListener("keyup", keys);
		doc.addEventListener("keydown", keys);
		doc.addEventListener("selectionchange", selected);
		doc.addEventListener("scroll", cancel, true);
		doc.defaultView?.addEventListener("blur", cancel);
		return () => {
			cancel();
			doc.removeEventListener("keyup", keys);
			doc.removeEventListener("keydown", keys);
			doc.removeEventListener("selectionchange", selected);
			doc.removeEventListener("scroll", cancel, true);
			doc.defaultView?.removeEventListener("blur", cancel);
		};
	}, [inside, mode, enabled, cancel, schedule]);
	useEffect(() => {
		if (mode !== "hover" || !enabled) cancel();
	}, [mode, enabled, cancel]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Replacing a definition invalidates its DOM hit identity even when React reuses a text node.
	useEffect(() => {
		lastLookup.current = null;
		return cancel;
	}, [nodes, cancel]);
	const previousChild = useRef(child);
	useEffect(() => {
		if (pending) return;
		if (!child && previousChild.current) lastLookup.current = null;
		previousChild.current = child;
	}, [child, pending]);
	const track = (event: PointerEvent<HTMLDivElement>) => {
		if (event.pointerType !== "mouse") {
			pointer.current = null;
			setInside(false);
			cancel();
			return false;
		}
		pointer.current = {
			x: event.clientX,
			y: event.clientY,
			buttons: event.buttons,
		};
		setInside(true);
		return true;
	};
	const move = (event: PointerEvent<HTMLDivElement>) => {
		if (
			press.current &&
			Math.hypot(
				event.clientX - press.current.x,
				event.clientY - press.current.y,
			) >= FOCUS_TIMING.drag
		)
			press.current.blocked = true;
		if (
			track(event) &&
			event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey
		)
			schedule();
		else cancel();
	};
	const down = (event: PointerEvent<HTMLDivElement>) => {
		cancel();
		track(event);
		const passage = getPassage(event.clientX, event.clientY);
		const shiftPointing =
			mode === "hover" &&
			enabled &&
			event.pointerType === "mouse" &&
			event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			event.currentTarget.ownerDocument.getSelection()?.isCollapsed &&
			!!passage;
		press.current = {
			x: event.clientX,
			y: event.clientY,
			blocked: shiftPointing || event.button !== 0,
		};
		if (shiftPointing && event.button === 0) {
			// A quick Shift click commits the pending point immediately. Consume its
			// later click even when Shift is released between down and click.
			event.preventDefault();
			lookup(passage, true);
		}
	};
	const click = (event: MouseEvent<HTMLDivElement>) => {
		const blocked = press.current?.blocked;
		press.current = null;
		cancel();
		if (
			blocked ||
			event.button !== 0 ||
			event.detail > 1 ||
			event.shiftKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			!event.currentTarget.ownerDocument.getSelection()?.isCollapsed
		)
			return;
		const passage = getPassage(event.clientX, event.clientY);
		if (!passage) return;
		if (mode === "hover") lookup(passage, true);
		else onLookup(passage);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: A pointer looks up a glyph; keyboard users can query an explicit selection.
		<div
			className="dict-definitions"
			lang="ja"
			ref={container}
			onClick={click}
			onPointerEnter={track}
			onPointerMove={move}
			onPointerDown={down}
			onPointerUp={track}
			onPointerLeave={() => {
				pointer.current = null;
				setInside(false);
				cancel();
			}}
			onPointerCancel={() => {
				pointer.current = null;
				setInside(false);
				cancel();
				if (press.current) press.current.blocked = true;
			}}
		>
			{entryContent(nodes)}
		</div>
	);
}
