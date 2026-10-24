import "./reader-r1.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Icon as CatalogIcon } from "../catalog/LibraryTools";
import { getSource, queries, RequestError, type Segment } from "../content";
import {
	returnDestination,
	returnState,
	updateSegmentLocation,
} from "../navigation";
import { InlineError } from "../Shared";
import { SpeechPlaybackBar, useStopSpeechOnLeave } from "../speech";
import { getSpeechController } from "../speech/browser";
import type { AdoptionSession } from "../translation/AdoptTranslation";
import {
	getTranslationResult,
	type TranslationResult,
} from "../translation/api";
import { useTranslationSessions } from "../translation/session-react";
import { targetText, translationTargetKey } from "../translation/state";
import { TranslationPanel } from "../translation/TranslationPanel";
import {
	type Chapter,
	getChapter,
	getMaterial,
	getReadings,
	getUsage,
	type Material,
	type MaterialUsage,
	materialKeys,
	type Position,
	prepareReadings,
	type ReadingsSummary,
	readingsKey,
	recordOpened,
	type Settings,
	savePosition,
	setUsage,
	usageKey,
} from "./api";
import { ChapterRecords } from "./ChapterRecords";
import {
	inlineTranslationAtHit,
	recordsAtHit,
	sameRecordHit,
} from "./chapter-records";
import {
	type ChapterTranslation,
	useChapterTranslations,
	useMaterialTranslationActivity,
} from "./chapter-translations-query";
import {
	imagePrecedesText,
	nearestText,
	readingContentEnd,
	textRect,
	textSamplingTarget,
} from "./dom";
import { createFocusController, isReaderFrameTarget } from "./focus";
import { READER_EXIT_MS, useReaderPresence } from "./motion";
import { cacheSavedPosition, registerPositionWriter } from "./persistence";
import {
	chapterProgress,
	imageAtReadingEdge,
	imageCoordinate,
	imageFraction,
	PositionQueue,
} from "./position";
import { ReaderPreferenceSubmission } from "./preference-submission";
import {
	type BookUiPreferences,
	DEFAULT_BOOK_UI,
	DEFAULT_READER_UI,
	READER_UI_KEY,
	type ReaderUiPreferences,
	readBookUiPreferences,
	readReaderUiPreferences,
	resolveReaderTheme,
	writeBookUiPreferences,
	writeReaderUiPreferences,
} from "./preferences";
import { applyFramePresentation } from "./presentation";
import { ReaderIcon, ReaderPanel, ReaderSettings } from "./ReaderControls";
import { ReaderGalleryPanel, ReaderNavigationPanel } from "./ReaderPanels";
import {
	type ReaderFrame as Frame,
	partDocument,
	ReaderFrames,
} from "./reader-frames";
import { ReaderLayout } from "./reader-layout";
import {
	ReaderNavigation,
	type ReaderNavigationCompletion,
} from "./reader-navigation";
import { originFailure, originPosition } from "./reader-origin";
import {
	closeReaderPanel,
	EMPTY_READER_PANELS,
	type ReaderPanelKind,
	type ReaderPanelSide,
	type ReaderPanelsState,
	selectReaderPanel,
} from "./reader-panel-logic";
import type { ReaderHighlightRange } from "./reader-selection";
import type {
	ScreenAnchor,
	StudyMarkHit,
	StudySelection,
} from "./reader-study";
import { JumpReadingSession, returnOriginLabel } from "./return-origin";
import { SavedSegmentNotice, SelectionToolbar } from "./StudyOverlays";
import { StudySegmentPanel } from "./StudySegmentPanel";
import { readerWheelScroll } from "./scroll";
import {
	getSegmentProvenance,
	type SegmentProvenance,
	type StudyTarget,
} from "./study-api";
import type { StudyMarginEntry } from "./study-margin";
import { useChapterStudyMarks } from "./study-marks-query";
import { nativeSelectionKey } from "./study-overlays";
import { freshestUsage, OpenAction } from "./usage";
import {
	atChapterEnd,
	chapterEndAdjustment,
	readingFrameDistance,
	readingViewport,
	viewportSize,
} from "./viewport";

const defaults: Settings = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb",
};
type InlineTranslationRequest = {
	chapterId: string;
	item: ChapterTranslation;
	hit: StudyMarkHit;
};
function Reader({
	book,
	notice,
	readingsSummary,
	initialOrigin,
}: {
	book: Material;
	initialOrigin: SegmentProvenance | null;
	readingsSummary: ReadingsSummary;
	notice: "imported" | "reused" | null;
}) {
	useStopSpeechOnLeave(book.id);
	useMaterialTranslationActivity(book.id);
	const [translationTarget, setTranslationTarget] =
		useState<StudyTarget | null>(null);
	const [translationOpen, setTranslationOpen] = useState(false);
	const [translationAnchor, setTranslationAnchor] =
		useState<ScreenAnchor | null>(null);
	const [translationMounted, setTranslationMounted] = useState(false);
	const adoptionSessions = useRef(new Map<string, AdoptionSession>());
	const translationSessions = useTranslationSessions();
	const client = useQueryClient();
	const readingGeneration = readingsSummary.generation_id;
	const location = useLocation();
	const navigate = useNavigate();
	const initialAnchor = initialOrigin
		? originPosition(initialOrigin, book.reading_position?.settings ?? defaults)
		: book.reading_position;
	const [studyTarget, setStudyTarget] = useState<StudyTarget | null>(null);
	const [selectionError, setSelectionError] = useState<Error | null>(null);
	const [originError, setOriginError] = useState<Error | null>(null);
	const [selection, setSelection] = useState<StudySelection | null>(null);
	const [marginEntries, setMarginEntries] = useState<StudyMarginEntry[]>([]);
	const markTrigger = useRef<HTMLButtonElement | null>(null);
	const [markHit, setMarkHit] = useState<StudyMarkHit | null>(null);
	const [manualPosition, setManualPosition] = useState<{
		left: number;
		top: number;
	} | null>(null);
	const [inlineRequest, setInlineRequest] =
		useState<InlineTranslationRequest | null>(null);
	const [previewSerial, setPreviewSerial] = useState(0);
	const previewEmphasis = useRef<{
		id: string;
		kind: "segment" | "translation";
	} | null>(null);
	const [markError, setMarkError] = useState<Error | null>(null);
	const [savedNotice, setSavedNotice] = useState<{
		id: string;
		kind: "created" | "existing";
		serial: number;
	} | null>(null);
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
		initialAnchor?.chapter_id ?? book.chapters[0]?.id ?? "",
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
	const jumpReading = useRef(new JumpReadingSession());
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
	const navigation = useRef(new ReaderNavigation(jumpReading.current));
	const [navigationState, setNavigationState] = useState(
		navigation.current.state,
	);
	const {
		origin,
		error: navigationError,
		busy: chapterSwitchBusy,
	} = navigationState;
	const invalidateNavigation = useCallback(
		() => navigation.current.invalidate(),
		[],
	);
	const viewerEscape = useRef<(() => void) | null>(null);
	const registerViewerEscape = useCallback((close: (() => void) | null) => {
		viewerEscape.current = close;
	}, []);
	const highlight = useRef<{
		chapterId: string;
		ranges: ReaderHighlightRange[];
		kind: "study" | "search";
	} | null>(
		initialOrigin?.material_provenance && initialOrigin.chapter_id
			? {
					kind: "study",
					chapterId: initialOrigin.chapter_id,
					ranges: initialOrigin.material_provenance.ranges,
				}
			: null,
	);
	const latest = useRef({
		panels,
		chapterId,
		compactPanels,
		theme,
		bookUi,
		settings,
		presented,
		ui,
		selectionActive: selection !== null,
		markActive: markHit !== null,
		markHit,
		manualPosition,
		inlineRequest,
		studyTargetActive: studyTarget !== null,
		studyActive:
			translationOpen ||
			studyTarget !== null ||
			selection !== null ||
			markHit !== null,
	});
	latest.current = {
		panels,
		chapterId,
		compactPanels,
		theme,
		bookUi,
		settings,
		presented,
		ui,
		selectionActive: selection !== null,
		markActive: markHit !== null,
		markHit,
		manualPosition,
		inlineRequest,
		studyTargetActive: studyTarget !== null,
		studyActive:
			translationOpen ||
			studyTarget !== null ||
			selection !== null ||
			markHit !== null,
	};
	const closeCompactPreview = useCallback(() => {
		if (
			!latest.current.markHit ||
			latest.current.manualPosition ||
			latest.current.markHit.fixed ||
			latest.current.panels.right === "study"
		)
			return false;
		setMarkHit(null);
		previewEmphasis.current = null;
		frames.current.emphasizeStudyMark(null);
		return true;
	}, []);
	const closeInlineTranslation = useCallback(() => {
		setInlineRequest(null);
		if (latest.current.inlineRequest) {
			previewEmphasis.current = null;
			frames.current.emphasizeStudyMark(null);
		}
	}, []);
	const dismissReadingBackground = useCallback(() => {
		const hadToolbar = latest.current.selectionActive;
		const clearedSelection = frames.current.clearStudySelection();
		const closedPreview = closeCompactPreview();
		return hadToolbar || clearedSelection || closedPreview;
	}, [closeCompactPreview]);
	const setUiPreference = useCallback((next: ReaderUiPreferences) => {
		setUi(next);
		setStorageFailed(!writeReaderUiPreferences(next));
	}, []);
	useEffect(() => {
		const changed = (event: StorageEvent) => {
			if (event.key === READER_UI_KEY || event.key === null)
				setUi(readReaderUiPreferences());
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, []);
	const selectPanel = useCallback(
		(next: ReaderPanelKind, toggle = false) => {
			setSelection(null);
			if (
				!(
					latest.current.panels.right === "study" &&
					(next === "toc" || next === "search")
				)
			) {
				setMarkHit(null);
				previewEmphasis.current = null;
				frames.current.emphasizeStudyMark(null);
			}
			jumpReading.current.pause();
			invalidateNavigation();
			navigation.current.dismissError();
			setPanels((current) =>
				selectReaderPanel(current, next, toggle, latest.current.compactPanels),
			);
			controller.current?.show();
		},
		[invalidateNavigation],
	);
	const closePanel = useCallback(
		(side?: ReaderPanelSide, invalidate = true) => {
			if (
				(!side || side === "right") &&
				latest.current.panels.right === "study"
			) {
				setMarkHit(null);
				previewEmphasis.current = null;
				frames.current.emphasizeStudyMark(null);
			}
			jumpReading.current.pause();
			if (invalidate) invalidateNavigation();
			setPanels((current) =>
				side ? closeReaderPanel(current, side) : EMPTY_READER_PANELS,
			);
			controller.current?.show();
		},
		[invalidateNavigation],
	);
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
		document.addEventListener("keydown", escapeViewer);
		return () => document.removeEventListener("keydown", escapeViewer);
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
			onBackgroundTap: dismissReadingBackground,
			onTabReveal: (event, wasHidden) => {
				flushSync(() => setToolsVisible(true));
				const selectionButton = document.getElementById(
					"reader-selection-save",
				);
				if (
					selectionButton &&
					!event.shiftKey &&
					!(event.target as Element | null)?.closest?.("[data-reader-tool]")
				) {
					event.preventDefault();
					selectionButton.focus({ preventScroll: true });
					return;
				}
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
				latest.current.studyActive ||
				latest.current.panels.left !== null ||
				latest.current.panels.right !== null ||
				!latest.current.presented,
			onEscapeOverlay: () => {
				if (latest.current.selectionActive) {
					setSelection(null);
					return true;
				}
				if (latest.current.inlineRequest) {
					closeInlineTranslation();
					return true;
				}
				if (
					latest.current.markActive &&
					!(
						latest.current.panels.right === "study" &&
						latest.current.compactPanels &&
						latest.current.panels.activeSide === "left"
					)
				) {
					setMarkHit(null);
					previewEmphasis.current = null;
					frames.current.emphasizeStudyMark(null);
					setPanels((current) =>
						current.right === "study"
							? closeReaderPanel(current, "right")
							: current,
					);
					markTrigger.current?.focus({ preventScroll: true });
					return true;
				}
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
	}, [
		closePanel,
		closeInlineTranslation,
		dismissReadingBackground,
		setUiPreference,
	]);
	useEffect(() => {
		controller.current?.setFocus(ui.focus);
	}, [ui.focus]);
	useEffect(() => {
		if (panels.left || panels.right || !presented) controller.current?.show();
		controller.current?.refresh();
	}, [panels, presented]);
	const [surfaceRevision, setSurfaceRevision] = useState(0);
	const presentation = useRef<{
		beginning: boolean;
		complete: (result: ReaderNavigationCompletion) => void;
	} | null>(null);
	const [layoutRevision, setLayoutRevision] = useState(0);
	const [progress, setProgress] = useState<number | null>(
		initialOrigin ? null : (book.reading_position?.progress ?? null),
	);
	const [chapterPositions, setChapterPositions] = useState(
		() =>
			new Map(
				(book.chapter_positions ?? []).map((position) => [
					position.chapter_id,
					{ anchor: position as Position, progress: position.progress },
				]),
			),
	);
	const [status, setStatus] = useState("已保存");
	const [error, setError] = useState<Error | null>(null);
	const [positionError, setPositionError] = useState<Error | null>(null);
	const chapter = useQuery({
		queryKey: materialKeys.chapter(book.id, chapterId),
		queryFn: () => getChapter(book.id, chapterId),
		enabled: !!chapterId,
	});
	const marks = useChapterStudyMarks(book.id, book.version_id, chapterId, true);
	const chapterTranslations = useChapterTranslations(
		book.id,
		book.version_id,
		chapterId,
	);
	const recordMarks = useMemo(
		() => [
			...marks.items,
			...chapterTranslations.items.map((item) => ({
				translation_id: item.identity_sha256,
				material_provenance: item.material_provenance,
			})),
		],
		[marks.items, chapterTranslations.items],
	);
	const readings = useQuery({
		queryKey: readingsKey(
			book.id,
			book.version_id,
			chapterId,
			readingGeneration,
		),
		queryFn: ({ signal }) =>
			getReadings(
				book.id,
				book.version_id,
				chapterId,
				readingGeneration,
				signal,
			),
		enabled: !!chapterId,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const viewportReady =
		chapter.isSuccess && (bookUi.rubyScope !== "all" || readings.isSuccess);
	const container = useRef<HTMLElement>(null);
	const frames = useRef(new ReaderFrames());
	const layout = useRef(new ReaderLayout<Position>(initialAnchor));
	const generation = useRef(0);
	const alive = useRef(true);
	const openMarkHit = useCallback(
		(value: StudyMarkHit, trigger: HTMLButtonElement | null = null) => {
			closeInlineTranslation();
			setTranslationOpen(false);
			markTrigger.current = trigger;
			previewEmphasis.current = null;
			frames.current.emphasizeStudyMark(null);
			frames.current.clearStudySelection();
			setPanels((current) =>
				current.right === "study"
					? closeReaderPanel(current, "right")
					: current,
			);
			setPreviewSerial((serial) => serial + 1);
			setMarkHit(value);
		},
		[closeInlineTranslation],
	);
	const openTextMark = useCallback(
		(value: StudyMarkHit) => {
			const item = !latest.current.manualPosition
				? inlineTranslationAtHit(
						marks.items,
						chapterTranslations.items,
						value,
						latest.current.settings.writing_mode,
					)
				: null;
			if (!item) {
				openMarkHit(value);
				return;
			}
			if (
				latest.current.inlineRequest?.item.identity_sha256 ===
				item.identity_sha256
			) {
				closeInlineTranslation();
				return;
			}
			setMarkHit(null);
			setTranslationOpen(false);
			frames.current.clearStudySelection();
			setPanels((current) =>
				current.right === "study"
					? closeReaderPanel(current, "right")
					: current,
			);
			previewEmphasis.current = {
				id: item.identity_sha256,
				kind: "translation",
			};
			frames.current.emphasizeStudyMark(item.identity_sha256, "translation");
			setInlineRequest({ chapterId, item, hit: value });
		},
		[
			marks.items,
			chapterTranslations.items,
			chapterId,
			openMarkHit,
			closeInlineTranslation,
		],
	);
	useLayoutEffect(() => {
		frames.current.bindStudy({
			materialId: book.id,
			versionId: book.version_id,
			chapterId,
			onSelection: (value) => {
				if (!alive.current) return;
				setSelection(value);
				if (value) {
					if (
						!latest.current.markHit?.fixed &&
						!latest.current.manualPosition &&
						!latest.current.inlineRequest &&
						latest.current.panels.right !== "study"
					) {
						setMarkHit(null);
						previewEmphasis.current = null;
						frames.current.emphasizeStudyMark(null);
					}
					controller.current?.show();
				}
			},
			onEntries: setMarginEntries,
			onMarks: (value) => {
				if (!alive.current) return;
				if (value) {
					if (!latest.current.studyTargetActive) openTextMark(value);
				} else if (
					latest.current.panels.right === "study" ||
					latest.current.manualPosition ||
					latest.current.inlineRequest ||
					latest.current.markHit?.fixed
				) {
					frames.current.emphasizeStudyMark(
						previewEmphasis.current?.id ?? null,
						previewEmphasis.current?.kind,
					);
				} else {
					setMarkHit(null);
					previewEmphasis.current = null;
				}
			},
			onBackgroundTap: dismissReadingBackground,
		});
	});
	const hitRecords = useMemo(
		() => recordsAtHit(marks.items, chapterTranslations.items, markHit),
		[marks.items, chapterTranslations.items, markHit],
	);
	const visibleHitItems = hitRecords.segments;
	const closeMarkHit = useCallback(() => {
		closeInlineTranslation();
		setManualPosition(null);
		setMarkHit(null);
		previewEmphasis.current = null;
		frames.current.emphasizeStudyMark(null);
		setPanels((current) =>
			current.right === "study" ? closeReaderPanel(current, "right") : current,
		);
		markTrigger.current?.focus({ preventScroll: true });
	}, [closeInlineTranslation]);
	useEffect(() => {
		if (!markHit) setManualPosition(null);
	}, [markHit]);
	const inlineResult = useQuery({
		queryKey: ["translation-result", inlineRequest?.item.result_id],
		queryFn: () => getTranslationResult(inlineRequest?.item.result_id ?? ""),
		enabled:
			!!inlineRequest &&
			inlineRequest.chapterId === chapterId &&
			settings.writing_mode === "horizontal-tb",
		retry: false,
	});
	useEffect(() => {
		if (
			markHit &&
			!markHit.fixed &&
			!marks.loading &&
			!marks.isFetching &&
			!chapterTranslations.loading &&
			!chapterTranslations.isFetching &&
			visibleHitItems.length === 0 &&
			hitRecords.translations.length === 0
		)
			closeMarkHit();
	}, [
		markHit,
		marks.loading,
		marks.isFetching,
		chapterTranslations.loading,
		chapterTranslations.isFetching,
		hitRecords.translations.length,
		visibleHitItems.length,
		closeMarkHit,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a chapter switch invalidates the fixed list even when its old frame has already gone.
	useEffect(() => {
		closeInlineTranslation();
		setManualPosition(null);
		setMarkHit(null);
		previewEmphasis.current = null;
		setPanels((current) =>
			current.right === "study" ? closeReaderPanel(current, "right") : current,
		);
	}, [chapterId]);
	const queue = useRef<PositionQueue<Position> | null>(null);
	if (!queue.current)
		queue.current = new PositionQueue(
			book.reading_position?.revision ?? 0,
			async (value, revision) => {
				const saved = await savePosition(book.id, value, revision);
				cacheSavedPosition<Material>(client, book.id, saved);
				client.setQueryData<Material>(materialKeys.book(book.id), (current) =>
					current
						? {
								...current,
								chapter_positions: [
									...(current.chapter_positions ?? []).filter(
										(position) => position.chapter_id !== saved.chapter_id,
									),
									saved,
								],
							}
						: undefined,
				);
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
					setPositionError(
						failure instanceof Error ? failure : new Error(String(failure)),
					);
				else if (state === "saved") setPositionError(null);
			},
			(value) => value.chapter_id,
		);
	const geometryKey = [
		surfaceRevision,
		layoutRevision,
		settings.font_size,
		settings.line_height,
		settings.writing_mode,
		bookUi.font,
		bookUi.width,
		bookUi.rubyScope,
	].join("|");
	const chapterContentEnd = useCallback((vertical: boolean) => {
		let end: number | null = null;
		for (const frame of frames.current.values()) {
			if (frame.contentEnd === null) continue;
			const rect = frame.element.getBoundingClientRect();
			const value = (vertical ? rect.left : rect.top) + frame.contentEnd;
			end =
				end === null
					? value
					: vertical
						? Math.min(end, value)
						: Math.max(end, value);
		}
		return end;
	}, []);
	const capture = useCallback((): Position | null => {
		const root = container.current;
		if (frames.current.inlineMotionRunning) return null;
		if (!root || !chapter.data || !layout.current.canSample(viewportSize(root)))
			return null;
		const vertical = settings.writing_mode === "vertical-rl";
		const viewport = readingViewport(root, getComputedStyle(root));
		const edge = vertical ? viewport.right : viewport.top;
		const endReached = atChapterEnd(
			chapterContentEnd(vertical),
			viewport,
			vertical,
		);
		let best: { index: number; frame: Frame; distance: number } | undefined;
		for (const [index, frame] of frames.current) {
			const rect = frame.element.getBoundingClientRect();
			const distance = readingFrameDistance(
				rect,
				viewport,
				vertical,
				frame.contentEnd,
				endReached,
			);
			if (distance === null) continue;
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
			at_chapter_end: endReached,
			settings,
		};
		for (const image of best.frame.doc.querySelectorAll<HTMLElement>(
			"[data-epub-image]",
		)) {
			const r = image.getBoundingClientRect();
			const start = vertical ? r.left : r.top;
			const size = vertical ? r.width : r.height;
			if (
				imageAtReadingEdge(
					local,
					start,
					size,
					vertical,
					imagePrecedesText(image, best.frame.projection.entries),
				)
			)
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
			textSamplingTarget(local, settings.font_size, vertical),
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
	}, [book.version_id, chapterId, chapter.data, settings, chapterContentEnd]);
	const sampleJumpReading = useCallback(() => {
		const root = container.current;
		if (
			!root ||
			document.hidden ||
			!document.hasFocus() ||
			navigation.current.state.returning ||
			!layout.current.canSample(viewportSize(root))
		) {
			jumpReading.current.pause();
			return false;
		}
		const vertical = latest.current.settings.writing_mode === "vertical-rl";
		const view = readingViewport(root, getComputedStyle(root));
		jumpReading.current.sample(
			vertical ? -root.scrollLeft : root.scrollTop,
			vertical ? view.width : view.height,
			performance.now(),
		);
		return true;
	}, []);
	const recordReadingInput = useCallback(
		(event: Event) => {
			if (!event.isTrusted || event.defaultPrevented) return;
			const target = event.target as Node | null;
			if (
				target?.ownerDocument &&
				target.ownerDocument !== document &&
				!isReaderFrameTarget(target.ownerDocument, target)
			)
				return;
			frames.current.finishInlineMotion();
			// Sample before granting input so a prior programmatic move cannot count.
			if (sampleJumpReading()) jumpReading.current.input(performance.now());
		},
		[sampleJumpReading],
	);
	const readWheel = useCallback(
		(event: WheelEvent, outside = false) => {
			const root = container.current;
			if (!root || event.ctrlKey || event.defaultPrevented) return;
			const current = latest.current.settings;
			const vertical = current.writing_mode === "vertical-rl";
			const view = readingViewport(root, getComputedStyle(root));
			const scroll = readerWheelScroll(event, {
				vertical,
				outside,
				lineHeight: current.font_size * current.line_height,
				pageSize: vertical ? view.width : view.height,
			});
			if (event.deltaX || event.deltaY) recordReadingInput(event);
			if (scroll) {
				event.preventDefault();
				root.scrollBy(scroll);
			}
		},
		[recordReadingInput],
	);
	useEffect(() => {
		const root = shell.current;
		if (!root) return;
		const wheel = (event: WheelEvent) => {
			// Panels and toolbar controls keep their own scrolling; iframe events bind separately.
			if (event.target === root || event.target === container.current)
				readWheel(event, event.target === root);
		};
		root.addEventListener("wheel", wheel, { passive: false });
		return () => root.removeEventListener("wheel", wheel);
	}, [readWheel]);
	useEffect(() => {
		const pause = () => jumpReading.current.pause();
		document.addEventListener("visibilitychange", pause);
		window.addEventListener("blur", pause);
		return () => {
			document.removeEventListener("visibilitychange", pause);
			window.removeEventListener("blur", pause);
		};
	}, []);
	const observe = useCallback(() => {
		const root = container.current;
		if (!root || frames.current.inlineMotionRunning) return;
		const anchor = layout.current.observe(
			viewportSize(root),
			capture,
			(position) => queue.current?.enqueue(position),
		);
		if (anchor && chapter.data) {
			sampleJumpReading();
			const value = chapterProgress(
				chapter.data.parts,
				chapter.data.resources,
				anchor,
				frames.current
					.get(anchor.part_index)
					?.imageOffsets.get(anchor.image_id ?? -1),
			);
			setProgress(value);
			setChapterPositions((previous) =>
				new Map(previous).set(anchor.chapter_id, { anchor, progress: value }),
			);
		} else jumpReading.current.pause();
	}, [capture, chapter.data, sampleJumpReading]);
	const restore = useCallback(
		(anchor: Position | null, initialPresentation: boolean) => {
			const root = container.current;
			const data = chapter.data;
			if (!root || !data) return false;
			if (highlight.current?.chapterId === chapterId) {
				try {
					if (highlight.current.kind === "study")
						frames.current.validateStudyTarget(data, highlight.current.ranges);
					else frames.current.highlight(data, highlight.current.ranges);
					setOriginError(null);
				} catch (failure) {
					setOriginError(
						failure instanceof Error ? failure : new Error(String(failure)),
					);
					return false;
				}
			}
			jumpReading.current.pause();
			let located = false;
			const vertical = settings.writing_mode === "vertical-rl";
			const receipt = presentation.current;
			let navigationFailure: Error | undefined;
			if (receipt?.beginning) {
				// A chapter may start with images or invisible whitespace before its first text.
				root.scrollLeft = 0;
				root.scrollTop = 0;
				located = true;
			} else if (anchor && anchor.chapter_id === chapterId) {
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
								vertical,
								settings.font_size,
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
							navigationFailure = new Error(
								"无法精确定位搜索命中，已保留附近正文。",
							);
					}
					if (rect && (rect.width > 0 || rect.height > 0)) {
						located = true;
						const outer = frame.element.getBoundingClientRect();
						const view = readingViewport(root, getComputedStyle(root));
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
			// A saved end is a navigation destination. Ordinary reflows keep the original text/image anchor.
			if (initialPresentation && located && anchor?.at_chapter_end) {
				const adjustment = chapterEndAdjustment(
					chapterContentEnd(vertical),
					readingViewport(root, getComputedStyle(root)),
					vertical,
				);
				if (vertical) root.scrollLeft += adjustment;
				else root.scrollTop += adjustment;
			}

			if (highlight.current && !located) {
				setOriginError(new Error("原文尚未完整定位，已保留目标，请重试。"));
				return false;
			}

			return () => {
				if (receipt) {
					receipt.beginning = false;
					receipt.complete({ anchor, located, error: navigationFailure });
				}
				setPresented(true);
				frames.current.refreshStudyGeometry();
				observe();
			};
		},
		[
			chapter.data,
			chapterId,
			settings.writing_mode,
			settings.font_size,
			observe,
			chapterContentEnd,
		],
	);
	const reflowFrames = useCallback(() => layout.current.reflow(), []);
	const mutateInlineLayout = useCallback(
		(update: () => void) => {
			const root = container.current;
			const data = chapter.data;
			if (!root || !data || !alive.current) {
				update();
				return;
			}
			frames.current.preserveStudyPreviewDuringLayout(() => {
				const anchor = capture();
				const screenTop = () => {
					if (!anchor) return null;
					const frame = frames.current.get(anchor.part_index);
					const part = data.parts[anchor.part_index];
					if (!frame || !part) return null;
					const rect =
						anchor.kind === "text"
							? textRect(
									frame.doc,
									frame.projection,
									(anchor.offset ?? part.start) - part.start,
									false,
								)
							: frame.doc
									.querySelector<HTMLElement>(
										`[data-epub-image="${anchor.image_id}"]`,
									)
									?.getBoundingClientRect();
					return rect
						? frame.element.getBoundingClientRect().top + rect.top
						: null;
				};
				const before = screenTop();
				jumpReading.current.pause();
				let applied = false;
				layout.current.reflow(() => {
					applied = true;
					update();
				});
				if (!applied) {
					update();
					return;
				}
				const after = screenTop();
				if (before !== null && after !== null) root.scrollTop += after - before;
				// restore() already refreshes study geometry; only resample after pixel compensation.
				observe();
			});
		},
		[capture, chapter.data, observe],
	);
	useEffect(() => {
		alive.current = true;
		const unregister = queue.current
			? registerPositionWriter(book.id, queue.current)
			: () => {};
		return () => {
			alive.current = false;
			frames.current.clear();
			layout.current.cancelSave();
			const anchor = layout.current.presentedAnchor(() => null);
			if (anchor) queue.current?.enqueue(anchor);
			unregister();
		};
	}, [book.id]);
	const load = (index: number, element: HTMLIFrameElement, token: number) => {
		if (!chapter.data) return;
		frames.current.load(index, element, token, {
			chapter: chapter.data,
			readingGeneration,
			readings: readings.data,
			current: () => latest.current,
			generation: () => generation.current,
			root: () => container.current,
			bindFocus: (doc, frame) => controller.current?.bindFrame(doc, frame),
			key: readKey,
			wheel: readWheel,
			touch: recordReadingInput,
			image: (partIndex, imageId) => {
				setInitialImage({
					requestId: ++galleryTicket.current,
					chapterId,
					partIndex,
					imageId,
				});
				selectPanel("gallery");
			},
			ready: (token, index) => layout.current.resourcesReady(token, index),
			error: (failure) =>
				setError(
					initialOrigin
						? new Error("原文定位不完整，目标已保留。请重新打开后重试。")
						: failure,
				),
		});
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: a newly mounted keyed viewport needs its own observer.
	useEffect(() => {
		if (!viewportReady) return;
		const root = container.current;
		if (!root) return;
		let lastWidth = root.clientWidth,
			lastHeight = root.clientHeight;
		const resize = () => {
			if (root !== container.current || !alive.current) return;
			frames.current.finishInlineMotion();
			setTranslationAnchor(null);
			const width = root.clientWidth,
				height = root.clientHeight;
			frames.current.invalidateStudyGeometry();
			if (width === lastWidth && height === lastHeight) {
				frames.current.refreshStudyGeometry();
				return;
			}
			lastWidth = width;
			lastHeight = height;
			reflowFrames();
		};
		const observer = new ResizeObserver(resize);
		observer.observe(root);
		window.addEventListener("resize", resize);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", resize);
		};
	}, [reflowFrames, surfaceRevision, viewportReady]);
	useLayoutEffect(() => {
		navigation.current.bind({
			versionId: book.version_id,
			chapterId,
			chapters: book.chapters,
			settings,
			unavailable:
				!!error ||
				chapter.isError ||
				(bookUi.rubyScope === "all" && readings.isError),
			remembered: (id) => chapterPositions.get(id)?.anchor,
			presentedAnchor: () => layout.current.presentedAnchor(capture),
			progressFor: (anchor) => {
				const data = chapter.data;
				if (data?.id !== anchor.chapter_id)
					return chapterPositions.get(anchor.chapter_id)?.progress ?? null;
				return chapterProgress(
					data.parts,
					data.resources,
					anchor,
					frames.current
						.get(anchor.part_index)
						?.imageOffsets.get(anchor.image_id ?? -1),
				);
			},
			atBeginning: () => {
				const root = container.current;
				if (!root || !layout.current.canSample(viewportSize(root)))
					return false;
				const offset =
					latest.current.settings.writing_mode === "vertical-rl"
						? root.scrollLeft
						: root.scrollTop;
				return Number.isFinite(offset) && Math.abs(offset) <= 1;
			},
			loadChapter: (id) =>
				client.fetchQuery({
					queryKey: materialKeys.chapter(book.id, id),
					queryFn: () => getChapter(book.id, id),
				}),
			saveDeparture: (anchor) => {
				queue.current?.enqueue(anchor);
			},
			present: (destination, complete) => {
				presentation.current = {
					beginning: destination?.beginning ?? false,
					complete,
				};
				if (!destination) {
					layout.current.setAnchor(layout.current.anchor(capture));
					return;
				}
				const { target, mark } = destination;
				layout.current.setAnchor(target);
				const part = chapter.data?.parts[target.part_index];
				// Destination chapter may be newly fetched; the chosen part is checked by navigation.
				const loaded = client.getQueryData<Chapter>(
					materialKeys.chapter(book.id, target.chapter_id),
				);
				const targetPart = loaded?.parts[target.part_index] ?? part;
				highlight.current =
					mark && targetPart
						? {
								kind: "search",
								chapterId: target.chapter_id,
								ranges: [
									{
										resource_id: target.resource_id,
										spine_index: targetPart.spine_index,
										...mark,
									},
								],
							}
						: null;
				setOriginError(null);
				generation.current++;
				layout.current.invalidateSurface();
				frames.current.clear();
				setChapterId(target.chapter_id);
				setSurfaceRevision((value) => value + 1);
				setProgress(null);
			},
			closePanels: (side) => closePanel(side, false),
			changed: setNavigationState,
		});
	});
	useLayoutEffect(() => () => navigation.current.suspend(), []);
	const adjacent = {
		previous: navigationState.previous,
		next: navigationState.next,
	};
	const chapterSwitchDisabled = navigationState.adjacentDisabled;
	const returnLabel = origin
		? returnOriginLabel(
				book.chapters.find((item) => item.id === origin.chapter_id)?.title ??
					"原章节",
				navigationState.originProgress,
			)
		: undefined;
	const readKey = useCallback(
		(event: KeyboardEvent) => {
			const target = event.target as Element | null;
			if (nativeSelectionKey(event)) return;
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
			const page = vertical
				? root.clientWidth
				: readingViewport(root, getComputedStyle(root)).height;
			let step = 0;
			if (event.key === "PageDown" || event.key === " ")
				step = page * 0.85 * (event.shiftKey ? -1 : 1);
			else if (event.key === "PageUp") step = -page * 0.85;
			else if (vertical && event.key === "ArrowLeft") step = 80;
			else if (vertical && event.key === "ArrowRight") step = -80;
			else if (!vertical && event.key === "ArrowDown") step = 80;
			else if (!vertical && event.key === "ArrowUp") step = -80;
			if (step) {
				recordReadingInput(event);
				event.preventDefault();
				root.scrollBy({
					...(vertical ? { left: -step } : { top: step }),
					behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
						? "instant"
						: "smooth",
				});
			}
		},
		[recordReadingInput],
	);
	useEffect(() => {
		document.addEventListener("keydown", readKey);
		return () => document.removeEventListener("keydown", readKey);
	}, [readKey]);
	const [rubyPreparing, setRubyPreparing] = useState(false);
	const [rubyError, setRubyError] = useState<Error | null>(null);
	const preferenceSubmission = useRef(new ReaderPreferenceSubmission());
	const change = (next: Settings) => {
		setTranslationAnchor(null);
		layout.current.cancelSave();
		const anchor = layout.current.anchor(capture);
		layout.current.setAnchor(anchor ? { ...anchor, settings: next } : null);
		setLayoutRevision((revision) => revision + 1);
		setSettings(next);
	};
	useLayoutEffect(() => {
		preferenceSubmission.current.bind({
			chapter: chapterId,
			current: bookUi,
			readingsReady: readings.isSuccess,
			loadReadings: () =>
				client.fetchQuery({
					queryKey: readingsKey(
						book.id,
						book.version_id,
						chapterId,
						readingGeneration,
					),
					queryFn: ({ signal }) =>
						getReadings(
							book.id,
							book.version_id,
							chapterId,
							readingGeneration,
							signal,
						),
				}),
			store: (next) => writeBookUiPreferences(book.id, book.version_id, next),
			commit: (next, result) => {
				if (result.geometryChanged) change(settings);
				setBookUi(next);
				setStorageFailed(result.storageFailed);
			},
			status: (preparing, failure) => {
				setRubyPreparing(preparing);
				setRubyError(failure);
			},
		});
	});
	useLayoutEffect(() => () => preferenceSubmission.current.suspend(), []);
	const changeBookUi = (next: BookUiPreferences) =>
		preferenceSubmission.current.submit(next);
	useLayoutEffect(() => {
		if (!viewportReady) return;
		const root = container.current;
		const data = chapter.data;
		if (!root || !data) return;
		const presentation = () => {
			for (const frame of frames.current.values()) {
				frame.presentationCleanup();
				frame.presentationCleanup = applyFramePresentation(
					frame.doc,
					theme,
					bookUi,
				);
			}
		};
		try {
			frames.current.finishInlineMotion();
			layout.current.commit(
				{
					generation: generation.current,
					parts: data.parts.length,
					geometry: geometryKey,
					size: () => (container.current === root ? viewportSize(root) : null),
					capture,
					measure: () => {
						frames.current.invalidateStudyGeometry();
						for (const frame of frames.current.values()) {
							frame.resize();
							frame.contentEnd = readingContentEnd(
								frame.doc,
								frame.projection,
								settings.writing_mode === "vertical-rl",
							);
						}
					},
					restore,
				},
				presentation,
				() => {
					jumpReading.current.pause();
					frames.current.update(data, settings, theme, bookUi, readings.data);
				},
			);
		} catch (failure) {
			setError(failure instanceof Error ? failure : new Error(String(failure)));
		}
	}, [
		settings,
		geometryKey,
		viewportReady,
		bookUi,
		theme,
		chapter.data,
		readings.data,
		capture,
		restore,
	]);
	useLayoutEffect(() => {
		const data = chapter.data;
		if (!data) return;
		if (
			!inlineRequest ||
			inlineRequest.chapterId !== chapterId ||
			settings.writing_mode !== "horizontal-tb"
		) {
			frames.current.setInlineTranslation(data, null, mutateInlineLayout);
			if (inlineRequest) closeInlineTranslation();
			return;
		}
		const item = inlineRequest.item;
		if (
			!chapterTranslations.loading &&
			!chapterTranslations.isFetching &&
			!marks.loading &&
			!marks.isFetching &&
			!inlineTranslationAtHit(
				marks.items,
				chapterTranslations.items,
				inlineRequest.hit,
				settings.writing_mode,
			)
		) {
			closeInlineTranslation();
			return;
		}
		const result = inlineResult.data;
		if (inlineResult.isError) {
			openMarkHit(inlineRequest.hit);
			return;
		}
		if (!result) {
			frames.current.setInlineTranslation(data, null, mutateInlineLayout);
			return;
		}
		const matching =
			result.id === item.result_id &&
			result.identity_sha256 === item.identity_sha256 &&
			result.material_provenance.material_id === book.id &&
			result.material_provenance.version_id === book.version_id;
		if (
			!matching ||
			!frames.current.setInlineTranslation(
				data,
				{
					reference: result.material_provenance,
					text: result.translation,
				},
				mutateInlineLayout,
			)
		)
			openMarkHit(inlineRequest.hit);
	}, [
		inlineRequest,
		inlineResult.data,
		inlineResult.isError,
		chapter.data,
		chapterId,
		settings,
		marks.items,
		marks.loading,
		marks.isFetching,
		chapterTranslations.loading,
		chapterTranslations.isFetching,
		chapterTranslations.items,
		book.id,
		book.version_id,
		mutateInlineLayout,
		closeInlineTranslation,
		openMarkHit,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: wait for React to commit the updated margin coordinates.
	useLayoutEffect(() => {
		frames.current.inlineMarginsChanged();
	}, [marginEntries]);
	const leave = () => {
		frames.current.finishInlineMotion();
		layout.current.cancelSave();
		const anchor = layout.current.presentedAnchor(capture);
		if (anchor) {
			layout.current.setAnchor(anchor);
			queue.current?.enqueue(anchor);
		}
	};
	const openStudySegment = (
		id: string,
		analysisId?: string,
		revisionId?: string,
	) => {
		leave();
		navigate(
			`/segments/${id}${updateSegmentLocation("", { analysisId, revisionId, chatOpen: false })}`,
			{
				state: returnState(
					{ to: `/materials/${book.id}?segment=${id}`, label: book.title },
					returnTo,
					`/segments/${id}`,
				),
			},
		);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: panel visibility changes measured free space outside the text viewport.
	useLayoutEffect(() => {
		if (!chapter.data || !viewportReady) return;
		try {
			frames.current.setStudyMarks(
				chapter.data,
				recordMarks,
				ui.marks.studySegmentUnderlines,
				theme,
				ui.marks.studySegmentMargins,
			);
			setMarkError(null);
		} catch (failure) {
			setMarkError(
				failure instanceof Error
					? failure
					: new Error("阅读记录标记暂不可用。"),
			);
		}
	}, [
		chapter.data,
		viewportReady,
		recordMarks,
		ui.marks.studySegmentUnderlines,
		ui.marks.studySegmentMargins,
		theme,
		panels.left,
		panels.right,
		leftView.value,
		rightView.value,
	]);
	const backToTranslationOrigin = (result: TranslationResult) => {
		closeMarkHit();
		const reference = result.material_provenance;
		const range = reference.ranges[0];
		const part = result.parts.find((item) => item.range_index === 0);
		if (
			!range ||
			!part ||
			result.material_deleted ||
			reference.version_id !== book.version_id
		) {
			setSelectionError(new Error("原文版本或位置不可用"));
			return;
		}
		setTranslationOpen(false);
		void navigation.current.navigate({
			type: "position",
			target: {
				version_id: reference.version_id,
				chapter_id: result.chapter_id,
				part_index: part.part_index,
				resource_id: range.resource_id,
				kind: "text",
				offset: range.start,
				at_chapter_end: false,
				settings,
			},
			mark: { start: range.start, end: range.end },
		});
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
					"--reader-toolbar-opacity": `${100 - ui.toolbarTransparency}%`,
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
					state={returnTo.state}
					onClick={leave}
					aria-label={`返回${returnTo.label}`}
				>
					← <span>{returnTo.label}</span>
				</Link>
				<div className="reader-heading">
					<h1 title={book.title}>{book.title}</h1>
					<p>
						<span className="reader-heading-chapter">
							{chapter.data?.title ??
								(chapter.isError ? "章节暂不可用" : "正在打开章节…")}
						</span>
						<span className="reader-heading-progress">
							{progress === null
								? "章内 —"
								: `章内 ${Math.round(progress * 100)}%`}
						</span>
					</p>
				</div>
				<div className="reader-heading-actions">
					<button
						type="button"
						aria-label="本章记录"
						aria-expanded={!!markHit?.fixed}
						disabled={!!studyTarget}
						onClick={(event) => {
							if (markHit?.fixed) {
								closeMarkHit();
								return;
							}
							openMarkHit(
								{
									segmentIds: [],
									anchor: { left: 0, right: 0, top: 80, bottom: 80 },
									fixed: true,
								},
								event.currentTarget,
							);
							controller.current?.show();
						}}
					>
						本章记录
					</button>
					<button
						type="button"
						aria-label="书籍信息"
						data-tooltip="书籍信息"
						aria-expanded={panels.right === "info"}
						onClick={() => selectPanel("info", true)}
					>
						<CatalogIcon name="more" />
					</button>
				</div>
			</header>
			<div className="reader-alerts" aria-live="polite">
				{inlineRequest && inlineResult.isPending && (
					<p role="status">正在读取译文…</p>
				)}
				{marks.loading && <p>正在载入本章学习片段标记…</p>}
				{(marks.isError || markError) && (
					<div className="reader-mark-error" role="alert">
						学习片段标记暂不可用，原文可继续阅读。
						<button type="button" onClick={() => void marks.refetch()}>
							重试标记
						</button>
					</div>
				)}
				{!marks.isError && marks.unavailable > 0 && (
					<p>部分历史片段的出处无法校验，未在正文中标记。</p>
				)}
				<InlineError
					error={
						selectionError ??
						originError ??
						error ??
						positionError ??
						navigationError ??
						usageError ??
						usage.error
					}
				/>
				{originError && (
					<button
						type="button"
						onClick={() => {
							setError(null);
							setOriginError(null);
							generation.current++;
							frames.current.clear();
							layout.current.invalidateSurface();
							setSurfaceRevision((value) => value + 1);
						}}
					>
						重试精确定位
					</button>
				)}
				{(error || positionError) && (
					<button type="button" onClick={() => window.location.reload()}>
						重新打开
					</button>
				)}
				{navigationError && (
					<button
						type="button"
						onClick={() => navigation.current.dismissError()}
					>
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
			{chapter.isPending ||
			(bookUi.rubyScope === "all" && readings.isPending) ? (
				<div className="reader-loading">正在打开章节…</div>
			) : chapter.isError ||
				(bookUi.rubyScope === "all" && readings.isError) ? (
				<div className="reader-loading">
					<InlineError error={chapter.error ?? readings.error} />
					<button
						type="button"
						onClick={() => {
							void chapter.refetch();
							void readings.refetch();
						}}
					>
						重试章节
					</button>
				</div>
			) : (
				<section
					key={`${chapterId}-${surfaceRevision}`}
					ref={container}
					tabIndex={-1}
					onScroll={() => {
						setTranslationAnchor(null);
						observe();
					}}
					onTouchMove={(event) => recordReadingInput(event.nativeEvent)}
					onPointerDown={(event) => {
						if (event.target === event.currentTarget && event.button === 0)
							recordReadingInput(event.nativeEvent);
					}}
					onPointerMove={(event) => {
						if (event.target === event.currentTarget && event.buttons === 1)
							recordReadingInput(event.nativeEvent);
					}}
					className={`material-reading reader-viewport ${settings.writing_mode === "vertical-rl" ? "material-vertical" : ""}`}
					aria-label={chapter.data.title}
				>
					{chapter.data.parts.map((part, index) => {
						const resource = chapter.data.resources.find(
							(r) => r.id === part.resource_id,
						);
						return resource ? (
							<iframe
								key={`${chapterId}-${part.spine_index}-${part.resource_id}-${part.start}`}
								title={`${chapter.data.title} ${index + 1}`}
								className="material-part"
								sandbox="allow-same-origin"
								srcDoc={partDocument(part, resource, defaults)}
								ref={(element) => {
									frames.current.register(index, element);
								}}
								onLoad={(e) => load(index, e.currentTarget, renderToken)}
							/>
						) : null;
					})}
					{ui.marks.studySegmentMargins &&
						!studyTarget &&
						!translationOpen &&
						marginEntries.map((entry) => (
							<button
								key={`${entry.segmentIds.join(":")}|${entry.translationIds?.join(":") ?? ""}`}
								type="button"
								className="reader-study-margin"
								data-reader-tool=""
								style={{ left: entry.left, top: entry.top }}
								aria-expanded={Boolean(
									markHit && !markHit.fixed && sameRecordHit(markHit, entry),
								)}
								aria-label={`查看此处 ${entry.segmentIds.length + (entry.translationIds?.length ?? 0)} 条记录`}
								onClick={(event) => {
									const current = latest.current.markHit;
									if (
										current &&
										!current.fixed &&
										sameRecordHit(current, entry)
									) {
										closeMarkHit();
										return;
									}
									const root = container.current;
									if (!root) return;
									const view = readingViewport(root, getComputedStyle(root));
									const anchor = event.currentTarget.getBoundingClientRect();
									openMarkHit(
										{
											segmentIds: entry.segmentIds,
											translationIds: entry.translationIds,
											anchor,
											anchorPlacement:
												settings.writing_mode === "vertical-rl"
													? "margin-bottom"
													: anchor.left >= view.right
														? "margin-right"
														: "margin-left",
										},
										event.currentTarget,
									);
									controller.current?.show();
								}}
							>
								{entry.segmentIds.length + (entry.translationIds?.length ?? 0) >
								1 ? (
									entry.segmentIds.length + (entry.translationIds?.length ?? 0)
								) : entry.translationIds?.length ? (
									"译"
								) : (
									<svg
										aria-hidden="true"
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
									>
										<path d="M6 4h12v16l-6-4-6 4z" />
									</svg>
								)}
							</button>
						))}
				</section>
			)}
			<footer
				className="reader-chrome reader-bottom"
				data-reader-tools=""
				inert={!toolsVisible}
				aria-hidden={!toolsVisible}
			>
				<nav aria-label="书内工具">
					<span className="reader-progress" title="当前章节位置">
						{progress === null
							? "章内 —"
							: `章内 ${Math.round(progress * 100)}%`}
					</span>
					{origin && (
						<button
							type="button"
							className="reader-return-origin"
							aria-label={returnLabel}
							data-tooltip={returnLabel}
							onClick={() =>
								void navigation.current.navigate({ type: "return" })
							}
						>
							↶
						</button>
					)}
					<div
						className="reader-chapter-navigation"
						aria-busy={chapterSwitchBusy}
					>
						<button
							type="button"
							className="reader-chapter-step"
							aria-label="上一章"
							data-tooltip={
								adjacent.previous
									? `上一章：${adjacent.previous.title}`
									: "已是第一章"
							}
							disabled={!adjacent.previous || chapterSwitchDisabled}
							onClick={() =>
								void navigation.current.navigate({
									type: "adjacent",
									direction: "previous",
								})
							}
						>
							<ReaderIcon name="previous" />
						</button>
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
							className="reader-chapter-step"
							aria-label="下一章"
							data-tooltip={
								adjacent.next
									? `下一章：${adjacent.next.title}`
									: "已是最后一章"
							}
							disabled={!adjacent.next || chapterSwitchDisabled}
							onClick={() =>
								void navigation.current.navigate({
									type: "adjacent",
									direction: "next",
								})
							}
						>
							<ReaderIcon name="next" />
						</button>
					</div>
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
						aria-label="最近翻译"
						data-tooltip="最近翻译"
						onClick={() => {
							setTranslationTarget(null);
							setTranslationAnchor(null);
							setTranslationMounted(true);
							setTranslationOpen(true);
							setSelection(null);
							closeMarkHit();
							closePanel();
							controller.current?.show();
						}}
					>
						译
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
			<SpeechPlaybackBar />
			{translationMounted && (
				<div hidden={!translationOpen}>
					<TranslationPanel
						key={
							translationTarget
								? translationTargetKey(translationTarget.reference)
								: "recent"
						}
						materialId={book.id}
						adoptionSessions={adoptionSessions.current}
						translationSessions={translationSessions}
						visible={translationOpen}
						anchor={translationAnchor}
						direction={settings.writing_mode}
						sourceId={book.source_id}
						target={translationTarget}
						autoStart={!!translationTarget}
						onOpenSegment={openStudySegment}
						onClose={() => {
							setTranslationOpen(false);
							requestAnimationFrame(() =>
								document
									.querySelector<HTMLButtonElement>(
										'button[aria-label="最近翻译"]',
									)
									?.focus({ preventScroll: true }),
							);
						}}
						onSaved={() => {
							void client.invalidateQueries({
								queryKey: ["material-chapter-segments", book.id],
							});
						}}
						onBackToOrigin={backToTranslationOrigin}
					/>
				</div>
			)}
			{studyTarget && (
				<StudySegmentPanel
					target={studyTarget}
					sourceId={book.source_id}
					sourceTitle={source.data?.title ?? "所属来源"}
					onCancel={() => setStudyTarget(null)}
					onSaved={(segment: Segment, kind) => {
						setStudyTarget(null);
						setSelection(null);
						frames.current.clearStudySelection();
						setSavedNotice({ id: segment.id, kind, serial: Date.now() });
						void client.invalidateQueries({
							queryKey: ["material-chapter-segments", book.id],
						});
					}}
				/>
			)}
			{selection && !studyTarget && (
				<SelectionToolbar
					anchor={selection.anchor}
					onTranslate={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!layout.current.canSample(viewportSize(container.current))
							)
								throw new Error("正文仍在准备，请重新选择。");
							const target = frames.current.captureStudyTarget(
								book.id,
								book.version_id,
								chapter.data,
							);
							setTranslationTarget(structuredClone(target));
							setTranslationAnchor(selection.anchor);
							setTranslationMounted(true);
							setTranslationOpen(true);
							setSelection(null);
							closeMarkHit();
							closePanel();
							setSelectionError(null);
							controller.current?.show();
						} catch (failure) {
							setSelectionError(
								failure instanceof Error ? failure : new Error(String(failure)),
							);
						}
					}}
					onSpeak={() => {
						try {
							if (!chapter.data) throw new Error("正文仍在准备，请重新选择。");
							const target = frames.current.captureStudyTarget(
								book.id,
								book.version_id,
								chapter.data,
							);
							getSpeechController().play({
								id: translationTargetKey(target.reference),
								text: targetText(target.reference),
								label: "阅读选区",
							});
							setSelection(null);
						} catch (failure) {
							setSelectionError(
								failure instanceof Error ? failure : new Error(String(failure)),
							);
						}
					}}
					onClose={() => setSelection(null)}
					onSave={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!layout.current.canSample(viewportSize(container.current))
							)
								throw new Error("正文仍在准备，请重新选择。");
							setTranslationOpen(false);
							setStudyTarget(
								frames.current.captureStudyTarget(
									book.id,
									book.version_id,
									chapter.data,
								),
							);
							setSelection(null);
							closeMarkHit();
							setSelectionError(null);
							controller.current?.show();
						} catch (failure) {
							setSelectionError(
								failure instanceof Error
									? failure
									: new Error("无法读取选区，请重新选择。"),
							);
						}
					}}
				/>
			)}

			{markHit &&
				chapter.data &&
				!translationOpen &&
				!studyTarget &&
				(markHit.fixed ||
					visibleHitItems.length > 0 ||
					hitRecords.translations.length > 0) && (
					<ChapterRecords
						key={previewSerial}
						manualPosition={manualPosition}
						onManualPositionChange={setManualPosition}
						anchor={markHit.anchor}
						anchorPlacement={markHit.anchorPlacement}
						fixed={markHit.fixed}
						loading={marks.loading}
						items={visibleHitItems}
						translations={hitRecords.translations}
						translationsLoading={chapterTranslations.loading}
						translationsError={chapterTranslations.error}
						unavailable={chapterTranslations.unavailable}
						onRetryTranslations={() => {
							void chapterTranslations.refetch();
						}}
						chapter={chapter.data}
						sourceId={book.source_id}
						direction={settings.writing_mode}
						adoptionSessions={adoptionSessions.current}
						translationSessions={translationSessions}
						onBackToOrigin={backToTranslationOrigin}
						onSaved={() => {
							void client.invalidateQueries({
								queryKey: ["material-chapter-segments", book.id],
							});
						}}
						onOpen={openStudySegment}
						onClose={closeMarkHit}
						expanded={panels.right === "study"}
						inactive={
							panels.right === "study" &&
							compactPanels &&
							panels.activeSide !== "right"
						}
						onExpand={() => {
							jumpReading.current.pause();
							invalidateNavigation();
							navigation.current.dismissError();
							setPanels((current) => selectReaderPanel(current, "study"));
							controller.current?.show();
						}}
						onCollapse={closeMarkHit}
						onEmphasize={(id, kind = "segment") => {
							previewEmphasis.current = id ? { id, kind } : null;
							frames.current.emphasizeStudyMark(id, kind);
						}}
					/>
				)}
			{savedNotice && (
				<SavedSegmentNotice
					key={savedNotice.serial}
					id={savedNotice.id}
					kind={savedNotice.kind}
					onOpen={() => openStudySegment(savedNotice.id)}
					onClose={() => setSavedNotice(null)}
				/>
			)}
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
						void changeBookUi(DEFAULT_BOOK_UI);
						change(defaults);
						setUiPreference(DEFAULT_READER_UI);
					}}
					onClose={() => closePanel("right")}
				/>
			)}
			{panels.right === "settings" && (rubyPreparing || rubyError) && (
				<p
					className="reader-preference-notice"
					role={rubyError ? "alert" : "status"}
				>
					{rubyError
						? `注音暂不可用，已保留当前阅读范围。${rubyError.message}`
						: "正在获取全量注音，当前阅读可继续。"}
				</p>
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
					chapterProgress={
						new Map(
							Array.from(chapterPositions, ([id, value]) => [
								id,
								value.progress,
							]),
						)
					}
					onBeginning={() =>
						void navigation.current.navigate({ type: "beginning" }, "left")
					}
					closing={leftView.exiting}
					inactive={
						compactPanels && !!panels.right && panels.activeSide === "right"
					}
					tab={leftView.value}
					onTab={(tab) => selectPanel(tab)}
					onChoose={(id) =>
						void navigation.current.navigate({ type: "chapter", id }, "left")
					}
					settings={settings}
					navigationError={navigationError}
					onCancelNavigation={() => {
						invalidateNavigation();
					}}
					onClose={() => closePanel("left")}
					onNavigate={(target, mark) =>
						void navigation.current.navigate(
							{ type: "position", target, mark },
							"left",
						)
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
						invalidateNavigation();
					}}
					onClose={() => closePanel("right")}
					onNavigate={(target) =>
						void navigation.current.navigate(
							{ type: "position", target },
							"right",
						)
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
	const segmentId = new URLSearchParams(location.search).get("segment");
	const [originSnapshot, setOriginSnapshot] =
		useState<SegmentProvenance | null>(null);
	const origin = useQuery({
		queryKey: ["segments", segmentId, "material-provenance"],
		queryFn: ({ signal }) => getSegmentProvenance(segmentId ?? "", signal),
		enabled: !!segmentId,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
	});
	useEffect(() => {
		if (
			!originSnapshot &&
			origin.isSuccess &&
			origin.isFetchedAfterMount &&
			!origin.isFetching
		)
			setOriginSnapshot(origin.data);
	}, [
		originSnapshot,
		origin.isSuccess,
		origin.isFetchedAfterMount,
		origin.isFetching,
		origin.data,
	]);
	const resolvedOrigin =
		originSnapshot ?? (origin.isSuccess ? origin.data : null);
	let locationFailure: Error | null = null;
	if (segmentId && resolvedOrigin) {
		const message = originFailure(resolvedOrigin);
		if (message) locationFailure = new Error(message);
		else if (resolvedOrigin.material_provenance?.material_id !== id)
			locationFailure = new Error("片段出处不属于当前材料，无法精确定位。");
		else {
			try {
				originPosition(resolvedOrigin, defaults);
			} catch (failure) {
				locationFailure =
					failure instanceof Error ? failure : new Error(String(failure));
			}
		}
	}
	const [snapshot, setSnapshot] = useState<Material | null>(null);
	const startedVersion = useRef<string | null>(null);
	const preparation = useMutation({
		mutationFn: (version: string) => prepareReadings(id, version),
	});
	const { mutate: prepare } = preparation;
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
			navigate(`${location.pathname}${location.search}`, {
				replace: true,
				state,
			});
		}
	}, [notice, location.pathname, location.search, location.state, navigate]);
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
	useEffect(() => {
		if (snapshot && startedVersion.current !== snapshot.version_id) {
			startedVersion.current = snapshot.version_id;
			prepare(snapshot.version_id);
		}
	}, [snapshot, prepare]);
	if (
		snapshot &&
		segmentId &&
		resolvedOrigin &&
		!locationFailure &&
		resolvedOrigin.material_provenance?.version_id !== snapshot.version_id
	)
		locationFailure = new Error(
			"出处绑定的材料版本不可用，不能套用到当前版本。",
		);
	if (
		snapshot &&
		preparation.data?.version_id === snapshot.version_id &&
		(!segmentId || (originSnapshot && !locationFailure))
	)
		return (
			<Reader
				key={`${id}-${segmentId ?? "reading"}`}
				initialOrigin={segmentId ? originSnapshot : null}
				book={snapshot}
				notice={notice}
				readingsSummary={preparation.data}
			/>
		);
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
			<Link to={back.to} state={back.state}>
				← {back.label}
			</Link>
			<div className="reader-loading">
				{book.isError ||
				preparation.isError ||
				origin.isError ||
				locationFailure ? (
					<>
						<InlineError
							error={
								book.error ??
								preparation.error ??
								origin.error ??
								locationFailure
							}
						/>
						<button
							type="button"
							onClick={() => {
								if (segmentId) {
									setOriginSnapshot(null);
									void origin.refetch();
								}
								if (snapshot) prepare(snapshot.version_id);
								else void book.refetch();
							}}
						>
							重试打开
						</button>
					</>
				) : (
					<p>{snapshot ? "正在准备全书注音…" : "正在打开书籍…"}</p>
				)}
			</div>
		</main>
	);
}
export function MaterialReader() {
	const { id = "" } = useParams();
	const location = useLocation();
	const segmentId = new URLSearchParams(location.search).get("segment");
	return <MaterialOpening key={`${id}-${segmentId ?? "reading"}`} id={id} />;
}
