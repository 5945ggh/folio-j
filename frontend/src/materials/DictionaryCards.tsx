import {
	type CSSProperties,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { DictionaryDefinitions } from "./DictionaryDefinitions";
import type { DictionaryRequest } from "./dictionary-api";
import {
	compactDictionaryLayout,
	compactDictionaryWidth,
	desktopDictionaryLayout,
	movedDictionaryLayout,
} from "./dictionary-layout";
import type { DictionaryPage } from "./dictionary-pages";
import type { DictionaryPassage } from "./dictionary-passage";
import type { DictionaryMode } from "./ReaderDictionary";
import type { ReaderCardPosition } from "./reader-card-drag";
import type { ScreenAnchor, StudyMarkHit } from "./reader-study";
import { useReaderCardDrag } from "./use-reader-card-drag";

export type LookupOrigin = {
	input: DictionaryRequest;
	anchor: ScreenAnchor;
	parentBoxes?: ScreenAnchor[];
	record?: StudyMarkHit | null;
	highlight?: (start: number, end: number) => void;
	clear?: () => void;
	passage?: DictionaryPassage;
};
export type LookupLevel = {
	id: number;
	origin: LookupOrigin;
	pages: DictionaryPage[];
	index: number;
	pending: boolean;
	message: string;
};
function excerpt(level: LookupLevel) {
	const match = level.pages[level.index];
	if (!match) return null;
	const chars = Array.from(level.origin.input.text);
	let start = match.start,
		end = match.end;
	while (
		start > 0 &&
		match.start - start < 14 &&
		!/[。！？\n]/u.test(chars[start - 1] ?? "")
	)
		start--;
	while (end < chars.length && end - match.end < 32) {
		if (/[。！？\n]/u.test(chars[end++] ?? "")) break;
	}
	return (
		<span lang="ja" className="dict-excerpt">
			{start > 0 && !/[。！？\n]/u.test(chars[start - 1] ?? "") && "…"}
			{chars.slice(start, match.start).join("")}
			<mark>{match.surface}</mark>
			{chars.slice(match.end, end).join("")}
			{end < chars.length && !/[。！？\n]/u.test(chars[end - 1] ?? "") && "…"}
		</span>
	);
}
function ReturnIcon() {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 20 20"
			width="17"
			height="17"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.45"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="m7.5 4.5-4 4 4 4M4 8.5h8a4 4 0 0 1 0 8h-1.5" />
		</svg>
	);
}

export function DictionaryCards({
	behindPanel,
	levels,
	mode,
	opacity,
	title,
	nested,
	choose,
	backTo,
	close,
	onRecord,
}: {
	levels: LookupLevel[];
	behindPanel: boolean;
	mode: DictionaryMode;
	opacity: number;
	title: string;
	nested: (depth: number, origin: LookupOrigin) => void;
	choose: (depth: number, index: number) => void;
	backTo: (depth: number) => void;
	close: () => void;
	onRecord: (hit: StudyMarkHit) => void;
}) {
	const [viewport, setViewport] = useState(() => ({
		width: window.innerWidth,
		height: window.innerHeight,
	}));
	useEffect(() => {
		const resize = () =>
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useLayoutEffect(() => {
		const root = levels[0];
		const match = root?.pages[root.index];
		if (match) root.origin.highlight?.(match.start, match.end);
		const ranges = levels.slice(1).flatMap((item) => {
			const active = item.pages[item.index];
			const range =
				active && item.origin.passage?.range(active.start, active.end);
			return range ? [range] : [];
		});
		if (typeof Highlight !== "undefined")
			CSS.highlights.set("folio-card-word", new Highlight(...ranges));
		return () => {
			CSS.highlights?.delete("folio-card-word");
		};
	}, [levels]);
	const deck = useRef<HTMLElement>(null);
	const [stackPoint, setStackPoint] = useState<ReaderCardPosition | null>(null);
	const [minimumStackHeight, setMinimumStackHeight] = useState(120);
	const compact = viewport.width < compactDictionaryWidth;
	const manuallyPlacedStack = compact && stackPoint !== null;
	useLayoutEffect(() => {
		if (!manuallyPlacedStack || levels.length < 2) {
			setMinimumStackHeight(120);
			return;
		}
		const node = deck.current;
		if (!node) return;
		const measure = () => {
			const foreground = node.querySelector<HTMLElement>(
				".dict-card:last-child",
			);
			const scroll = foreground?.querySelector<HTMLElement>(".dict-scroll");
			if (!foreground || !scroll) return;
			// Reserve the exposed parents, all foreground controls and a readable
			// definition viewport, even when the current card has been squeezed shut.
			const controls =
				Math.max(foreground.offsetHeight, foreground.scrollHeight) -
				scroll.clientHeight;
			setMinimumStackHeight(
				foreground.offsetTop + controls + Math.min(120, scroll.scrollHeight),
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		for (const child of node.querySelectorAll(".dict-card > *"))
			observer.observe(child);
		return () => observer.disconnect();
	}, [manuallyPlacedStack, levels]);
	const root = levels[0];
	if (!root) return null;
	const automatic = compact
		? compactDictionaryLayout(
				root.origin.anchor,
				viewport.width,
				viewport.height,
			)
		: undefined;
	const position =
		automatic && stackPoint
			? movedDictionaryLayout(
					stackPoint,
					automatic.width,
					viewport,
					true,
					minimumStackHeight,
				)
			: automatic;
	const ancestors = position && position.maxHeight >= 330 ? 2 : 1;
	const style: CSSProperties & {
		"--dict-height"?: string;
		"--dict-opacity": string;
	} = {
		...position,
		"--dict-height": position ? `${position.maxHeight}px` : undefined,
		"--dict-opacity": `${opacity}%`,
	};
	// Freeze the actual ancestor boxes for this lookup, including any manual moves.
	const openChild = (depth: number, origin: LookupOrigin) => {
		const cards = Array.from(
			deck.current?.querySelectorAll<HTMLElement>(".dict-card") ?? [],
		);
		nested(depth, {
			...origin,
			parentBoxes: cards
				.slice(0, depth + 1)
				.filter((node) => !node.hidden)
				.map((node) => node.getBoundingClientRect()),
		});
	};

	return (
		<section
			ref={deck}
			className="dict-deck"
			role="dialog"
			data-compact={compact}
			data-reader-tool=""
			aria-label="查词结果"
			style={style}
		>
			{levels.map((level, depth) => (
				<WordCard
					focusOnMount={!behindPanel}
					key={level.id}
					level={level}
					depth={depth}
					title={title}
					hidden={compact && depth < levels.length - 1 - ancestors}
					compact={compact}
					viewport={viewport}
					mode={mode}
					deck={deck}
					moveStack={setStackPoint}
					child={levels[depth + 1]}
					nested={openChild}
					choose={choose}
					backTo={backTo}
					close={close}
					onRecord={onRecord}
				/>
			))}
		</section>
	);
}

function WordCard({
	focusOnMount,
	level,
	depth,
	title,
	child,
	hidden,
	compact,
	viewport,
	mode,
	deck,
	moveStack,
	nested,
	choose,
	backTo,
	close,
	onRecord,
}: {
	level: LookupLevel;
	focusOnMount: boolean;
	depth: number;
	title: string;
	child?: LookupLevel;
	compact: boolean;
	viewport: { width: number; height: number };
	deck: RefObject<HTMLElement | null>;
	moveStack: (point: ReaderCardPosition) => void;
	mode: DictionaryMode;
	hidden: boolean;
} & Pick<
	Parameters<typeof DictionaryCards>[0],
	"nested" | "choose" | "backTo" | "close" | "onRecord"
>) {
	const page = level.pages[level.index];
	const primary = page?.entries[0];
	const multiple = !!page && page.entries.length > 1;
	const titleWord = multiple ? page.surface : primary?.term;
	const card = useRef<HTMLElement>(null);
	const [firstHeight, setFirstHeight] = useState<number | null>(null);
	// Measure once when this lookup resolves. Paging changes only the scrollable contents.
	useLayoutEffect(() => {
		if (!compact && firstHeight === null && !level.pending && card.current)
			setFirstHeight(
				card.current.offsetHeight +
					(scroll.current
						? scroll.current.scrollHeight - scroll.current.clientHeight
						: 0),
			);
	}, [compact, firstHeight, level.pending]);
	const [manual, setManual] = useState<ReaderCardPosition | null>(null);
	const automatic = compact
		? undefined
		: desktopDictionaryLayout(
				level.origin.anchor,
				level.origin.parentBoxes ?? [],
				viewport.width,
				viewport.height,
				firstHeight ?? 360,
			);
	const position =
		manual && automatic
			? movedDictionaryLayout(manual, automatic.width, viewport, false)
			: automatic;
	const movable = compact ? deck : card;
	const drag = useReaderCardDrag(
		movable,
		!hidden,
		(point) => {
			const box = movable.current?.getBoundingClientRect();
			return box
				? movedDictionaryLayout(point, box.width, viewport, compact, box.height)
				: point;
		},
		compact ? moveStack : setManual,
		false, // Left/right belong to candidate paging in a dictionary card.
	);
	const header = useRef<HTMLElement>(null);
	// A lookup can finish after the reader has already switched to a panel.
	const takeInitialFocus = useRef(focusOnMount);
	useLayoutEffect(() => {
		if (takeInitialFocus.current)
			header.current?.focus({ preventScroll: true });
	}, []);
	const scroll = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState<Range | null>(null);
	useEffect(() => {
		const changed = () => {
			const selected = document.getSelection();
			setSelection(
				selected &&
					!selected.isCollapsed &&
					selected.rangeCount &&
					scroll.current?.contains(
						selected.getRangeAt(0).commonAncestorContainer,
					)
					? selected.getRangeAt(0).cloneRange()
					: null,
			);
		};
		document.addEventListener("selectionchange", changed);
		return () => document.removeEventListener("selectionchange", changed);
	}, []);
	const step = (delta: number) => {
		const next = level.index + delta;
		if (next < 0 || next >= level.pages.length) return;
		// Keep focus in this card if a pager button becomes disabled.
		if (document.activeElement?.closest(".dict-pager"))
			header.current?.focus({ preventScroll: true });
		choose(depth, next);
		if (scroll.current) scroll.current.scrollTop = 0;
	};
	const turnPage = (event: KeyboardEvent<HTMLElement>) => {
		if (
			(event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
			event.target !== document.activeElement ||
			event.defaultPrevented ||
			event.nativeEvent.isComposing ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			!document.getSelection()?.isCollapsed ||
			(event.target as Element).closest(
				"textarea,input,select,[contenteditable=true]",
			)
		)
			return;
		event.preventDefault();
		event.stopPropagation();
		step(event.key === "ArrowRight" ? 1 : -1);
	};
	const glyph =
		Array.from(level.origin.input.text)[level.origin.input.position ?? 0] ?? "";
	return (
		<article
			className="dict-card"
			ref={card}
			tabIndex={-1}
			onKeyDown={turnPage}
			data-dragging={drag.dragging || undefined}
			style={position}
			data-depth={depth}
			data-parent={!!child}
			hidden={hidden}
			aria-label={`词卡 · ${titleWord ?? glyph}`}
		>
			<header
				ref={header}
				className="dict-card-head"
				tabIndex={0}
				title={compact ? "拖动卡头移动整组词卡" : "拖动卡头移动词卡"}
				{...drag.handlers}
			>
				<div className="dict-card-heading">
					<div className="dict-imprint">
						<span className="dict-seal" aria-hidden="true">
							辞
						</span>
						{title}
					</div>
					<h2 lang="ja" tabIndex={-1}>
						{titleWord ?? glyph}
						{multiple && <small lang="zh">{page.entries.length} 个词条</small>}
						{!multiple &&
							primary?.reading &&
							primary.reading !== primary.term && (
								<small>{primary.reading}</small>
							)}
					</h2>
				</div>
				<div className="dict-actions">
					{level.pages.length > 1 && (
						<div className="dict-pager">
							<button
								type="button"
								aria-label="上一个候选"
								aria-keyshortcuts="ArrowLeft"
								title="上一个候选（←）"
								disabled={level.index === 0}
								onClick={() => step(-1)}
							>
								‹
							</button>
							<span>
								{level.index + 1} / {level.pages.length}
							</span>
							<button
								type="button"
								aria-label="下一个候选"
								aria-keyshortcuts="ArrowRight"
								title="下一个候选（→）"
								disabled={level.index + 1 >= level.pages.length}
								onClick={() => step(1)}
							>
								›
							</button>
						</div>
					)}
					{depth > 0 && (
						<button
							type="button"
							aria-label="返回上层词卡"
							title="返回上层词卡"
							onClick={() => backTo(depth - 1)}
						>
							<ReturnIcon />
						</button>
					)}
					<button
						type="button"
						aria-label="关闭查词"
						title="关闭查词"
						onClick={close}
					>
						×
					</button>
				</div>
			</header>
			{child && (
				<button
					type="button"
					className="dict-parent-line"
					aria-label={`回到父卡 ${titleWord ?? ""}`}
					onClick={() => backTo(depth)}
				>
					{excerpt(child)}
					<ReturnIcon />
				</button>
			)}
			<div className="dict-scroll" ref={scroll}>
				{page?.entries.map((entry, i) => (
					<section className="dict-entry" key={entry.id}>
						{multiple && (
							<h3 lang="ja">
								<span>{String(i + 1).padStart(2, "0")}</span>
								{entry.term}
								{entry.reading && entry.reading !== entry.term && (
									<small>{entry.reading}</small>
								)}
							</h3>
						)}
						<DictionaryDefinitions
							nodes={entry.definitions}
							mode={mode}
							enabled={!hidden && !(compact && child)}
							child={child}
							pending={level.pending}
							onLookup={(passage) =>
								nested(depth, {
									input: { text: passage.text, position: passage.offset },
									anchor: passage.anchor,
									passage,
								})
							}
						/>
					</section>
				))}
			</div>
			{level.pending && (
				<p className="dict-message" role="status">
					正在查词…
				</p>
			)}
			{level.message && (
				<p className="dict-message" role="status">
					{level.message}
				</p>
			)}
			{(level.origin.record || selection) && (
				<footer className="dict-foot">
					{level.origin.record && (
						<button
							type="button"
							className="dict-link"
							onClick={() => {
								if (level.origin.record) onRecord(level.origin.record);
							}}
						>
							此处记录 ↗
						</button>
					)}
					{selection && (
						<button
							type="button"
							className="dict-link"
							onPointerDown={(e) => e.preventDefault()}
							onClick={() => {
								const text = selection.toString().trim();
								if (text && Array.from(text).length <= 8192)
									nested(depth, {
										input: {
											text,
											selection_start: 0,
											selection_end: Array.from(text).length,
										},
										anchor: selection.getBoundingClientRect(),
									});
							}}
						>
							查选中文字
						</button>
					)}
				</footer>
			)}
		</article>
	);
}
