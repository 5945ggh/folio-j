import {
	type CSSProperties,
	type MouseEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	DictionaryMatch,
	DictionaryNode,
	DictionaryRequest,
} from "./dictionary-api";
import { dictionaryLayout } from "./dictionary-layout";
import {
	type DictionaryPassage,
	dictionaryPassage,
} from "./dictionary-passage";
import type { ScreenAnchor, StudyMarkHit } from "./reader-study";

export type LookupOrigin = {
	input: DictionaryRequest;
	anchor: ScreenAnchor;
	record?: StudyMarkHit | null;
	highlight?: (start: number, end: number) => void;
	clear?: () => void;
	passage?: DictionaryPassage;
};
export type LookupLevel = {
	id: number;
	origin: LookupOrigin;
	matches: DictionaryMatch[];
	index: number;
	pending: boolean;
	message: string;
};
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
			>
				{node.text}
				{node.content && entryContent(node.content, key)}
			</Tag>
		);
	});
}

function excerpt(level: LookupLevel) {
	const match = level.matches[level.index];
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
	title,
	nested,
	choose,
	backTo,
	close,
	onRecord,
}: {
	levels: LookupLevel[];
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
		const match = root?.matches[root.index];
		if (match) root.origin.highlight?.(match.start, match.end);
		const ranges = levels.slice(1).flatMap((item) => {
			const active = item.matches[item.index];
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
	const { compact, limit, cardWidth, ...position } = dictionaryLayout(
		root.origin.anchor,
		viewport.width,
		viewport.height,
		levels.length,
	);
	const ancestors = Math.min(
		levels.length - 1,
		compact && limit >= 330 ? 2 : 1,
	);
	const style: CSSProperties & Record<`--dict-${string}`, string | number> = {
		...position,
		"--dict-card-width": `${cardWidth}px`,
		"--dict-height": `${limit}px`,
	};
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
					hidden={depth < levels.length - 1 - ancestors}
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
	hidden: boolean;
} & Pick<
	Parameters<typeof DictionaryCards>[0],
	"nested" | "choose" | "backTo" | "close" | "onRecord"
>) {
	const match = level.matches[level.index];
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
				anchor: level.origin.anchor,
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
			data-depth={depth}
			data-parent={!!child}
			hidden={hidden}
			aria-label={`词卡 · ${match?.term ?? glyph}`}
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
						{match?.term ?? glyph}
						{match?.reading && match.reading !== match.term && (
							<small>{match.reading}</small>
						)}
					</h2>
				</div>
				<div className="dict-actions">
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
					aria-label={`回到父卡 ${match?.term ?? ""}`}
					onClick={() => backTo(depth)}
				>
					{excerpt(child)}
					<ReturnIcon />
				</button>
			)}
			<div className="dict-scroll" ref={scroll}>
				{match && (
					// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: Selectable dictionary prose resolves pointer glyphs; native selections have an explicit lookup button.
					<div className="dict-definitions" lang="ja" onClick={lookupText}>
						{entryContent(match.definitions)}
					</div>
				)}
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
			<footer className="dict-foot">
				{level.matches.length > 1 ? (
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
							{level.index + 1} / {level.matches.length}
						</span>
						<button
							type="button"
							aria-label="下一个候选"
							disabled={level.index + 1 >= level.matches.length}
							onClick={() => step(1)}
						>
							›
						</button>
					</div>
				) : (
					<span>{match ? "1 个候选" : "查词"}</span>
				)}
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
									anchor: level.origin.anchor,
								});
						}}
					>
						查选中文字
					</button>
				)}
			</footer>
		</article>
	);
}
