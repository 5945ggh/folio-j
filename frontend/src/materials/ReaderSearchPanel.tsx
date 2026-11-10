import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useViewActivity } from "../navigation/view-activity";
import type { Material } from "./api";
import { restoreReaderPanelFocus } from "./motion";
import { ReaderSearchIcon } from "./ReaderSearchIcon";
import {
	normalizeReaderQuery,
	READER_SEARCH_DELAY,
	readerQueryTooLong,
} from "./reader-panel-logic";
import {
	type ReaderSearchKind,
	type ReaderSearchState,
	searchKinds,
	searchLabels,
	searchTextParts,
	selectedSearchChapters,
	toggleSearchChapter,
} from "./reader-search";
import {
	type ReaderSearchHit,
	readerSearchKey,
	searchReaderKind,
} from "./reader-search-api";
import { useReaderSessionRefresh } from "./reader-session-query";
import "./reader-search.css";

type Props = {
	book: Material;
	state: ReaderSearchState;
	onState: Dispatch<SetStateAction<ReaderSearchState>>;
	scrollTop: RefObject<number>;
	closing?: boolean;
	inactive?: boolean;
	error?: Error | null;
	onCancelNavigation: () => void;
	onClose: () => void;
	onChoose: (hit: ReaderSearchHit, current: () => boolean) => Promise<void>;
};

function SearchText({ text, query }: { text: string; query: string }) {
	return searchTextParts(text, query).map((part) =>
		part.matched ? (
			<mark key={part.key}>{part.text}</mark>
		) : (
			<span key={part.key}>{part.text}</span>
		),
	);
}

function ChapterCheck({
	id,
	label,
	checked,
	mixed = false,
	onChange,
}: {
	id: string;
	label: string;
	checked: boolean;
	mixed?: boolean;
	onChange: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		if (input.current) input.current.indeterminate = mixed;
	}, [mixed]);
	return (
		<span className="reader-search-check">
			<input
				id={id}
				ref={input}
				type="checkbox"
				aria-label={label}
				checked={checked}
				onChange={onChange}
			/>
			<span aria-hidden="true">
				<ReaderSearchIcon name={mixed ? "minus" : "check"} />
			</span>
		</span>
	);
}

function ChapterPicker({
	chapters,
	selected,
	onChange,
	inactive,
}: {
	chapters: Material["chapters"];
	selected: string[] | null;
	onChange: (ids: string[] | null) => void;
	inactive: boolean;
}) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const id = useId();
	const ids = chapters.map((item) => item.id);
	const chosen = selectedSearchChapters(selected, ids);
	const all = chosen.length === ids.length;
	const label = all
		? "全选章节"
		: chosen.length === 0
			? "未选章节"
			: `已选 ${chosen.length} 章`;
	useLayoutEffect(() => {
		const node = popup.current,
			button = trigger.current;
		if (!open || !node || !button || inactive) return;
		const position = () => {
			const rect = button.getBoundingClientRect();
			const width = Math.min(320, window.innerWidth - 24);
			const below = window.innerHeight - rect.bottom - 18;
			const above = rect.top - 18;
			const useBelow = below >= Math.min(340, above);
			const maxHeight = Math.max(100, Math.min(420, useBelow ? below : above));
			node.style.width = `${width}px`;
			node.style.maxHeight = `${maxHeight}px`;
			node.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
			node.style.top = `${useBelow ? rect.bottom + 6 : Math.max(12, rect.top - Math.min(maxHeight, node.scrollHeight) - 6)}px`;
		};
		node.showPopover();
		position();
		node
			.querySelector<HTMLInputElement>("input")
			?.focus({ preventScroll: true });
		window.addEventListener("resize", position);
		const observer = new ResizeObserver(position);
		observer.observe(button);
		return () => {
			window.removeEventListener("resize", position);
			observer.disconnect();
			if (node.matches(":popover-open")) node.hidePopover();
		};
	}, [open, inactive]);
	useEffect(() => {
		if (inactive) setOpen(false);
	}, [inactive]);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="reader-search-chapter-trigger"
				aria-label={`筛选章节：${label}`}
				aria-haspopup="dialog"
				aria-expanded={open && !inactive}
				aria-controls={id}
				onClick={() => setOpen(!open)}
			>
				<ReaderSearchIcon name="chapters" />
				<span>{label}</span>
				<ReaderSearchIcon name="chevron" />
			</button>
			{open && !inactive && (
				<div
					ref={popup}
					id={id}
					popover="auto"
					role="dialog"
					aria-label="选择章节"
					className="reader-search-chapter-popover"
					data-reader-tool
					onToggle={(event) => {
						if (event.newState === "closed") setOpen(false);
					}}
					onKeyDownCapture={(event) => {
						if (event.key === "Escape" && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.stopPropagation();
							setOpen(false);
							trigger.current?.focus({ preventScroll: true });
						}
					}}
				>
					<label className="reader-search-chapter-all" htmlFor={`${id}-all`}>
						<ChapterCheck
							id={`${id}-all`}
							label="全部章节"
							checked={all}
							mixed={!all && chosen.length > 0}
							onChange={() => onChange(all ? [] : null)}
						/>
						<span>全部章节</span>
						<small aria-live="polite">
							{chosen.length} / {ids.length}
						</small>
					</label>
					<div className="reader-search-chapter-options">
						{chapters.map((chapter) => (
							<label
								key={chapter.id}
								htmlFor={`${id}-${chapter.id}`}
								style={{
									paddingInlineStart: `${10 + Math.min(4, Math.max(0, chapter.level - 1)) * 10}px`,
								}}
							>
								<ChapterCheck
									id={`${id}-${chapter.id}`}
									label={chapter.title}
									checked={chosen.includes(chapter.id)}
									onChange={() =>
										onChange(toggleSearchChapter(selected, ids, chapter.id))
									}
								/>
								<span lang="ja">{chapter.title}</span>
							</label>
						))}
					</div>
				</div>
			)}
		</>
	);
}

function useSearchKind(
	book: Material,
	kind: ReaderSearchKind,
	query: string,
	chapterIds: string[] | null,
	enabled: boolean,
) {
	const activity = useViewActivity();
	const key = [
		...readerSearchKey(book.id, book.version_id),
		kind,
		query,
		chapterIds,
	];
	const result = useInfiniteQuery({
		queryKey: key,
		initialPageParam: 0,
		queryFn: ({ pageParam, signal }) =>
			searchReaderKind(
				book.id,
				book.version_id,
				kind,
				query,
				chapterIds,
				pageParam,
				signal,
			),
		getNextPageParam: (page) =>
			page.offset + page.items.length < page.total
				? page.offset + page.items.length
				: undefined,
		enabled,
		retry: false,
		staleTime: activity.activation > 0 ? Number.POSITIVE_INFINITY : 0,
		refetchOnMount: "always",
	});
	const refreshed = useReaderSessionRefresh(
		key,
		result.refetch,
		enabled,
		activity.activation,
	);
	return {
		...result,
		data:
			refreshed && !result.isError && result.isFetchedAfterMount
				? result.data
				: undefined,
	};
}

/** One material/version session owns search choices; each category has independent query failures and pages. */
export function ReaderSearchPanel(props: Props) {
	const {
		book,
		state,
		onState,
		scrollTop,
		closing = false,
		inactive = false,
	} = props;
	const activity = useViewActivity();
	const enabled = activity.active && !closing && !inactive;
	const root = useRef<HTMLElement>(null),
		input = useRef<HTMLInputElement>(null),
		results = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState(() => normalizeReaderQuery(state.input));
	const [composing, setComposing] = useState(false);
	const [opening, setOpening] = useState<string | null>(null);
	const [openError, setOpenError] = useState<Error | null>(null);
	const request = useRef(0);
	const restoreScroll = useRef<number | null>(scrollTop.current);
	const titleId = useId(),
		filtersId = useId();
	const normalized = normalizeReaderQuery(state.input),
		tooLong = readerQueryTooLong(state.input);
	const chapterIds =
		state.chapterIds === null
			? null
			: selectedSearchChapters(
					state.chapterIds,
					book.chapters.map((chapter) => chapter.id),
				);
	const hasChapters = chapterIds === null || chapterIds.length > 0;
	const current = !composing && !tooLong && normalized === query;
	const canQuery = enabled && current && hasChapters;
	const original = useSearchKind(
		book,
		"original",
		query,
		chapterIds,
		canQuery && !!query && (state.kind === "all" || state.kind === "original"),
	);
	const segments = useSearchKind(
		book,
		"segment",
		query,
		chapterIds,
		canQuery && (state.kind === "all" || state.kind === "segment"),
	);
	const translations = useSearchKind(
		book,
		"translation",
		query,
		chapterIds,
		canQuery && (state.kind === "all" || state.kind === "translation"),
	);
	const bookmarks = useSearchKind(
		book,
		"bookmark",
		query,
		chapterIds,
		canQuery && (state.kind === "all" || state.kind === "bookmark"),
	);
	const queries = {
		original,
		segment: segments,
		translation: translations,
		bookmark: bookmarks,
	};
	const client = useQueryClient();
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (event.type !== "updated" || event.action.type !== "invalidate")
					return;
				const [kind, scope] = event.query.queryKey;
				const relevant =
					((kind === "material-chapter-segments" ||
						kind === "material-chapter-translations") &&
						scope === book.id) ||
					(kind === "source-segments" && scope === book.source_id) ||
					kind === "segment";
				if (relevant)
					void client.invalidateQueries({
						queryKey: readerSearchKey(book.id, book.version_id),
					});
			}),
		[client, book.id, book.source_id, book.version_id],
	);
	useEffect(() => {
		if (composing) return;
		const timer = window.setTimeout(
			() => setQuery(tooLong ? "" : normalized),
			READER_SEARCH_DELAY,
		);
		return () => window.clearTimeout(timer);
	}, [composing, normalized, tooLong]);
	useLayoutEffect(() => {
		if (!enabled) {
			restoreScroll.current = scrollTop.current;
			return;
		}
		if (restoreScroll.current === null || !current) return;
		const ready = searchKinds
			.filter((kind) => state.kind === "all" || state.kind === kind)
			.every(
				(kind) =>
					(kind === "original" && !query) ||
					!!queries[kind].data ||
					queries[kind].isError,
			);
		if (hasChapters && !ready) return;
		if (results.current) results.current.scrollTop = restoreScroll.current;
		restoreScroll.current = null;
	});
	useEffect(() => {
		if (!enabled) {
			request.current++;
			setOpening(null);
			return;
		}
		const previous = document.activeElement,
			node = root.current;
		input.current?.focus({ preventScroll: true });
		return () => {
			request.current++;
			if (node) restoreReaderPanelFocus(node, previous);
		};
	}, [enabled]);
	const change = (patch: Partial<ReaderSearchState>, resetScroll = true) => {
		request.current++;
		setOpening(null);
		setOpenError(null);
		props.onCancelNavigation();
		if (resetScroll) {
			restoreScroll.current = null;
			scrollTop.current = 0;
			if (results.current) results.current.scrollTop = 0;
		}
		onState((previous) => ({ ...previous, ...patch }));
	};
	const choose = async (hit: ReaderSearchHit, key: string) => {
		const ticket = ++request.current;
		setOpening(key);
		setOpenError(null);
		onState((previous) => ({ ...previous, selectedKey: key }));
		try {
			await props.onChoose(hit, () => ticket === request.current);
		} catch (error) {
			if (ticket === request.current)
				setOpenError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			if (ticket === request.current) setOpening(null);
		}
	};
	const chapterLabel =
		chapterIds === null
			? "全选章节"
			: chapterIds.length
				? `已选 ${chapterIds.length} 章`
				: "未选章节";
	const groups = searchKinds.filter(
		(kind) => state.kind === "all" || state.kind === kind,
	);
	return (
		<section
			ref={root}
			className="reader-query-dialog reader-query-side reader-search-panel"
			role="dialog"
			aria-modal="false"
			aria-labelledby={titleId}
			data-reader-tool
			data-reader-panel-side="left"
			data-exiting={closing}
			inert={inactive || closing}
			aria-hidden={inactive || closing || undefined}
			onKeyDown={(event) => {
				if (
					event.key === "Escape" &&
					!event.nativeEvent.isComposing &&
					!event.defaultPrevented
				) {
					event.preventDefault();
					event.stopPropagation();
					props.onClose();
				}
			}}
		>
			<header className="reader-query-heading">
				<div>
					<h2 id={titleId}>本书搜索</h2>
					<span className="reader-search-book" lang="ja">
						{book.title}
					</span>
				</div>
				<button
					type="button"
					className="reader-panel-close"
					aria-label="关闭本书搜索"
					onClick={props.onClose}
				>
					×
				</button>
			</header>
			<div className="reader-search-controls">
				<div className="reader-search-input">
					<ReaderSearchIcon name="search" />
					<input
						ref={input}
						type="search"
						aria-label="搜索本书"
						placeholder="搜索原文、片段、译文、书签"
						autoComplete="off"
						value={state.input}
						onChange={(event) => change({ input: event.target.value })}
						onCompositionStart={() => {
							request.current++;
							props.onCancelNavigation();
							setComposing(true);
						}}
						onCompositionEnd={(event) => {
							setComposing(false);
							change({ input: event.currentTarget.value });
						}}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.nativeEvent.isComposing &&
								!composing &&
								!tooLong
							)
								setQuery(normalized);
						}}
					/>
					{state.input && (
						<button
							type="button"
							aria-label="清空搜索"
							onClick={() => {
								change({ input: "" });
								input.current?.focus();
							}}
						>
							×
						</button>
					)}
				</div>
				<button
					type="button"
					className="reader-search-filter-toggle"
					aria-expanded={state.filtersOpen}
					aria-controls={filtersId}
					onClick={() =>
						onState((previous) => ({
							...previous,
							filtersOpen: !previous.filtersOpen,
						}))
					}
				>
					<ReaderSearchIcon name="filter" />
					<span>筛选</span>
					<small>
						{state.kind === "all" ? "全部内容" : searchLabels[state.kind]} ·{" "}
						{chapterLabel}
					</small>
					<ReaderSearchIcon name="chevron" />
				</button>
				<div
					id={filtersId}
					hidden={!state.filtersOpen}
					className="reader-search-filters"
				>
					<div className="reader-search-filter-row">
						<span>内容</span>
						<fieldset aria-label="搜索内容类型" className="reader-search-types">
							{(["all", ...searchKinds] as const).map((kind) => (
								<button
									key={kind}
									type="button"
									aria-pressed={state.kind === kind}
									onClick={() => change({ kind })}
								>
									{kind === "all" ? "全部" : searchLabels[kind]}
								</button>
							))}
						</fieldset>
					</div>
					<div className="reader-search-filter-row">
						<span>章节</span>
						<ChapterPicker
							chapters={book.chapters}
							selected={state.chapterIds}
							inactive={!enabled || !state.filtersOpen}
							onChange={(ids) => change({ chapterIds: ids })}
						/>
					</div>
					{(state.kind !== "all" || state.chapterIds !== null) && (
						<button
							type="button"
							className="reader-search-reset"
							onClick={() => change({ kind: "all", chapterIds: null })}
						>
							重置筛选
						</button>
					)}
				</div>
			</div>
			<div
				ref={results}
				className="reader-search-results"
				onScroll={(event) => {
					if (enabled && restoreScroll.current === null)
						scrollTop.current = event.currentTarget.scrollTop;
				}}
			>
				{(openError || props.error) && (
					<p role="alert" className="reader-search-error">
						{(openError ?? props.error)?.message} 请重试打开结果。
					</p>
				)}
				{tooLong ? (
					<p role="alert">查询最多 160 个字符。</p>
				) : !hasChapters ? (
					<p className="reader-search-empty">
						尚未选择章节。请在筛选中选择章节。
					</p>
				) : !current ? (
					<p role="status">
						{composing ? "输入完成后开始搜索。" : "正在搜索…"}
					</p>
				) : (
					<>
						<p className="reader-search-summary" aria-live="polite">
							{groups.some(
								(kind) =>
									!(kind === "original" && !query) &&
									!queries[kind].data &&
									!queries[kind].isError,
							)
								? "正在搜索…"
								: state.kind === "all"
									? `${query ? `原文 ${original.isError ? "暂不可用" : `${original.data?.pages[0]?.total ?? 0} 处`} · ` : ""}资料 ${[segments, translations, bookmarks].some((entry) => entry.isError) ? "部分暂不可用" : `${[segments, translations, bookmarks].reduce((sum, entry) => sum + (entry.data?.pages[0]?.total ?? 0), 0)} 条`}`
									: `${searchLabels[state.kind]} ${queries[state.kind].isError ? "暂不可用" : `${queries[state.kind].data?.pages[0]?.total ?? 0} ${state.kind === "original" ? "处" : "条"}`}`}
						</p>
						{groups.map((kind) => {
							if (kind === "original" && !query)
								return state.kind === "original" ? (
									<p key={kind} className="reader-search-empty">
										输入文字，查找本书中的句子。
									</p>
								) : null;
							const result = queries[kind],
								total = result.data?.pages[0]?.total;
							const items =
								result.data?.pages.flatMap<ReaderSearchHit>(
									(page) => page.items,
								) ?? [];
							const folded = state.kind === "all" && !!state.collapsed[kind];
							const visible = state.kind === "all" ? items.slice(0, 2) : items;
							return (
								<section
									className="reader-search-group"
									key={kind}
									aria-label={searchLabels[kind]}
								>
									<header>
										<h3>
											{state.kind === "all" ? (
												<button
													type="button"
													className="reader-search-group-toggle"
													aria-expanded={!folded}
													aria-controls={`${titleId}-${kind}`}
													onClick={() =>
														onState((previous) => ({
															...previous,
															collapsed: {
																...previous.collapsed,
																[kind]: !folded,
															},
														}))
													}
												>
													<span
														className="reader-search-chevron"
														data-open={!folded}
													>
														<ReaderSearchIcon name="chevron" />
													</span>
													<ReaderSearchIcon name={kind} />
													{searchLabels[kind]}
													<small>
														{total ?? "—"}
														{kind === "original" ? "处" : "条"}
													</small>
												</button>
											) : (
												<span>
													<ReaderSearchIcon name={kind} />
													{searchLabels[kind]}
												</span>
											)}
										</h3>
										{state.kind === "all" && (total ?? 0) > 2 && (
											<button
												type="button"
												className="reader-search-all"
												onClick={() => change({ kind })}
											>
												查看全部 →
											</button>
										)}
									</header>
									<div id={`${titleId}-${kind}`} hidden={folded}>
										{result.isError ? (
											<p role="alert" className="reader-search-error">
												{searchLabels[kind]}读取失败。
												<button
													type="button"
													onClick={() => void result.refetch()}
												>
													重试
												</button>
											</p>
										) : !result.data ? (
											<p role="status" className="reader-search-empty">
												正在读取…
											</p>
										) : total === 0 ? (
											<p className="reader-search-empty">
												{query ? "没有匹配结果" : "暂无记录"}
											</p>
										) : (
											visible.map((hit) => {
												const key =
													hit.kind === "original"
														? `original:${hit.item.chapter_id}:${hit.item.spine_index}:${hit.item.part_index}:${hit.item.start}`
														: `${kind}:${hit.item.id}`;
												const text =
													hit.kind === "original"
														? `${hit.item.before}${hit.item.match}${hit.item.after}`
														: hit.item.snippet;
												return (
													<button
														key={key}
														type="button"
														className="reader-search-hit"
														aria-current={
															state.selectedKey === key ? "true" : undefined
														}
														aria-busy={opening === key}
														onClick={() => void choose(hit, key)}
													>
														<small>
															{hit.item.chapter_title || "原文位置暂不可用"}
														</small>
														<span
															className="reader-search-snippet"
															lang={hit.kind === "original" ? "ja" : undefined}
														>
															<SearchText text={text} query={query} />
														</span>
														{hit.kind === "record" &&
															hit.item.source_excerpt && (
																<span
																	className="reader-search-source"
																	lang="ja"
																>
																	<SearchText
																		text={hit.item.source_excerpt}
																		query={query}
																	/>
																</span>
															)}
														{opening === key && (
															<small role="status">正在打开…</small>
														)}
													</button>
												);
											})
										)}
										{state.kind !== "all" &&
											result.hasNextPage &&
											!result.isError && (
												<button
													type="button"
													className="reader-query-more"
													disabled={result.isFetchingNextPage}
													onClick={() => void result.fetchNextPage()}
												>
													{result.isFetchingNextPage
														? "正在加载…"
														: "继续加载 40 条"}
												</button>
											)}
									</div>
								</section>
							);
						})}
					</>
				)}
			</div>
		</section>
	);
}
