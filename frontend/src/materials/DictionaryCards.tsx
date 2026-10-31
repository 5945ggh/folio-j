import {
	type CSSProperties,
	type MouseEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { DictionaryNode, DictionaryRequest } from "./dictionary-api";
import {
	compactDictionaryLayout,
	compactDictionaryWidth,
	desktopDictionaryLayout,
} from "./dictionary-layout";
import type { DictionaryPage } from "./dictionary-pages";
import {
	type DictionaryPassage,
	dictionaryPassage,
} from "./dictionary-passage";
import type { ScreenAnchor, StudyMarkHit } from "./reader-study";

export type LookupOrigin = {
	input: DictionaryRequest;
	anchor: ScreenAnchor;
	parentBox?: ScreenAnchor;
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
function definitionStyle(
	style: DictionaryNode["style"],
): CSSProperties | undefined {
	if (!style) return undefined;
	const properties = Object.fromEntries(
		Object.entries(style).filter(([, value]) => value != null),
	);
	// The dictionary supplies the light-paper colors. Keep their hue legible on dark paper.
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
	levels,
	opacity,
	title,
	nested,
	choose,
	backTo,
	close,
	onRecord,
}: {
	levels: LookupLevel[];
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
	const root = levels[0];
	if (!root) return null;
	const compact = viewport.width < compactDictionaryWidth;
	const position = compact
		? compactDictionaryLayout(
				root.origin.anchor,
				viewport.width,
				viewport.height,
			)
		: undefined;
	const ancestors = position && position.maxHeight >= 330 ? 2 : 1;
	const style: CSSProperties & {
		"--dict-height"?: string;
		"--dict-opacity": string;
	} = {
		...position,
		"--dict-height": position ? `${position.maxHeight}px` : undefined,
		"--dict-opacity": `${opacity}%`,
	};
	const parents = levels.flatMap((item) =>
		item.origin.parentBox ? [item.origin.parentBox] : [],
	);

	return (
		<section
			className="dict-deck"
			role="dialog"
			data-compact={compact}
			data-reader-tool=""
			aria-label="查词结果"
			style={style}
		>
			{levels.map((level, depth) => (
				<WordCard
					key={level.id}
					level={level}
					depth={depth}
					title={title}
					hidden={compact && depth < levels.length - 1 - ancestors}
					compact={compact}
					viewport={viewport}
					parents={parents.slice(0, depth)}
					child={levels[depth + 1]}
					nested={nested}
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
	level,
	depth,
	title,
	child,
	hidden,
	compact,
	viewport,
	parents,
	nested,
	choose,
	backTo,
	close,
	onRecord,
}: {
	level: LookupLevel;
	depth: number;
	title: string;
	child?: LookupLevel;
	compact: boolean;
	viewport: { width: number; height: number };
	parents: ScreenAnchor[];
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
	const position = compact
		? undefined
		: desktopDictionaryLayout(
				level.origin.anchor,
				parents,
				viewport.width,
				viewport.height,
				firstHeight ?? 360,
			);
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
	const lookupText = (event: MouseEvent<HTMLDivElement>) => {
		if (
			event.button !== 0 ||
			event.detail > 1 ||
			event.shiftKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			!document.getSelection()?.isCollapsed
		)
			return;
		const passage = dictionaryPassage(
			event.currentTarget,
			event.clientX,
			event.clientY,
		);
		if (passage)
			nested(depth, {
				input: { text: passage.text, position: passage.offset },
				anchor: passage.anchor,
				parentBox: card.current?.getBoundingClientRect(),
				passage,
			});
	};
	const step = (delta: number) => {
		choose(depth, level.index + delta);
		if (scroll.current) scroll.current.scrollTop = 0;
	};
	const glyph =
		Array.from(level.origin.input.text)[level.origin.input.position ?? 0] ?? "";
	return (
		<article
			className="dict-card"
			ref={card}
			style={position}
			data-depth={depth}
			data-parent={!!child}
			hidden={hidden}
			aria-label={`词卡 · ${titleWord ?? glyph}`}
		>
			<header className="dict-card-head">
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
						{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: A pointer looks up a glyph; keyboard users can query an explicit selection. */}
						<div className="dict-definitions" lang="ja" onClick={lookupText}>
							{entryContent(entry.definitions)}
						</div>
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
										parentBox: card.current?.getBoundingClientRect(),
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
