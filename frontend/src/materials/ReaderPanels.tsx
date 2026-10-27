import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon as CatalogIcon } from "../catalog/LibraryTools";
import { useViewActivity } from "../navigation/view-activity";
import {
	type Illustration,
	listIllustrations,
	locateIllustration,
	type Material,
	type Position,
	type Settings,
	searchMaterial,
} from "./api";
import { restoreReaderPanelFocus, useReaderPresence } from "./motion";
import { ReaderIcon } from "./ReaderControls";
import { copyReaderImage, downloadReaderImage } from "./reader-image-actions";
import type { ReaderImageCache } from "./reader-image-cache";
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
type ImagePanelProps = PanelProps & { imageCache: ReaderImageCache };
export type ReaderImageTarget = {
	chapterId: string;
	partIndex: number;
	imageId: number;
	source: { src: string; alt: string };
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
	const { active } = useViewActivity();
	const ref = useRef<HTMLElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const label = useId();
	useEffect(() => {
		if (!active || inactive || closing) return;
		const node = ref.current;
		const previous = document.activeElement;
		const keydown = (event: KeyboardEvent) => {
			if (imageViewer && event.key === "Tab" && node) {
				const focusable = Array.from(
					node.querySelectorAll<HTMLElement>(
						"button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
					),
				);
				if (!focusable.length) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (!first || !last) return;
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
				return;
			}
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
	}, [active, inactive, closing, imageViewer]);
	return (
		<section
			ref={ref}
			role="dialog"
			aria-modal={imageViewer ? "true" : "false"}
			data-exiting={closing}
			inert={inactive || closing}
			aria-hidden={inactive || closing || undefined}
			data-reader-tool
			data-reader-panel-side={imageViewer ? undefined : wide ? "right" : "left"}
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
	const activity = useViewActivity();
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
			activity.active &&
			props.active &&
			!!query &&
			!composing &&
			!tooLong &&
			normalized === query,
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
	cache,
	large = false,
	zoom = 1,
	onOpen,
	onZoom,
	onBackground,
}: {
	item: Illustration;
	cache: ReaderImageCache;
	large?: boolean;
	zoom?: number;
	onOpen?: () => void;
	onZoom?: (value: number) => void;
	onBackground?: () => void;
}) {
	const activity = useViewActivity();
	const [requested, setRequested] = useState(
		() => large || typeof IntersectionObserver === "undefined",
	);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [loaded, setLoaded] = useState<{ key: string; url: string }>();
	const [natural, setNatural] = useState({ width: 1, height: 1 });
	const [available, setAvailable] = useState({ width: 600, height: 600 });
	const stage = useRef<HTMLDivElement>(null);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinch = useRef<{ distance: number; zoom: number } | null>(null);
	const backgroundTap = useRef<{
		id: number;
		x: number;
		y: number;
		moved: boolean;
	} | null>(null);
	useEffect(() => {
		if (!activity.active || requested || large || !stage.current) return;
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
	}, [activity.active, requested, large]);
	useEffect(() => {
		if (!activity.active || !large || !stage.current) return;
		const node = stage.current;
		const observer = new ResizeObserver(() =>
			setAvailable({
				width: Math.max(1, node.clientWidth - 80),
				height: Math.max(1, node.clientHeight - 40),
			}),
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [activity.active, large]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry starts a fresh byte request.
	useEffect(() => {
		const src = item.content_url;
		if (!activity.active || !requested || src.startsWith("data:")) return;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		void cache.get(src, controller.signal).then(
			(blob) => {
				if (controller.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setLoaded({ key: src, url: objectUrl });
			},
			() => {
				if (!controller.signal.aborted) setFailed(true);
			},
		);
		return () => {
			controller.abort();
			if (objectUrl) {
				URL.revokeObjectURL(objectUrl);
				setLoaded((previous) =>
					previous?.url === objectUrl ? undefined : previous,
				);
			}
		};
	}, [activity.active, requested, item.content_url, cache, attempt]);
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
			onPointerDown={
				large
					? (event) => {
							if ((event.target as Element).closest("button, a, input")) return;
							if (event.pointerType === "mouse" && event.button !== 0) return;
							const target = event.target as Element;
							if (
								pointers.current.size === 0 &&
								(target === event.currentTarget ||
									target.classList.contains("reader-image-canvas"))
							)
								backgroundTap.current = {
									id: event.pointerId,
									x: event.clientX,
									y: event.clientY,
									moved: false,
								};
							else backgroundTap.current = null;
							event.currentTarget.setPointerCapture(event.pointerId);
							pointers.current.set(event.pointerId, {
								x: event.clientX,
								y: event.clientY,
							});
							const points = [...pointers.current.values()];
							if (points.length === 2 && points[0] && points[1])
								pinch.current = {
									distance: Math.hypot(
										points[0].x - points[1].x,
										points[0].y - points[1].y,
									),
									zoom,
								};
						}
					: undefined
			}
			onPointerMove={
				large
					? (event) => {
							const previous = pointers.current.get(event.pointerId);
							if (!previous) return;
							if (
								backgroundTap.current?.id === event.pointerId &&
								Math.hypot(
									event.clientX - backgroundTap.current.x,
									event.clientY - backgroundTap.current.y,
								) > 5
							)
								backgroundTap.current.moved = true;
							pointers.current.set(event.pointerId, {
								x: event.clientX,
								y: event.clientY,
							});
							const points = [...pointers.current.values()];
							if (
								points.length === 2 &&
								points[0] &&
								points[1] &&
								pinch.current?.distance
							) {
								const distance = Math.hypot(
									points[0].x - points[1].x,
									points[0].y - points[1].y,
								);
								onZoom?.(
									Math.max(
										0.5,
										Math.min(
											4,
											(pinch.current.zoom * distance) / pinch.current.distance,
										),
									),
								);
							} else if (points.length === 1) {
								event.currentTarget.scrollLeft -= event.clientX - previous.x;
								event.currentTarget.scrollTop -= event.clientY - previous.y;
							}
						}
					: undefined
			}
			onPointerUp={
				large
					? (event) => {
							if (
								backgroundTap.current?.id === event.pointerId &&
								!backgroundTap.current.moved
							)
								onBackground?.();
							backgroundTap.current = null;
							pointers.current.delete(event.pointerId);
							pinch.current = null;
						}
					: undefined
			}
			onPointerCancel={
				large
					? (event) => {
							backgroundTap.current = null;
							pointers.current.delete(event.pointerId);
							pinch.current = null;
						}
					: undefined
			}
		>
			{failed ? (
				<div className="reader-query-error">
					图片加载失败
					<button
						type="button"
						onClick={() => {
							cache.delete(item.content_url);
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
					{requested &&
					(item.content_url.startsWith("data:") ||
						loaded?.key === item.content_url) ? (
						<img
							key={attempt}
							src={
								item.content_url.startsWith("data:")
									? item.content_url
									: loaded?.url
							}
							loading={large ? "eager" : "lazy"}
							decoding="async"
							draggable={false}
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
	onOpenGallery,
	initialSource,
	lookupError,
	onRetryLookup,
	closing = false,
}: {
	ordinal: number | null;
	total: number | null;
	props: ImagePanelProps;
	onOrdinal: (ordinal: number) => void;
	onClose: () => void;
	onOpenGallery?: (ordinal: number) => void;
	initialSource?: { src: string; alt: string };
	lookupError?: boolean;
	onRetryLookup?: () => void;
	closing?: boolean;
}) {
	const activity = useViewActivity();
	const [zoom, setZoom] = useState(1);
	const [feedback, setFeedback] = useState("");
	const actionController = useRef<AbortController | null>(null);
	const actionIdentity = initialSource?.src ?? ordinal;
	// biome-ignore lint/correctness/useExhaustiveDependencies: changing images cancels the previous image's pending operations.
	useEffect(() => {
		if (closing || props.closing) return;
		const controller = new AbortController();
		actionController.current = controller;
		return () => {
			controller.abort();
			actionController.current = null;
		};
	}, [actionIdentity, closing, props.closing]);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		if (closing || props.closing) return;
		props.onViewerEscape?.(() => closeRef.current());
		return () => props.onViewerEscape?.(null);
	}, [props.onViewerEscape, props.closing, closing]);
	const cachedItem =
		ordinal === null ? undefined : props.imageCache.item(ordinal);
	const image = useQuery({
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"illustration",
			ordinal,
		],
		enabled: activity.active && ordinal !== null && !cachedItem,
		queryFn: async ({ signal }) => {
			if (ordinal === null) throw new Error("图片尚未定位");
			const page = await listIllustrations(
				props.materialId,
				props.versionId,
				ordinal,
				1,
				signal,
			);
			signal.throwIfAborted();
			props.imageCache.remember(page.items, page.total);
			return page;
		},
		retry: false,
		gcTime: 0,
	});
	const item = cachedItem ?? image.data?.items[0];
	const displayItem: Illustration | undefined = initialSource
		? {
				ordinal: ordinal ?? -1,
				chapter_id: item?.chapter_id ?? "",
				chapter_title: item?.chapter_title ?? "",
				part_index: item?.part_index ?? 0,
				spine_index: item?.spine_index ?? 0,
				resource_id: item?.resource_id ?? "",
				image_id: item?.image_id ?? 0,
				alt: initialSource.alt,
				content_url: initialSource.src,
			}
		: item;

	return (
		<div
			className="reader-image-overlay"
			data-exiting={closing || props.closing}
		>
			<button
				type="button"
				className="reader-image-backdrop"
				aria-label="关闭图片查看器"
				tabIndex={-1}
				onClick={onClose}
			/>
			<ReaderQueryPanel
				title={
					ordinal === null || total === null
						? "查看插图"
						: `插图 ${ordinal + 1} / ${total}`
				}
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
							disabled={!displayItem}
							onClick={() => {
								if (!displayItem || !actionController.current) return;
								const signal = actionController.current.signal;
								setFeedback("");
								void copyReaderImage(
									props.imageCache,
									displayItem.content_url,
									signal,
								).then(
									() => {
										if (!signal.aborted) setFeedback("图片已复制");
									},
									() => {
										if (!signal.aborted)
											setFeedback("复制失败，请检查浏览器权限或下载图片。");
									},
								);
							}}
						>
							复制图片
						</button>
						<button
							type="button"
							disabled={!displayItem}
							onClick={() => {
								if (!displayItem || !actionController.current) return;
								const signal = actionController.current.signal;
								setFeedback("");
								void downloadReaderImage(
									props.imageCache,
									displayItem.content_url,
									ordinal,
									signal,
								).then(
									() => {
										if (!signal.aborted) setFeedback("正在下载图片");
									},
									() => {
										if (!signal.aborted) setFeedback("下载失败，请重试。");
									},
								);
							}}
						>
							下载
						</button>
						{onOpenGallery && (
							<button
								type="button"
								disabled={!item || ordinal === null}
								onClick={() => {
									if (ordinal !== null) onOpenGallery(ordinal);
								}}
							>
								在图库中查看
							</button>
						)}
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
				{feedback && (
					<p className="reader-image-feedback" role="status">
						{feedback}
					</p>
				)}
				<NavigationFailure
					error={props.navigationError}
					retryHint="请再次点击“前往书中位置”重试；浏览插图不会移动正文。"
				/>
				{lookupError && (
					<div role="alert" className="reader-query-error">
						无法定位该插图。
						<button type="button" onClick={onRetryLookup}>
							重试
						</button>
					</div>
				)}
				{!displayItem && image.isPending && (
					<p className="reader-query-status">正在加载插图…</p>
				)}
				{!displayItem && image.isError && (
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
				{displayItem && (
					<IllustrationImage
						key={initialSource ? "original" : displayItem.ordinal}
						item={displayItem}
						cache={props.imageCache}
						large
						zoom={zoom}
						onZoom={setZoom}
						onBackground={onClose}
					/>
				)}
				<div className="reader-image-navigation">
					<button
						type="button"
						disabled={ordinal === null || ordinal === 0}
						onClick={() => {
							actionController.current?.abort();
							setFeedback("");
							setZoom(1);
							if (ordinal !== null) onOrdinal(ordinal - 1);
						}}
						aria-label="上一张插图"
						title="上一张插图"
					>
						‹
					</button>
					<button
						type="button"
						disabled={
							ordinal === null || total === null || ordinal >= total - 1
						}
						onClick={() => {
							actionController.current?.abort();
							setFeedback("");
							setZoom(1);
							if (ordinal !== null) onOrdinal(ordinal + 1);
						}}
						aria-label="下一张插图"
						title="下一张插图"
					>
						›
					</button>
				</div>
			</ReaderQueryPanel>
		</div>
	);
}

export function ReaderDirectImageViewer(
	props: ImagePanelProps & {
		target: ReaderImageTarget;
		onOpenGallery: (ordinal: number) => void;
	},
) {
	const activity = useViewActivity();
	const [ordinal, setOrdinal] = useState<number | null>(null);
	const locate = useQuery({
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"find-illustration",
			props.target.chapterId,
			props.target.partIndex,
			props.target.imageId,
		],
		enabled: activity.active,
		initialData: () =>
			props.imageCache.locate(
				props.target.chapterId,
				props.target.partIndex,
				props.target.imageId,
			),
		staleTime: Infinity,
		gcTime: 0,
		queryFn: async ({ signal }) => {
			const page = await locateIllustration(
				props.materialId,
				props.versionId,
				props.target.chapterId,
				props.target.partIndex,
				props.target.imageId,
				signal,
			);
			const item = page.items[0];
			signal.throwIfAborted();
			if (!item) throw new Error("该图已不可用");
			props.imageCache.remember([item], page.total);
			return { item, total: page.total };
		},
		retry: false,
	});
	useEffect(() => {
		if (locate.data)
			props.imageCache.rememberSource(
				locate.data.item.content_url,
				props.target.source.src,
			);
	}, [locate.data, props.imageCache, props.target.source.src]);
	return (
		<ImageViewer
			ordinal={ordinal ?? locate.data?.item.ordinal ?? null}
			total={locate.data?.total ?? null}
			props={props}
			initialSource={
				ordinal === null || ordinal === locate.data?.item.ordinal
					? props.target.source
					: undefined
			}
			lookupError={locate.isError && ordinal === null}
			onRetryLookup={() => {
				void locate.refetch();
			}}
			onOrdinal={setOrdinal}
			onClose={props.onClose}
			onOpenGallery={props.onOpenGallery}
		/>
	);
}

export function ReaderGalleryPanel(
	props: ImagePanelProps & {
		bookTitle?: string;
		initialOrdinal?: number;
	},
) {
	const activity = useViewActivity();
	const [offset, setOffset] = useState(
		() =>
			Math.floor((props.initialOrdinal ?? 0) / READER_QUERY_PAGE_SIZE) *
			READER_QUERY_PAGE_SIZE,
	);
	const [ordinal, setOrdinal] = useState<number | null>(null);
	const grid = useRef<HTMLDivElement>(null);
	const highlightedScrolled = useRef(false);
	const [highlighted, setHighlighted] = useState(props.initialOrdinal);
	const imageView = useReaderPresence(ordinal);
	const gallery = useQuery({
		enabled: activity.active,
		queryKey: [
			"materials",
			props.materialId,
			props.versionId,
			"illustrations",
			offset,
		],
		queryFn: async ({ signal }) => {
			const page = await listIllustrations(
				props.materialId,
				props.versionId,
				offset,
				READER_QUERY_PAGE_SIZE,
				signal,
			);
			signal.throwIfAborted();
			props.imageCache.remember(page.items, page.total);
			return page;
		},
		retry: false,
	});
	const total = gallery.data?.total ?? 0;
	useEffect(() => {
		if (
			highlightedScrolled.current ||
			highlighted === undefined ||
			!gallery.data ||
			ordinal !== null
		)
			return;
		const card = grid.current?.querySelector<HTMLElement>(
			`[data-illustration-ordinal="${highlighted}"]`,
		);
		if (!card) return;
		highlightedScrolled.current = true;
		card.scrollIntoView({ block: "nearest" });
		card
			?.querySelector<HTMLButtonElement>(".reader-gallery-open")
			?.focus({ preventScroll: true });
	}, [gallery.data, highlighted, ordinal]);
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
						{gallery.data
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
				{gallery.data?.total === 0 && (
					<p className="reader-query-status">本书暂无可查看插图</p>
				)}
				<div className="reader-gallery-grid" ref={grid}>
					{gallery.data?.items.map((item) => (
						<div
							key={item.ordinal}
							className="reader-gallery-card"
							data-illustration-ordinal={item.ordinal}
							data-selected={highlighted === item.ordinal || undefined}
						>
							<IllustrationImage
								item={item}
								cache={props.imageCache}
								onOpen={() => {
									setHighlighted(undefined);
									props.onCancelNavigation?.();
									setOrdinal(item.ordinal);
								}}
							/>
							<button
								type="button"
								className="reader-gallery-open"
								onClick={() => {
									setHighlighted(undefined);
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
						props.onCancelNavigation?.();
						setOrdinal(next);
					}}
					onClose={() => {
						props.onCancelNavigation?.();
						setOrdinal(null);
					}}
				/>
			)}
		</>
	);
}
