import "./reader-r1.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Icon as CatalogIcon } from "../catalog/LibraryTools";
import { getSource, queries, RequestError } from "../content";
import { returnDestination } from "../navigation";
import { InlineError } from "../Shared";
import {
	type Chapter,
	getChapter,
	getMaterial,
	getUsage,
	type Material,
	type MaterialUsage,
	materialKeys,
	type Position,
	recordOpened,
	type Settings,
	savePosition,
	setUsage,
	usageKey,
} from "./api";
import {
	htmlEscape,
	nearestText,
	type Projection,
	projectPart,
	textRect,
} from "./dom";
import { createFocusController, isReaderFrameTarget } from "./focus";
import { highlightRange } from "./highlight";
import { READER_EXIT_MS, useReaderPresence } from "./motion";
import { cacheSavedPosition, registerPositionWriter } from "./persistence";
import {
	anchorBeforeLayout,
	currentSurface,
	imageCoordinate,
	imageFraction,
	PositionQueue,
	scrollProgress,
} from "./position";
import {
	type BookUiPreferences,
	DEFAULT_BOOK_UI,
	DEFAULT_READER_UI,
	type ReaderUiPreferences,
	readBookUiPreferences,
	readReaderUiPreferences,
	resolveReaderTheme,
	writeBookUiPreferences,
	writeReaderUiPreferences,
} from "./preferences";
import { applyFramePresentation, normalizeFrameImages } from "./presentation";
import { ReaderIcon, ReaderPanel, ReaderSettings } from "./ReaderControls";
import { ReaderGalleryPanel, ReaderNavigationPanel } from "./ReaderPanels";
import {
	closeReaderPanel,
	EMPTY_READER_PANELS,
	type ReaderPanelKind,
	type ReaderPanelSide,
	type ReaderPanelsState,
	selectReaderPanel,
} from "./reader-panel-logic";
import { freshestUsage, OpenAction } from "./usage";
import { type LayoutPass, ViewportRecovery, viewportSize } from "./viewport";

const defaults: Settings = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb",
};
type Frame = {
	element: HTMLIFrameElement;
	doc: Document;
	projection: Projection;
	resize: () => void;
	cleanup: () => void;
	presentationCleanup: () => void;
};
function partDocument(
	part: Chapter["parts"][number],
	resource: Chapter["resources"][number],
	settings: Settings,
) {
	const attrs = (values: Record<string, string>) =>
		Object.entries(values)
			.filter(([key]) => ["class", "lang", "dir"].includes(key))
			.map(([k, v]) => `${k}="${htmlEscape(v)}"`)
			.join(" ");
	// Compiled author CSS is isolated in this document; CSP prevents external resource loads.
	return `<!doctype html><html ${attrs(resource.html_attributes)}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'"><style>${resource.css.replace(/<\/style/gi, "&lt;/style")}</style><style>html,body{margin:0!important;padding:0!important;background:transparent!important;}body{font-size:${settings.font_size}px!important;line-height:${settings.line_height}!important;writing-mode:${settings.writing_mode}!important;color:#292b28!important;}img{max-width:100%;object-fit:contain;}ruby rt{font-size:.55em;}a{pointer-events:none;}html,body{overflow:hidden!important;}</style></head><body ${attrs(resource.body_attributes)}>${part.html}</body></html>`;
}
function Reader({
	book,
	notice,
}: {
	book: Material;
	notice: "imported" | "reused" | null;
}) {
	const client = useQueryClient();
	const location = useLocation();
	const returnTo = returnDestination(location.state, {
		to: "/materials",
		label: "素材库",
	});
	const source = useQuery({
		queryKey: queries.source(book.source_id),
		queryFn: () => getSource(book.source_id),
	});
	const usage = useQuery({
		queryKey: usageKey(book.id),
		queryFn: async () => {
			const fresh = await getUsage(book.id);
			return freshestUsage(
				client.getQueryData<MaterialUsage>(usageKey(book.id)),
				fresh,
			);
		},
		refetchOnMount: "always",
	});
	const [usageError, setUsageError] = useState<Error | null>(null);
	const [usageBusy, setUsageBusy] = useState(false);
	const [retryOpen, setRetryOpen] = useState(false);
	const [presented, setPresented] = useState(false);
	const [openAction] = useState(() => new OpenAction(crypto.randomUUID()));
	const acceptUsage = useCallback(
		(fresh: MaterialUsage) => {
			client.setQueryData<MaterialUsage>(usageKey(book.id), (previous) =>
				freshestUsage(previous, fresh),
			);
			void client.invalidateQueries({ queryKey: ["catalog"] });
		},
		[book.id, client],
	);
	const opened = useCallback(async () => {
		if (!usage.data || !usage.isFetchedAfterMount) return;
		try {
			await openAction.run(usage.data.revision, async (actionId, revision) => {
				try {
					acceptUsage(await recordOpened(book.id, actionId, revision));
					setRetryOpen(false);
				} catch (failure) {
					if (failure instanceof RequestError && failure.status === 409) {
						await client.invalidateQueries({ queryKey: usageKey(book.id) });
						setRetryOpen(false);
						setUsageError(new Error("阅读状态已更新，打开记录未覆盖新状态。"));
						return;
					}
					throw failure;
				}
			});
		} catch (failure) {
			setRetryOpen(true);
			setUsageError(
				failure instanceof Error ? failure : new Error(String(failure)),
			);
		}
	}, [
		usage.data,
		usage.isFetchedAfterMount,
		openAction,
		acceptUsage,
		book.id,
		client,
	]);
	useEffect(() => {
		if (presented) void opened();
	}, [presented, opened]);
	const updateUsage = async (next: MaterialUsage["status"]) => {
		if (!usage.data || usageBusy) return;
		setUsageBusy(true);
		setUsageError(null);
		try {
			acceptUsage(await setUsage(book.id, next, usage.data.revision));
		} catch (failure) {
			if (failure instanceof RequestError && failure.status === 409) {
				await client.invalidateQueries({ queryKey: usageKey(book.id) });
				setUsageError(
					new Error("阅读状态已被其他操作更新，请确认当前状态后重新选择。"),
				);
			} else
				setUsageError(
					failure instanceof Error ? failure : new Error(String(failure)),
				);
		} finally {
			setUsageBusy(false);
		}
	};
	const warnings = Array.from(new Set(book.warnings));
	const [chapterId, setChapterId] = useState(
		book.reading_position?.chapter_id ?? book.chapters[0]?.id ?? "",
	);
	const [settings, setSettings] = useState<Settings>(
		book.reading_position?.settings ?? defaults,
	);
	const [panels, setPanels] = useState<ReaderPanelsState>(EMPTY_READER_PANELS);
	const leftView = useReaderPresence(panels.left);
	const rightView = useReaderPresence(panels.right);
	const [compactPanels, setCompactPanels] = useState(
		() => matchMedia("(max-width: 820px)").matches,
	);
	const shell = useRef<HTMLElement>(null);
	const controller = useRef<ReturnType<typeof createFocusController> | null>(
		null,
	);
	const [toolsVisible, setToolsVisible] = useState(true);
	const [ui, setUi] = useState(readReaderUiPreferences);
	const [bookUi, setBookUi] = useState(() =>
		readBookUiPreferences(book.id, book.version_id),
	);
	const [systemDark, setSystemDark] = useState(
		() => matchMedia("(prefers-color-scheme: dark)").matches,
	);
	const theme = resolveReaderTheme(ui.theme, systemDark);
	const [storageFailed, setStorageFailed] = useState(false);
	const [origin, setOrigin] = useState<Position | null>(null);
	const [initialImage, setInitialImage] = useState<
		| {
				chapterId: string;
				partIndex: number;
				imageId: number;
				requestId: number;
		  }
		| undefined
	>();
	const galleryTicket = useRef(0);
	const [navigationError, setNavigationError] = useState<Error | null>(null);
	const navigationTicket = useRef(0);
	const viewerEscape = useRef<(() => void) | null>(null);
	const registerViewerEscape = useCallback((close: (() => void) | null) => {
		viewerEscape.current = close;
	}, []);
	const highlight = useRef<{
		chapterId: string;
		resourceId: string;
		partIndex: number;
		start: number;
		end: number;
	} | null>(null);
	const latest = useRef({
		panels,
		compactPanels,
		theme,
		bookUi,
		settings,
		presented,
		ui,
	});
	latest.current = {
		panels,
		compactPanels,
		theme,
		bookUi,
		settings,
		presented,
		ui,
	};
	const setUiPreference = useCallback((next: ReaderUiPreferences) => {
		setUi(next);
		setStorageFailed(!writeReaderUiPreferences(next));
	}, []);
	const selectPanel = useCallback((next: ReaderPanelKind, toggle = false) => {
		navigationTicket.current++;
		setNavigationError(null);
		setPanels((current) =>
			selectReaderPanel(current, next, toggle, latest.current.compactPanels),
		);
		controller.current?.show();
	}, []);
	const closePanel = useCallback((side?: ReaderPanelSide) => {
		navigationTicket.current++;
		setPanels((current) =>
			side ? closeReaderPanel(current, side) : EMPTY_READER_PANELS,
		);
		controller.current?.show();
	}, []);
	useEffect(() => {
		const escapeViewer = (event: KeyboardEvent) => {
			if (
				event.key !== "Escape" ||
				event.isComposing ||
				event.defaultPrevented ||
				!viewerEscape.current ||
				(latest.current.compactPanels &&
					latest.current.panels.activeSide !== "right")
			)
				return;
			const target = event.target as Node | null;
			if (
				target &&
				target !== document &&
				target !== document.body &&
				target !== document.documentElement &&
				!shell.current?.contains(target)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			viewerEscape.current();
		};
		document.addEventListener("keydown", escapeViewer, true);
		return () => document.removeEventListener("keydown", escapeViewer, true);
	}, []);
	useEffect(() => {
		const media = matchMedia("(max-width: 820px)");
		const update = () => setCompactPanels(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		const media = matchMedia("(prefers-color-scheme: dark)");
		const update = () => setSystemDark(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (!shell.current) return;
		const focus = createFocusController({
			root: shell.current,
			focus: readReaderUiPreferences().focus,
			onVisibilityChange: setToolsVisible,
			onTabReveal: (event, wasHidden) => {
				flushSync(() => setToolsVisible(true));
				const target = event.target as Element | null;
				if (
					wasHidden ||
					!target?.closest(
						'a,button,input,select,textarea,[contenteditable],[tabindex="0"]',
					)
				) {
					event.preventDefault();
					const selector = event.shiftKey
						? ".reader-bottom nav button:last-child"
						: ".reader-top a";
					// A background-window focus event can reveal before Tab; wait for inert to leave the DOM.
					requestAnimationFrame(() => {
						shell.current?.querySelector<HTMLElement>(selector)?.focus();
					});
				}
			},
			onFocusChange: (enabled) =>
				setUiPreference({ ...latest.current.ui, focus: enabled }),
			hasOverlay: () =>
				latest.current.panels.left !== null ||
				latest.current.panels.right !== null ||
				!latest.current.presented,
			onEscapeOverlay: () => {
				if (
					viewerEscape.current &&
					(!latest.current.compactPanels ||
						latest.current.panels.activeSide === "right")
				) {
					viewerEscape.current();
					return true;
				}
				if (latest.current.panels.activeSide) {
					closePanel(latest.current.panels.activeSide);
					return true;
				}
				return false;
			},
		});
		controller.current = focus;
		for (const frame of frames.current.values())
			focus.bindFrame(frame.doc, frame.element);
		return () => {
			focus.dispose();
			controller.current = null;
		};
	}, [closePanel, setUiPreference]);
	useEffect(() => {
		controller.current?.setFocus(ui.focus);
	}, [ui.focus]);
	useEffect(() => {
		if (panels.left || panels.right || !presented) controller.current?.show();
		controller.current?.refresh();
	}, [panels, presented]);
	useEffect(() => {
		for (const frame of frames.current.values()) {
			frame.presentationCleanup();
			frame.presentationCleanup = applyFramePresentation(
				frame.doc,
				theme,
				bookUi,
			);
		}
	}, [theme, bookUi]);
	const [surfaceRevision, setSurfaceRevision] = useState(0);
	const [progress, setProgress] = useState(0);
	const [status, setStatus] = useState("已保存");
	const [error, setError] = useState<Error | null>(null);
	const chapter = useQuery({
		queryKey: materialKeys.chapter(book.id, chapterId),
		queryFn: () => getChapter(book.id, chapterId),
		enabled: !!chapterId,
	});
	const container = useRef<HTMLElement>(null);
	const frames = useRef(new Map<number, Frame>());
	const ready = useRef(new Set<number>());
	const elements = useRef(new Map<number, HTMLIFrameElement>());
	const layoutTicket = useRef(0);
	const recovery = useRef(new ViewportRecovery());
	const generation = useRef(0);
	const pending = useRef<Position | null>(book.reading_position);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const alive = useRef(true);
	const queue = useRef<PositionQueue<Position> | null>(null);
	if (!queue.current)
		queue.current = new PositionQueue(
			book.reading_position?.revision ?? 0,
			async (value, revision) => {
				const saved = await savePosition(book.id, value, revision);
				cacheSavedPosition<Material>(client, book.id, saved);
				return saved.revision;
			},
			(state, failure) => {
				if (!alive.current) return;
				setStatus(
					state === "saving"
						? "保存中…"
						: state === "saved"
							? "已保存"
							: "保存失败",
				);
				if (failure)
					setError(
						failure instanceof Error ? failure : new Error(String(failure)),
					);
			},
		);
	const capture = useCallback((): Position | null => {
		const root = container.current;
		if (
			!root ||
			!chapter.data ||
			!recovery.current.canSample(viewportSize(root))
		)
			return null;
		const vertical = settings.writing_mode === "vertical-rl";
		const viewport = root.getBoundingClientRect();
		const edge = vertical ? viewport.right : viewport.top;
		let best: { index: number; frame: Frame; distance: number } | undefined;
		for (const [index, frame] of frames.current) {
			const rect = frame.element.getBoundingClientRect();
			const intersects = vertical
				? rect.left < viewport.right && rect.right > viewport.left
				: rect.top < viewport.bottom && rect.bottom > viewport.top;
			if (!intersects) continue;
			const distance = Math.abs((vertical ? rect.right : rect.top) - edge);
			if (!best || distance < best.distance) best = { index, frame, distance };
		}
		if (!best) return null;
		const part = chapter.data.parts[best.index];
		if (!part) return null;
		const rect = best.frame.element.getBoundingClientRect();
		const local = vertical ? edge - rect.left : edge - rect.top;
		const base = {
			version_id: book.version_id,
			chapter_id: chapterId,
			part_index: best.index,
			resource_id: part.resource_id,
			settings,
		};
		for (const image of best.frame.doc.querySelectorAll<HTMLElement>(
			"[data-epub-image]",
		)) {
			const r = image.getBoundingClientRect();
			const start = vertical ? r.left : r.top;
			const size = vertical ? r.width : r.height;
			if (size > 0 && local >= start && local <= start + size)
				return {
					...base,
					kind: "image",
					image_id: Number(image.dataset.epubImage),
					image_progress: imageFraction(local, start, size, vertical),
				};
		}
		const point = nearestText(
			best.frame.doc,
			best.frame.projection,
			local,
			vertical,
		);
		if (point !== undefined)
			return { ...base, kind: "text", offset: part.start + point };
		const image =
			best.frame.doc.querySelector<HTMLElement>("[data-epub-image]");
		if (image)
			return {
				...base,
				kind: "image",
				image_id: Number(image.dataset.epubImage),
				image_progress: 0,
			};
		return null;
	}, [book.version_id, chapterId, chapter.data, settings]);
	const observe = useCallback(() => {
		const root = container.current;
		if (!root) return;
		const vertical = settings.writing_mode === "vertical-rl";
		setProgress(
			scrollProgress(
				vertical ? Math.abs(root.scrollLeft) : root.scrollTop,
				vertical
					? root.scrollWidth - root.clientWidth
					: root.scrollHeight - root.clientHeight,
			),
		);
		const anchor = recovery.current.observe(viewportSize(root), capture);
		if (!recovery.current.canSample(viewportSize(root))) {
			if (timer.current) clearTimeout(timer.current);
			return;
		}
		if (!anchor) return;
		pending.current = anchor;
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => queue.current?.enqueue(anchor), 550);
	}, [capture, settings.writing_mode]);
	const restore = useCallback(
		(pass: LayoutPass) => {
			const root = container.current;
			const data = chapter.data;
			if (
				!recovery.current.restoring ||
				!root ||
				!data ||
				ready.current.size !== data.parts.length ||
				!recovery.current.canFinish(pass, viewportSize(root))
			)
				return;
			const anchor = pending.current;
			const vertical = settings.writing_mode === "vertical-rl";
			if (anchor && anchor.chapter_id === chapterId) {
				const frame = frames.current.get(anchor.part_index);
				const part = data.parts[anchor.part_index];
				if (frame && part && part.resource_id === anchor.resource_id) {
					let rect: DOMRect | null = null;
					try {
						if (anchor.kind === "text")
							rect = textRect(
								frame.doc,
								frame.projection,
								Math.max(
									0,
									Math.min(
										part.end - part.start,
										(anchor.offset ?? part.start) - part.start,
									),
								),
							);
						else
							rect =
								frame.doc
									.querySelector<HTMLElement>(
										`[data-epub-image="${anchor.image_id}"]`,
									)
									?.getBoundingClientRect() ?? null;
					} catch {
						setStatus("已恢复到附近位置");
						if (highlight.current)
							setNavigationError(
								new Error("无法精确定位搜索命中，已保留附近正文。"),
							);
					}
					if (rect) {
						const outer = frame.element.getBoundingClientRect();
						const view = root.getBoundingClientRect();
						if (vertical)
							root.scrollLeft +=
								outer.left +
								(anchor.kind === "image"
									? imageCoordinate(
											anchor.image_progress ?? 0,
											rect.left,
											rect.width,
											true,
										)
									: rect.right) -
								view.right;
						else
							root.scrollTop +=
								outer.top +
								rect.top -
								view.top +
								(anchor.kind === "image"
									? rect.height * (anchor.image_progress ?? 0)
									: 0);
					}
				}
			}
			try {
				const mark = highlight.current;
				if (mark && mark.chapterId === chapterId) {
					for (const [index, frame] of frames.current) {
						const part = data.parts[index];
						if (
							part &&
							part.resource_id === mark.resourceId &&
							part.spine_index === data.parts[mark.partIndex]?.spine_index &&
							part.end > mark.start &&
							part.start < mark.end
						)
							highlightRange(
								frame.doc,
								frame.projection,
								Math.max(mark.start, part.start) - part.start,
								Math.min(mark.end, part.end) - part.start,
							);
					}
				}
			} catch (failure) {
				setNavigationError(
					failure instanceof Error ? failure : new Error(String(failure)),
				);
			}

			if (!recovery.current.finish(pass, viewportSize(root))) return;
			setPresented(true);
			observe();
		},
		[chapter.data, chapterId, settings.writing_mode, observe],
	);
	useEffect(() => {
		alive.current = true;
		const unregister = queue.current
			? registerPositionWriter(book.id, queue.current)
			: () => {};
		return () => {
			alive.current = false;
			navigationTicket.current++;
			for (const frame of frames.current.values()) {
				frame.cleanup();
				frame.presentationCleanup();
			}
			if (timer.current) clearTimeout(timer.current);
			if (pending.current) queue.current?.enqueue(pending.current);
			unregister();
		};
	}, [book.id]);
	const load = (index: number, element: HTMLIFrameElement, token: number) => {
		const valid = () =>
			currentSurface(
				token,
				generation.current,
				element.isConnected,
				elements.current.get(index) === element &&
					!!container.current?.contains(element),
			);
		if (!valid()) return;
		const doc = element.contentDocument;
		const data = chapter.data;
		if (!doc || !data) return;
		const part = data.parts[index];
		if (!part) return;
		const resource = data.resources.find((r) => r.id === part.resource_id);
		if (!resource) return;
		try {
			const projection = projectPart(
				doc,
				Array.from(resource.text).slice(part.start, part.end).join(""),
				part.leaf_start,
			);
			const resize = () => {
				if (!valid()) return;
				const vertical = settings.writing_mode === "vertical-rl";
				const root = container.current;
				if (root) normalizeFrameImages(doc, viewportSize(root));
				if (vertical) {
					element.style.height = "100%";
					doc.body.style.setProperty("height", "100%", "important");
					doc.body.style.setProperty("width", "max-content", "important");
					element.style.width = "1px";
					element.style.width = `${Math.max(100, doc.body.scrollWidth, doc.documentElement.scrollWidth)}px`;
				} else {
					element.style.width = "100%";
					doc.body.style.setProperty("height", "auto", "important");
					doc.body.style.setProperty("width", "auto", "important");
					element.style.height = "1px";
					element.style.height = `${Math.max(32, doc.body.scrollHeight, doc.documentElement.scrollHeight)}px`;
				}
			};
			frames.current.get(index)?.cleanup();
			frames.current.get(index)?.presentationCleanup();
			const presentationCleanup = applyFramePresentation(
				doc,
				latest.current.theme,
				latest.current.bookUi,
			);
			const unbind = controller.current?.bindFrame(doc, element);
			const keydown = (event: KeyboardEvent) => {
				if (valid()) readKey(event);
			};
			const wheel = (event: WheelEvent) => {
				if (!valid()) return;
				if (
					event.ctrlKey ||
					event.defaultPrevented ||
					latest.current.settings.writing_mode !== "vertical-rl"
				)
					return;
				if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
					event.preventDefault();
					container.current?.scrollBy({ left: -event.deltaY });
				}
			};
			const click = (event: MouseEvent) => {
				if (!valid()) return;
				const target = event.target as Element | null;
				const image = target?.closest("img[data-epub-image]");
				if (image && !event.defaultPrevented) {
					event.preventDefault();
					setInitialImage({
						requestId: ++galleryTicket.current,
						chapterId,
						partIndex: index,
						imageId: Number(image.getAttribute("data-epub-image")),
					});
					selectPanel("gallery");
				}
			};
			doc.addEventListener("keydown", keydown);
			doc.addEventListener("wheel", wheel, { passive: false });
			doc.addEventListener("click", click);
			const cleanup = () => {
				unbind?.();
				doc.removeEventListener("keydown", keydown);
				doc.removeEventListener("wheel", wheel);
				doc.removeEventListener("click", click);
			};
			frames.current.set(index, {
				element,
				doc,
				projection,
				resize,
				cleanup,
				presentationCleanup,
			});
			resize();
			void Promise.all([
				doc.fonts.ready,
				...Array.from(doc.images).map((image) =>
					image.complete
						? Promise.resolve()
						: new Promise<void>((resolve) => {
								image.onload = () => resolve();
								image.onerror = () => resolve();
							}),
				),
			]).then(() => {
				if (!valid()) return;
				resize();
				ready.current.add(index);
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						if (valid() && ready.current.size === data.parts.length) {
							for (const frame of frames.current.values()) frame.resize();
							const root = container.current;
							if (!root) return;
							const pass = recovery.current.begin(viewportSize(root));
							requestAnimationFrame(() =>
								requestAnimationFrame(() => {
									if (valid()) restore(pass);
								}),
							);
						}
					}),
				);
			});
		} catch (failure) {
			setError(failure instanceof Error ? failure : new Error(String(failure)));
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new keyed viewport must replace the old ResizeObserver even when settings are unchanged.
	useEffect(() => {
		const root = container.current;
		if (!root) return;
		let scheduled: number | undefined;
		let lastWidth = root.clientWidth,
			lastHeight = root.clientHeight;
		const resize = () => {
			const width = root.clientWidth,
				height = root.clientHeight;
			if (width === lastWidth && height === lastHeight) return;
			lastWidth = width;
			lastHeight = height;
			if (!recovery.current.restoring)
				pending.current = pending.current ?? capture();
			const pass = recovery.current.begin({ width, height });
			if (timer.current) clearTimeout(timer.current);
			const ticket = ++layoutTicket.current;
			const token = generation.current;
			if (scheduled !== undefined) cancelAnimationFrame(scheduled);
			scheduled = requestAnimationFrame(() => {
				for (const frame of frames.current.values()) frame.resize();
				void Promise.all(
					Array.from(frames.current.values()).map(
						(frame) => frame.doc.fonts.ready,
					),
				).then(() =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							if (
								alive.current &&
								ticket === layoutTicket.current &&
								token === generation.current
							)
								restore(pass);
						}),
					),
				);
			});
		};
		const observer = new ResizeObserver(resize);
		observer.observe(root);
		window.addEventListener("resize", resize);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", resize);
			if (scheduled !== undefined) cancelAnimationFrame(scheduled);
			layoutTicket.current++;
		};
	}, [capture, restore, surfaceRevision]);
	const navigateTo = async (
		target: Position,
		mark?: { start: number; end: number },
		returning = false,
		requestTicket?: number,
		side?: ReaderPanelSide,
	) => {
		const ticket = requestTicket ?? ++navigationTicket.current;
		setNavigationError(null);
		try {
			if (target.version_id !== book.version_id)
				throw new Error("原位置版本已不可用。");
			const data = await client.fetchQuery({
				queryKey: materialKeys.chapter(book.id, target.chapter_id),
				queryFn: () => getChapter(book.id, target.chapter_id),
			});
			if (ticket !== navigationTicket.current || !alive.current) return;
			const part = data.parts[target.part_index];
			if (
				!part ||
				part.resource_id !== target.resource_id ||
				(target.kind === "text" &&
					((target.offset ?? -1) < part.start ||
						(target.offset ?? -1) > part.end)) ||
				(target.kind === "image" &&
					!part.html.includes(`data-epub-image="${target.image_id}"`))
			)
				throw new Error("无法定位到原文位置，请重新打开目录或重试。");
			const last = anchorBeforeLayout(
				recovery.current.restoring,
				pending.current,
				capture,
			);
			if (last) queue.current?.enqueue(last);
			if (!returning) setOrigin((previous) => previous ?? last);
			else setOrigin(null);
			if (timer.current) clearTimeout(timer.current);
			pending.current = { ...target, settings: latest.current.settings };
			highlight.current = mark
				? {
						chapterId: target.chapter_id,
						resourceId: target.resource_id,
						partIndex: target.part_index,
						...mark,
					}
				: null;
			generation.current++;
			recovery.current.invalidate();
			for (const frame of frames.current.values()) {
				frame.cleanup();
				frame.presentationCleanup();
			}
			frames.current.clear();
			ready.current.clear();
			setChapterId(target.chapter_id);
			setSurfaceRevision((value) => value + 1);
			setProgress(0);
			closePanel(side);
		} catch (failure) {
			if (ticket === navigationTicket.current && alive.current)
				setNavigationError(
					failure instanceof Error ? failure : new Error(String(failure)),
				);
		}
	};
	const choose = async (id: string) => {
		const ticket = ++navigationTicket.current;
		setNavigationError(null);
		try {
			const data = await client.fetchQuery({
				queryKey: materialKeys.chapter(book.id, id),
				queryFn: () => getChapter(book.id, id),
			});
			if (ticket !== navigationTicket.current || !alive.current) return;
			const part = data.parts[0];
			if (!part) throw new Error("章节没有可阅读内容");
			const image = part.html.match(/data-epub-image="(\d+)"/);
			await navigateTo(
				{
					version_id: book.version_id,
					chapter_id: id,
					part_index: 0,
					resource_id: part.resource_id,
					settings,
					...(part.end > part.start
						? { kind: "text", offset: part.start }
						: {
								kind: "image",
								image_id: Number(image?.[1] ?? 0),
								image_progress: 0,
							}),
				},
				undefined,
				false,
				ticket,
				"left",
			);
		} catch (failure) {
			if (ticket !== navigationTicket.current || !alive.current) return;
			setNavigationError(
				failure instanceof Error ? failure : new Error(String(failure)),
			);
		}
	};
	const readKey = useCallback((event: KeyboardEvent) => {
		const target = event.target as Element | null;
		if (
			target?.ownerDocument &&
			target.ownerDocument !== document &&
			!isReaderFrameTarget(target.ownerDocument, target)
		)
			return;
		if (
			event.defaultPrevented ||
			event.isComposing ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			target?.closest(
				'input,textarea,select,button,a,[contenteditable="true"],[role="dialog"]',
			)
		)
			return;
		const vertical = latest.current.settings.writing_mode === "vertical-rl";
		const root = container.current;
		if (!root) return;
		const page = vertical ? root.clientWidth : root.clientHeight;
		let step = 0;
		if (event.key === "PageDown" || event.key === " ")
			step = page * 0.85 * (event.shiftKey ? -1 : 1);
		else if (event.key === "PageUp") step = -page * 0.85;
		else if (vertical && event.key === "ArrowLeft") step = 80;
		else if (vertical && event.key === "ArrowRight") step = -80;
		else if (!vertical && event.key === "ArrowDown") step = 80;
		else if (!vertical && event.key === "ArrowUp") step = -80;
		if (step) {
			event.preventDefault();
			root.scrollBy(vertical ? { left: -step } : { top: step });
		}
	}, []);
	useEffect(() => {
		document.addEventListener("keydown", readKey);
		return () => document.removeEventListener("keydown", readKey);
	}, [readKey]);
	const change = (next: Settings) => {
		if (timer.current) clearTimeout(timer.current);
		const anchor = anchorBeforeLayout(
			recovery.current.restoring,
			pending.current,
			capture,
		);
		pending.current = anchor ? { ...anchor, settings: next } : null;
		generation.current++;
		recovery.current.invalidate();
		for (const frame of frames.current.values()) {
			frame.cleanup();
			frame.presentationCleanup();
		}
		frames.current.clear();
		ready.current.clear();
		setSettings(next);
	};
	const changeBookUi = (next: BookUiPreferences) => {
		if (next.font !== bookUi.font || next.width !== bookUi.width) {
			change(settings);
			setSurfaceRevision((value) => value + 1);
		}
		setBookUi(next);
		setStorageFailed(!writeBookUiPreferences(book.id, book.version_id, next));
	};
	const leave = () => {
		if (timer.current) clearTimeout(timer.current);
		const anchor = anchorBeforeLayout(
			recovery.current.restoring,
			pending.current,
			capture,
		);
		if (anchor) {
			pending.current = anchor;
			queue.current?.enqueue(anchor);
		}
	};
	const renderToken = generation.current;
	return (
		<main
			ref={shell}
			className="reader-r1"
			data-theme={theme}
			data-tools-visible={toolsVisible}
			data-left-open={!!panels.left}
			data-right-open={!!panels.right}
			data-active-side={panels.activeSide}
			onFocusCapture={(event) => {
				const side = (event.target as Element).closest<HTMLElement>(
					"[data-reader-panel-side]",
				)?.dataset.readerPanelSide;
				if (side === "left" || side === "right")
					setPanels((current) =>
						current.activeSide === side
							? current
							: { ...current, activeSide: side },
					);
			}}
			style={
				{
					"--reader-width": `${bookUi.width}px`,
					"--reader-motion-duration": `${READER_EXIT_MS}ms`,
				} as CSSProperties
			}
		>
			<header
				className="reader-chrome reader-top"
				data-reader-tools=""
				inert={!toolsVisible}
				aria-hidden={!toolsVisible}
			>
				<Link
					to={returnTo.to}
					onClick={leave}
					aria-label={`返回${returnTo.label}`}
				>
					← <span>{returnTo.label}</span>
				</Link>
				<div className="reader-heading">
					<h1 title={book.title}>{book.title}</h1>
					<p>
						{chapter.data?.title ??
							(chapter.isError ? "章节暂不可用" : "正在打开章节…")}
					</p>
				</div>
				<button
					type="button"
					aria-label="书籍信息"
					data-tooltip="书籍信息"
					aria-expanded={panels.right === "info"}
					onClick={() => selectPanel("info", true)}
				>
					<CatalogIcon name="more" />
				</button>
			</header>
			<div className="reader-alerts" aria-live="polite">
				<InlineError
					error={error ?? navigationError ?? usageError ?? usage.error}
				/>
				{error && (
					<button type="button" onClick={() => window.location.reload()}>
						重新打开
					</button>
				)}
				{navigationError && (
					<button type="button" onClick={() => setNavigationError(null)}>
						关闭定位提示
					</button>
				)}
				{retryOpen && (
					<button
						type="button"
						onClick={() => {
							setUsageError(null);
							void opened();
						}}
					>
						重试打开记录
					</button>
				)}
			</div>
			{chapter.isPending ? (
				<div className="reader-loading">正在打开章节…</div>
			) : chapter.isError ? (
				<div className="reader-loading">
					<InlineError error={chapter.error} />
					<button type="button" onClick={() => void chapter.refetch()}>
						重试章节
					</button>
				</div>
			) : (
				<section
					key={`${chapterId}-${surfaceRevision}`}
					ref={container}
					tabIndex={-1}
					onScroll={observe}
					className={`material-reading reader-viewport ${settings.writing_mode === "vertical-rl" ? "material-vertical" : ""}`}
					aria-label={chapter.data.title}
				>
					{chapter.data.parts.map((part, index) => {
						const resource = chapter.data.resources.find(
							(r) => r.id === part.resource_id,
						);
						return resource ? (
							<iframe
								key={`${chapterId}-${part.spine_index}-${part.resource_id}-${part.start}-${settings.font_size}-${settings.line_height}-${settings.writing_mode}-${bookUi.font}`}
								title={`${chapter.data.title} ${index + 1}`}
								className="material-part"
								sandbox="allow-same-origin"
								srcDoc={partDocument(part, resource, settings)}
								ref={(element) => {
									if (element) elements.current.set(index, element);
									else elements.current.delete(index);
								}}
								onLoad={(e) => load(index, e.currentTarget, renderToken)}
							/>
						) : null;
					})}
				</section>
			)}
			<footer
				className="reader-chrome reader-bottom"
				data-reader-tools=""
				inert={!toolsVisible}
				aria-hidden={!toolsVisible}
			>
				<nav aria-label="书内工具">
					<span className="reader-progress" title="当前章节的阅读进度">
						章内 {Math.round(progress * 100)}%
					</span>
					{origin && (
						<button
							type="button"
							aria-label="返回跳转前"
							data-tooltip="返回跳转前"
							onClick={() => void navigateTo(origin, undefined, true)}
						>
							↶
						</button>
					)}
					<button
						type="button"
						aria-label="目录"
						data-tooltip="目录与搜索"
						aria-expanded={panels.left !== null}
						onClick={() => selectPanel("toc", true)}
					>
						<ReaderIcon name="toc" />
					</button>
					<button
						type="button"
						aria-label="插图库"
						data-tooltip="插图库"
						aria-expanded={panels.right === "gallery"}
						onClick={() => {
							if (panels.right !== "gallery") setInitialImage(undefined);
							selectPanel("gallery", true);
						}}
					>
						<ReaderIcon name="image" />
					</button>
					<button
						type="button"
						aria-label="阅读设置"
						data-tooltip="阅读设置"
						aria-expanded={panels.right === "settings"}
						onClick={() => selectPanel("settings", true)}
					>
						Aa
					</button>
					<button
						type="button"
						aria-label={`专注阅读：${ui.focus ? "开启" : "关闭"}`}
						data-tooltip={`专注阅读：${ui.focus ? "开启" : "关闭"}`}
						aria-pressed={ui.focus}
						onClick={() => setUiPreference({ ...ui, focus: !ui.focus })}
					>
						<CatalogIcon name="size" />
					</button>
				</nav>
			</footer>
			{rightView.value === "settings" && (
				<ReaderSettings
					settings={settings}
					ui={ui}
					bookUi={bookUi}
					closing={rightView.exiting}
					inactive={
						compactPanels && !!panels.left && panels.activeSide === "left"
					}
					onSettings={change}
					onUi={setUiPreference}
					onBookUi={changeBookUi}
					onReset={() => {
						change(defaults);
						setSurfaceRevision((v) => v + 1);
						setBookUi(DEFAULT_BOOK_UI);
						setUiPreference(DEFAULT_READER_UI);
						setStorageFailed(
							!writeBookUiPreferences(
								book.id,
								book.version_id,
								DEFAULT_BOOK_UI,
							),
						);
					}}
					onClose={() => closePanel("right")}
				/>
			)}
			{storageFailed && panels.right === "settings" && (
				<p className="reader-preference-notice" role="status">
					偏好暂未存入浏览器，本次阅读仍可使用。
				</p>
			)}
			{leftView.value !== null && (
				<ReaderNavigationPanel
					key={`${book.id}-${book.version_id}`}
					materialId={book.id}
					versionId={book.version_id}
					bookTitle={book.title}
					chapters={book.chapters}
					chapterId={chapterId}
					progress={progress}
					closing={leftView.exiting}
					inactive={
						compactPanels && !!panels.right && panels.activeSide === "right"
					}
					tab={leftView.value}
					onTab={(tab) => selectPanel(tab)}
					onChoose={(id) => void choose(id)}
					settings={settings}
					navigationError={navigationError}
					onCancelNavigation={() => {
						navigationTicket.current++;
					}}
					onClose={() => closePanel("left")}
					onNavigate={(target, mark) =>
						void navigateTo(target, mark, false, undefined, "left")
					}
				/>
			)}
			{rightView.value === "gallery" && (
				<ReaderGalleryPanel
					key={`${book.id}-${book.version_id}-${initialImage?.requestId ?? "gallery"}`}
					materialId={book.id}
					versionId={book.version_id}
					bookTitle={book.title}
					settings={settings}
					initialImage={initialImage}
					closing={rightView.exiting}
					inactive={
						compactPanels && !!panels.left && panels.activeSide === "left"
					}
					onViewerEscape={registerViewerEscape}
					navigationError={navigationError}
					onCancelNavigation={() => {
						navigationTicket.current++;
					}}
					onClose={() => closePanel("right")}
					onNavigate={(target) =>
						void navigateTo(target, undefined, false, undefined, "right")
					}
				/>
			)}
			{rightView.value === "info" && (
				<ReaderPanel
					title="书籍信息"
					closing={rightView.exiting}
					inactive={
						compactPanels && !!panels.left && panels.activeSide === "left"
					}
					onClose={() => closePanel("right")}
				>
					<dl className="reader-book-info">
						<dt>书名</dt>
						<dd lang="ja">{book.title}</dd>
						<dt>所属来源</dt>
						<dd>
							<Link
								to={`/sources/${book.source_id}?view=materials`}
								onClick={leave}
							>
								{source.data?.title ?? "打开来源空间"}
								<span className="reader-info-link-hint">查看来源空间 →</span>
							</Link>
						</dd>
					</dl>
					<label>
						阅读状态
						<select
							aria-label="阅读状态"
							value={usage.data?.status ?? "not_started"}
							disabled={!usage.isSuccess || usageBusy}
							onChange={(e) =>
								void updateUsage(e.target.value as MaterialUsage["status"])
							}
						>
							<option value="not_started">未开始</option>
							<option value="in_progress">进行中</option>
							<option value="completed">已完成</option>
						</select>
					</label>
					<dl className="reader-book-info">
						<dt>阅读位置保存状态</dt>
						<dd role="status">{status}</dd>
					</dl>
					{notice && (
						<p>
							{notice === "reused"
								? "已打开此前导入的材料。"
								: "已新导入书籍。"}
						</p>
					)}
					{warnings.length > 0 && (
						<details>
							<summary>导入提示（{warnings.length}）</summary>
							<p>导入时的格式与兼容性处理记录，可展开查看详情。</p>
							<ul>
								{warnings.map((w) => (
									<li key={w}>{w}</li>
								))}
							</ul>
						</details>
					)}
				</ReaderPanel>
			)}
		</main>
	);
}

function MaterialOpening({ id }: { id: string }) {
	const location = useLocation();
	const navigate = useNavigate();
	const [notice] = useState<"imported" | "reused" | null>(() => {
		if (typeof location.state !== "object" || location.state === null)
			return null;
		if (location.state.materialReused === true) return "reused";
		return location.state.materialImported === true ||
			location.state.materialReused === false
			? "imported"
			: null;
	});
	const [snapshot, setSnapshot] = useState<Material | null>(null);
	const book = useQuery({
		queryKey: materialKeys.book(id),
		queryFn: () => getMaterial(id),
		refetchOnMount: "always",
	});
	useEffect(() => {
		if (
			notice &&
			typeof location.state === "object" &&
			location.state !== null &&
			("materialReused" in location.state ||
				"materialImported" in location.state)
		) {
			const state = { ...location.state };
			delete state.materialReused;
			delete state.materialImported;
			navigate(location.pathname, { replace: true, state });
		}
	}, [notice, location.pathname, location.state, navigate]);
	useEffect(() => {
		if (
			!snapshot &&
			book.isSuccess &&
			book.isFetchedAfterMount &&
			!book.isFetching
		)
			setSnapshot(book.data);
	}, [
		snapshot,
		book.isSuccess,
		book.isFetchedAfterMount,
		book.isFetching,
		book.data,
	]);
	if (snapshot) return <Reader key={id} book={snapshot} notice={notice} />;
	const back = returnDestination(location.state, {
		to: "/materials",
		label: "素材库",
	});
	return (
		<main
			className="reader-r1 reader-opening"
			data-theme={resolveReaderTheme(
				readReaderUiPreferences().theme,
				matchMedia("(prefers-color-scheme: dark)").matches,
			)}
		>
			<Link to={back.to}>← {back.label}</Link>
			<div className="reader-loading">
				{book.isError ? (
					<>
						<InlineError error={book.error} />
						<button type="button" onClick={() => void book.refetch()}>
							重试打开
						</button>
					</>
				) : (
					<p>正在打开书籍…</p>
				)}
			</div>
		</main>
	);
}
export function MaterialReader() {
	const { id = "" } = useParams();
	return <MaterialOpening key={id} id={id} />;
}
