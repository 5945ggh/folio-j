import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon as CatalogIcon } from "../catalog/LibraryTools";
import {
	type Illustration,
	listIllustrations,
	type Material,
	type Position,
	type Settings,
	searchMaterial,
} from "./api";
import { restoreReaderPanelFocus, useReaderPresence } from "./motion";
import { ReaderIcon } from "./ReaderControls";
import {
	fitImageSize,
	normalizeReaderQuery,
	READER_QUERY_PAGE_SIZE,
	READER_SEARCH_DELAY,
	readerQueryTooLong,
} from "./reader-panel-logic";
import "./reader-panels.css";

type PanelProps = {
	materialId: string;
	versionId: string;
	settings: Settings;
	navigationError?: Error | null;
	onCancelNavigation?: () => void;
	onViewerEscape?: (close: (() => void) | null) => void;
	onClose: () => void;
	inactive?: boolean;
	closing?: boolean;
	onNavigate: (
		target: Position,
		highlight?: { start: number; end: number },
	) => void;
};
export type ReaderImageTarget = {
	chapterId: string;
	partIndex: number;
	imageId: number;
};

/** Non-modal tools leave the reading surface and Reader toolbar available. */
function ReaderQueryPanel({
	children,
	title,
	subtitle,
	fixedContent,
	wide = false,
	imageViewer = false,
	inactive = false,
	closing = false,
	onClose,
}: {
	children: ReactNode;
	title: string;
	subtitle?: ReactNode;
	fixedContent?: ReactNode;
	wide?: boolean;
	imageViewer?: boolean;
	inactive?: boolean;
	closing?: boolean;
	onClose: () => void;
}) {
	const ref = useRef<HTMLElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const label = useId();
	useEffect(() => {
		if (closing) return;
		const node = ref.current;
		const previous = document.activeElement;
		const keydown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
		};
		node?.addEventListener("keydown", keydown);
		const initialFocus =
			node?.querySelector<HTMLElement>(
				'[role="tabpanel"]:not([hidden]) input',
			) ?? node?.querySelector<HTMLElement>("button");
		initialFocus?.focus({ preventScroll: true });
		return () => {
			node?.removeEventListener("keydown", keydown);
			if (node) restoreReaderPanelFocus(node, previous);
		};
	}, [closing]);
	return (
		<section
			ref={ref}
			role="dialog"
			aria-modal="false"
			data-exiting={closing}
			inert={inactive || closing}
			aria-hidden={inactive || closing || undefined}
			data-reader-tool
			data-reader-panel-side={wide ? "right" : "left"}
			className={`reader-query-dialog ${wide ? "reader-query-wide" : "reader-query-side"} ${imageViewer ? "reader-query-image-viewer" : ""} ${subtitle ? "reader-query-with-subtitle" : ""} ${fixedContent ? "reader-query-navigation" : ""}`}
			aria-labelledby={label}
		>
			<header className="reader-query-heading">
				<div>
					<h2 id={label}>{title}</h2>
					{subtitle && <p className="reader-query-subtitle">{subtitle}</p>}
				</div>
				<button
					type="button"
					aria-label={`关闭${title}`}
					className="reader-panel-close"
					data-tooltip={`关闭${title}`}
					onClick={onClose}
				>
					×
				</button>
			</header>
			{fixedContent && <div className="reader-query-fixed">{fixedContent}</div>}
			<div className="reader-query-content">{children}</div>
		</section>
	);
}

function NavigationFailure({
	error,
	retryHint,
}: {
	error?: Error | null;
	retryHint: string;
}) {
	return error ? (
		<p className="reader-navigation-error" role="alert">
			定位失败：{error.message}
			<br />
			{retryHint}
		</p>
	) : null;
}

export function ReaderNavigationPanel(
	props: PanelProps & {
		bookTitle: string;
		chapters: Material["chapters"];
		chapterId: string;
		progress: number | null;
		chapterProgress: ReadonlyMap<string, number | null>;
		onBeginning: () => void;
		tab: "toc" | "search";
		onTab: (tab: "toc" | "search") => void;
		onChoose: (chapterId: string) => void;
	},
) {
	const id = useId();
	const tabs = ["toc", "search"] as const;
	const current = props.chapters.find(
		(chapter) => chapter.id === props.chapterId,
	);
	return (
		<ReaderQueryPanel
			title="书内导航"
			onClose={props.onClose}
			inactive={props.inactive}
			closing={props.closing}
			fixedContent={
				<>
					<div className="reader-navigation-book">
						<strong lang="ja">{props.bookTitle}</strong>
						<span>
							正在阅读 · {current?.title}
							{props.progress === null
								? ""
								: ` · 章内 ${Math.round(props.progress * 100)}%`}
						</span>
						<button
							type="button"
							className="reader-chapter-beginning"
							onClick={props.onBeginning}
						>
							回到章首
						</button>
					</div>
					<div
						className="reader-query-tabs"
						data-active-tab={props.tab}
						role="tablist"
						aria-label="导航方式"
						onKeyDown={(event) => {
							let next: "toc" | "search";
							if (event.key === "ArrowRight" || event.key === "ArrowLeft")
								next = props.tab === "toc" ? "search" : "toc";
							else if (event.key === "Home") next = "toc";
							else if (event.key === "End") next = "search";
							else return;
							event.preventDefault();
							props.onTab(next);
							event.currentTarget
								.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
								?.focus();
						}}
					>
						{tabs.map((tab) => (
							<button
								key={tab}
								type="button"
								role="tab"
								data-tab={tab}
								id={`${id}-${tab}-tab`}
								aria-controls={`${id}-${tab}-panel`}
								aria-selected={props.tab === tab}
								tabIndex={props.tab === tab ? 0 : -1}
								onClick={() => props.onTab(tab)}
							>
								{tab === "toc" ? (
									<ReaderIcon name="toc" />
								) : (
									<CatalogIcon name="search" />
								)}
								{tab === "toc" ? "目录" : "搜索"}
							</button>
						))}
					</div>
				</>
			}
		>
			<div
				id={`${id}-toc-panel`}
				role="tabpanel"
				aria-labelledby={`${id}-toc-tab`}
				hidden={props.tab !== "toc"}
			>
				<NavigationFailure
					error={props.navigationError}
					retryHint="请再次点击章节重试，或继续阅读。"
				/>
				<p className="reader-toc-hint">显示各章上次停留位置</p>
				<ol className="reader-toc">
					{props.chapters.map((chapter) => (
						<li key={chapter.id}>
							<button
								type="button"
								aria-label={`${chapter.title}，${!props.chapterProgress.has(chapter.id) ? "尚无停留记录" : props.chapterProgress.get(chapter.id) == null ? "已记录上次停留位置" : `上次停留位置 ${Math.round((props.chapterProgress.get(chapter.id) ?? 0) * 100)}%`}`}
								aria-current={
									chapter.id === props.chapterId ? "location" : undefined
								}
								style={{
									paddingInlineStart: `${Math.max(0, chapter.level - 1) * 12 + 12}px`,
								}}
								onClick={() => props.onChoose(chapter.id)}
							>
								<span>{chapter.title}</span>
								<small className="reader-toc-progress">
									{!props.chapterProgress.has(chapter.id)
										? ""
										: props.chapterProgress.get(chapter.id) == null
											? "有记录"
											: `${Math.round((props.chapterProgress.get(chapter.id) ?? 0) * 100)}%`}
								</small>
							</button>
						</li>
					))}
				</ol>
			</div>
			<div
				id={`${id}-search-panel`}
				role="tabpanel"
				aria-labelledby={`${id}-search-tab`}
				hidden={props.tab !== "search"}
			>
				<ReaderSearchContent {...props} active={props.tab === "search"} />
			</div>
		</ReaderQueryPanel>
	);
}

function ReaderSearchContent(props: PanelProps & { active: boolean }) {
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [composing, setComposing] = useState(false);
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (props.active && document.activeElement?.getAttribute("role") !== "tab")
			inputRef.current?.focus({ preventScroll: true });
	}, [props.active]);
	const normalized = normalizeReaderQuery(input);
	const tooLong = readerQueryTooLong(input);
	useEffect(() => {
		if (composing) return;
		const timeout = window.setTimeout(
			() => setQuery(tooLong ? "" : normalized),
			READER_SEARCH_DELAY,
		);
		return () => window.clearTimeout(timeout);
	}, [normalized, tooLong, composing]);
	const result = useInfiniteQuery({
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"reader-search",
			query,
		],
		initialPageParam: 0,
		queryFn: ({ pageParam, signal }) =>
			searchMaterial(
				props.materialId,
				props.versionId,
				query,
				pageParam,
				signal,
			),
		getNextPageParam: (last) =>
			last.offset + last.items.length < last.total
				? last.offset + last.items.length
				: undefined,
		enabled:
			props.active && !!query && !composing && !tooLong && normalized === query,
		retry: false,
	});
	const current = !composing && normalized === query && !tooLong;
	const pages = current ? result.data?.pages : undefined;
	return (
		<div className="reader-query-body">
			<NavigationFailure
				error={props.navigationError}
				retryHint="请再次点击搜索结果重试，或关闭面板继续阅读。"
			/>
			<label className="reader-query-hidden-label" htmlFor={inputId}>
				搜索本书原文
			</label>
			<input
				id={inputId}
				ref={inputRef}
				autoComplete="off"
				type="search"
				placeholder="搜索本书原文…"
				value={input}
				onChange={(event) => {
					props.onCancelNavigation?.();
					setInput(event.target.value);
				}}
				onCompositionStart={() => {
					props.onCancelNavigation?.();
					setComposing(true);
				}}
				onCompositionEnd={(event) => {
					setComposing(false);
					setInput(event.currentTarget.value);
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
			<p className="reader-query-help">
				字面查找原文，不搜索注音；不同资源或章节之间不拼接匹配。
			</p>
			<p aria-live="polite" className="reader-query-summary">
				{tooLong
					? "查询最多 160 个字符。"
					: !normalized
						? "输入文字，查找本书中的句子。"
						: composing
							? "输入完成后开始搜索。"
							: !current || result.isPending
								? "正在搜索…"
								: pages
									? `找到 ${pages[0]?.total ?? 0} 处`
									: ""}
			</p>
			{current && result.isError && (
				<div role="alert" className="reader-query-error">
					搜索失败，已保留查询。
					<button
						type="button"
						onClick={() => {
							void result.refetch();
						}}
					>
						重试
					</button>
				</div>
			)}
			<div className="reader-query-results">
				{pages
					?.flatMap((page) => page.items)
					.map((hit) => (
						<button
							type="button"
							className="reader-query-hit"
							key={`${hit.chapter_id}:${hit.part_index}:${hit.spine_index}:${hit.resource_id}:${hit.start}`}
							onClick={() =>
								props.onNavigate(
									{
										version_id: props.versionId,
										chapter_id: hit.chapter_id,
										part_index: hit.part_index,
										resource_id: hit.resource_id,
										kind: "text",
										offset: hit.start,
										at_chapter_end: false,
										settings: props.settings,
									},
									{ start: hit.start, end: hit.end },
								)
							}
						>
							<small>{hit.chapter_title}</small>
							<span lang="ja">
								{hit.before}
								<mark>{hit.match}</mark>
								{hit.after}
							</span>
						</button>
					))}
			</div>
			{current && result.hasNextPage && (
				<button
					type="button"
					className="reader-query-more"
					disabled={result.isFetchingNextPage}
					onClick={() => {
						void result.fetchNextPage();
					}}
				>
					{result.isFetchingNextPage ? "正在加载…" : "继续加载 40 条"}
				</button>
			)}
		</div>
	);
}

function IllustrationImage({
	item,
	large = false,
	zoom = 1,
	onOpen,
}: {
	item: Illustration;
	large?: boolean;
	zoom?: number;
	onOpen?: () => void;
}) {
	const [requested, setRequested] = useState(
		() => large || typeof IntersectionObserver === "undefined",
	);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [natural, setNatural] = useState({ width: 1, height: 1 });
	const [available, setAvailable] = useState({ width: 600, height: 600 });
	const stage = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (requested || large || !stage.current) return;
		const node = stage.current;
		let active = true;
		const observer = new IntersectionObserver(
			(entries) => {
				if (active && entries.some((entry) => entry.isIntersecting)) {
					setRequested(true);
					observer.disconnect();
				}
			},
			{ root: node.closest(".reader-query-content"), rootMargin: "300px" },
		);
		observer.observe(node);
		return () => {
			active = false;
			observer.disconnect();
		};
	}, [requested, large]);
	useEffect(() => {
		if (!large || !stage.current) return;
		const node = stage.current;
		const observer = new ResizeObserver(() =>
			setAvailable({
				width: Math.max(1, node.clientWidth - 80),
				height: Math.max(1, node.clientHeight - 40),
			}),
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [large]);
	const size = fitImageSize(
		natural.width,
		natural.height,
		available.width,
		available.height,
		zoom,
	);
	return (
		<div
			ref={stage}
			className={large ? "reader-image-stage" : "reader-gallery-image"}
		>
			{failed ? (
				<div className="reader-query-error">
					图片加载失败
					<button
						type="button"
						onClick={() => {
							setFailed(false);
							setAttempt((value) => value + 1);
						}}
					>
						重试此图
					</button>
				</div>
			) : (
				<div
					className={large ? "reader-image-canvas" : undefined}
					style={
						large
							? {
									minWidth: "100%",
									minHeight: "100%",
									width: size.width + 80,
									height: size.height + 40,
								}
							: undefined
					}
				>
					{requested ? (
						<img
							key={attempt}
							src={`${item.content_url}${item.content_url.includes("?") ? "&" : "?"}reader_attempt=${attempt}`}
							loading={large ? "eager" : "lazy"}
							decoding="async"
							alt={item.alt || `插图 ${item.ordinal + 1}`}
							onError={() => setFailed(true)}
							onLoad={(event) =>
								setNatural({
									width: event.currentTarget.naturalWidth,
									height: event.currentTarget.naturalHeight,
								})
							}
							style={large ? size : undefined}
						/>
					) : (
						<span className="reader-gallery-placeholder" aria-hidden="true">
							浏览时加载
						</span>
					)}
				</div>
			)}
			{!large && !failed && (
				<button
					className="reader-gallery-image-open"
					type="button"
					aria-label={`打开插图 ${item.ordinal + 1}：${item.alt || item.chapter_title}`}
					onClick={onOpen}
				/>
			)}
		</div>
	);
}

function ImageViewer({
	ordinal,
	total,
	props,
	onOrdinal,
	onClose,
	closing = false,
}: {
	ordinal: number;
	total: number;
	props: PanelProps;
	onOrdinal: (ordinal: number) => void;
	onClose: () => void;
	closing?: boolean;
}) {
	const [zoom, setZoom] = useState(1);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		if (closing || props.closing) return;
		props.onViewerEscape?.(() => closeRef.current());
		return () => props.onViewerEscape?.(null);
	}, [props.onViewerEscape, props.closing, closing]);
	const image = useQuery({
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"illustration",
			ordinal,
		],
		queryFn: ({ signal }) =>
			listIllustrations(props.materialId, props.versionId, ordinal, 1, signal),
		retry: false,
	});
	const item = image.data?.items[0];

	return (
		<ReaderQueryPanel
			title={`插图 ${ordinal + 1} / ${total}`}
			wide
			imageViewer
			inactive={props.inactive}
			closing={closing || props.closing}
			onClose={onClose}
		>
			<div className="reader-image-controls">
				<span>{item?.chapter_title}</span>
				<div>
					<button type="button" onClick={() => setZoom(1)}>
						适合窗口
					</button>
					<button
						type="button"
						aria-label="缩小"
						title="缩小"
						disabled={zoom <= 0.5}
						onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
					>
						−
					</button>
					<output>{Math.round(zoom * 100)}%</output>
					<button
						type="button"
						aria-label="放大"
						title="放大"
						disabled={zoom >= 4}
						onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
					>
						＋
					</button>
					<button
						type="button"
						disabled={!item}
						onClick={() => {
							if (item)
								props.onNavigate({
									version_id: props.versionId,
									chapter_id: item.chapter_id,
									part_index: item.part_index,
									resource_id: item.resource_id,
									kind: "image",
									image_id: item.image_id,
									image_progress: 0,
									at_chapter_end: false,
									settings: props.settings,
								});
						}}
					>
						前往书中位置
					</button>
				</div>
			</div>
			<NavigationFailure
				error={props.navigationError}
				retryHint="请再次点击“前往书中位置”重试；浏览插图不会移动正文。"
			/>
			{image.isPending && <p className="reader-query-status">正在加载插图…</p>}
			{image.isError && (
				<div className="reader-query-error" role="alert">
					无法读取插图。
					<button
						type="button"
						onClick={() => {
							void image.refetch();
						}}
					>
						重试
					</button>
				</div>
			)}
			{item && (
				<IllustrationImage key={item.ordinal} item={item} large zoom={zoom} />
			)}
			<div className="reader-image-navigation">
				<button
					type="button"
					disabled={ordinal === 0}
					onClick={() => {
						setZoom(1);
						onOrdinal(ordinal - 1);
					}}
					aria-label="上一张插图"
					title="上一张插图"
				>
					‹
				</button>
				<button
					type="button"
					disabled={ordinal >= total - 1}
					onClick={() => {
						setZoom(1);
						onOrdinal(ordinal + 1);
					}}
					aria-label="下一张插图"
					title="下一张插图"
				>
					›
				</button>
			</div>
		</ReaderQueryPanel>
	);
}

export function ReaderGalleryPanel(
	props: PanelProps & { bookTitle?: string; initialImage?: ReaderImageTarget },
) {
	const [offset, setOffset] = useState(0);
	const [ordinal, setOrdinal] = useState<number | null>(null);
	const imageView = useReaderPresence(ordinal);
	const [initialHandled, setInitialHandled] = useState(false);
	const initial = props.initialImage;
	const gallery = useQuery({
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"illustrations",
			offset,
		],
		queryFn: ({ signal }) =>
			listIllustrations(
				props.materialId,
				props.versionId,
				offset,
				READER_QUERY_PAGE_SIZE,
				signal,
			),
		retry: false,
	});
	const locate = useQuery({
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"find-illustration",
			initial?.chapterId,
			initial?.partIndex,
			initial?.imageId,
		],
		enabled: !!initial && !initialHandled,
		queryFn: async ({ signal }) => {
			let cursor = 0;
			while (!signal.aborted) {
				const page = await listIllustrations(
					props.materialId,
					props.versionId,
					cursor,
					READER_QUERY_PAGE_SIZE,
					signal,
				);
				const found = page.items.find(
					(item) =>
						item.chapter_id === initial?.chapterId &&
						item.part_index === initial.partIndex &&
						item.image_id === initial.imageId,
				);
				if (found) return { ordinal: found.ordinal, total: page.total };
				cursor += page.items.length;
				if (!page.items.length || cursor >= page.total)
					throw new Error("该图已不可用");
			}
			throw new Error("已取消图片定位");
		},
		retry: false,
	});
	useEffect(() => {
		if (!locate.data || initialHandled) return;
		setOrdinal(locate.data.ordinal);
		setOffset(
			Math.floor(locate.data.ordinal / READER_QUERY_PAGE_SIZE) *
				READER_QUERY_PAGE_SIZE,
		);
		setInitialHandled(true);
	}, [locate.data, initialHandled]);
	const total = gallery.data?.total ?? locate.data?.total ?? 0;
	return (
		<>
			<ReaderQueryPanel
				title="插图库"
				wide
				inactive={props.inactive || ordinal !== null}
				closing={props.closing}
				onClose={props.onClose}
				subtitle={
					<>
						<span lang="ja">{props.bookTitle}</span> · 按书中顺序 ·{" "}
						{gallery.data || locate.data
							? `${total} 张`
							: gallery.isError
								? "清单暂不可用"
								: "正在读取清单…"}
						{" · 浏览插图不会改变阅读位置"}
					</>
				}
			>
				{ordinal === null && (
					<NavigationFailure
						error={props.navigationError}
						retryHint="请打开插图后再次点击“前往书中位置”重试，或关闭图库继续阅读。"
					/>
				)}
				{gallery.isPending && (
					<p className="reader-query-status">正在加载图库…</p>
				)}
				{gallery.isError && (
					<div role="alert" className="reader-query-error">
						图库加载失败。
						<button
							type="button"
							onClick={() => {
								void gallery.refetch();
							}}
						>
							重试
						</button>
					</div>
				)}
				{initial && !initialHandled && locate.isPending && (
					<p className="reader-query-status">正在定位书中插图…</p>
				)}
				{!initialHandled && locate.isError && (
					<div role="alert" className="reader-query-error">
						无法定位该插图。
						<button
							type="button"
							onClick={() => {
								void locate.refetch();
							}}
						>
							重试
						</button>
					</div>
				)}
				{gallery.data?.total === 0 && (
					<p className="reader-query-status">本书暂无可查看插图</p>
				)}
				<div className="reader-gallery-grid">
					{gallery.data?.items.map((item) => (
						<div key={item.ordinal} className="reader-gallery-card">
							<IllustrationImage
								item={item}
								onOpen={() => {
									setInitialHandled(true);
									props.onCancelNavigation?.();
									setOrdinal(item.ordinal);
								}}
							/>
							<button
								type="button"
								className="reader-gallery-open"
								onClick={() => {
									setInitialHandled(true);
									props.onCancelNavigation?.();
									setOrdinal(item.ordinal);
								}}
							>
								<span className="reader-gallery-caption">
									<strong>{item.alt || `插图 ${item.ordinal + 1}`}</strong>
									<span>{item.ordinal + 1}</span>
								</span>
								<span className="reader-gallery-chapter">
									{item.chapter_title}
								</span>
							</button>
						</div>
					))}
				</div>
				{total > READER_QUERY_PAGE_SIZE && (
					<nav className="reader-gallery-pages" aria-label="图库分页">
						<button
							type="button"
							disabled={offset === 0 || gallery.isFetching}
							onClick={() => {
								setInitialHandled(true);
								props.onCancelNavigation?.();
								setOffset((value) =>
									Math.max(0, value - READER_QUERY_PAGE_SIZE),
								);
							}}
						>
							上一页
						</button>
						<span>
							{offset + 1}–{Math.min(offset + READER_QUERY_PAGE_SIZE, total)} /{" "}
							{total}
						</span>
						<button
							type="button"
							disabled={
								offset + READER_QUERY_PAGE_SIZE >= total || gallery.isFetching
							}
							onClick={() => {
								setInitialHandled(true);
								props.onCancelNavigation?.();
								setOffset((value) => value + READER_QUERY_PAGE_SIZE);
							}}
						>
							下一页
						</button>
					</nav>
				)}
			</ReaderQueryPanel>
			{imageView.value !== null && (
				<ImageViewer
					ordinal={imageView.value}
					closing={imageView.exiting}
					total={total}
					props={props}
					onOrdinal={(next) => {
						setInitialHandled(true);
						props.onCancelNavigation?.();
						setOrdinal(next);
					}}
					onClose={() => {
						setInitialHandled(true);
						props.onCancelNavigation?.();
						setOrdinal(null);
					}}
				/>
			)}
		</>
	);
}
