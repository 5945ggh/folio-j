import "./reader-r1.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
	Link,
	type Location,
	useLocation,
	useNavigate,
	useParams,
} from "react-router";
import { Icon as CatalogIcon } from "../catalog/LibraryTools";
import { refreshMaterialAnalysis } from "../catalog/statistics-query";
import { getSource, queries, RequestError, type Segment } from "../content";
import {
	type ReturnDestination,
	returnDestination,
	returnState,
	updateSegmentLocation,
} from "../navigation";
import {
	useViewActivity,
	ViewActivityProvider,
} from "../navigation/view-activity";
import { InlineError } from "../Shared";
import type { ContextCopySettings } from "../settings/context-copy-api";
import { contextCopyKey } from "../settings/context-copy-cache";
import { SpeechPlaybackBar, useStopSpeechOnLeave } from "../speech";
import { getSpeechController } from "../speech/browser";
import {
	getTranslationResult,
	type TranslationResult,
} from "../translation/api";
import { TranslationPreferences } from "../translation/preference";
import { useTranslationSessions } from "../translation/session-react";
import { targetText, translationTargetKey } from "../translation/state";
import { TranslationPanel } from "../translation/TranslationPanel";
import type { TranslationRemoved } from "../translation/TranslationRemoval";
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
import { marginRecordEntry, sameMarginRecordHit } from "./chapter-records";
import {
	useChapterTranslations,
	useMaterialTranslationActivity,
} from "./chapter-translations-query";
import { buildContextCopy } from "./context-copy";
import {
	imagePrecedesText,
	nearestText,
	textRect,
	textSamplingTarget,
} from "./dom";
import { createFocusController, isReaderFrameTarget } from "./focus";
import { READER_EXIT_MS, useReaderPresence } from "./motion";
import { NavigationHighlightLifetime } from "./navigation-highlight";
import {
	cacheSavedPosition,
	registerPositionWriter,
	waitForPositionWrites,
} from "./persistence";
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
	READER_UI_KEY,
	type ReaderUiPreferences,
	readBookUiPreferences,
	readReaderUiPreferences,
	resolveReaderTheme,
	writeBookUiPreferences,
	writeReaderUiPreferences,
} from "./preferences";
import { ReaderBookmarkNotice, useReaderBookmarks } from "./ReaderBookmarks";
import { ContextCopyFeedback, useReaderContextCopy } from "./ReaderContextCopy";
import { ReaderIcon, ReaderPanel, ReaderSettings } from "./ReaderControls";
import { ReaderCopyLeaveGuard } from "./ReaderCopyLeaveGuard";
import { ReaderLeaveProvider } from "./ReaderLeaveProvider";
import {
	ReaderDirectImageViewer,
	ReaderGalleryPanel,
	ReaderNavigationPanel,
} from "./ReaderPanels";
import {
	type ReaderFrame as Frame,
	partDocument,
	ReaderFrames,
} from "./reader-frames";
import { ReaderImageCache } from "./reader-image-cache";
import { ReaderNavigation } from "./reader-navigation";
import {
	originFailure,
	originPosition,
	recordOriginPosition,
} from "./reader-origin";
import {
	closeReaderPanel,
	EMPTY_READER_PANELS,
	type ReaderPanelKind,
	type ReaderPanelSide,
	type ReaderPanelsState,
	selectReaderPanel,
} from "./reader-panel-logic";
import {
	ReaderPresentation,
	type ReaderPresentationState,
	type ReaderRestoreIntent,
} from "./reader-presentation";
import {
	EMPTY_READER_RECORD_STATE,
	type ReaderRecordContext,
	ReaderRecordPresentation,
} from "./reader-record-presentation";
import { readerResourceCache } from "./reader-resource-cache";
import type { ReaderHighlightRange } from "./reader-selection";
import {
	cancelReaderSessionReads,
	canResumeReader,
	readerSessionIdentity,
} from "./reader-session";
import {
	DEFAULT_READER_SETTINGS_EXPANDED,
	DEFAULT_READING_SETTINGS,
	restoreReaderSettingsGroup,
} from "./reader-settings";
import type { ScreenAnchor, StudyMarkHit } from "./reader-study";
import { JumpReadingSession, returnOriginLabel } from "./return-origin";
import { SavedSegmentNotice, SelectionToolbar } from "./StudyOverlays";
import { StudySegmentPanel } from "./StudySegmentPanel";
import { readerWheelScroll } from "./scroll";
import {
	getSegmentProvenance,
	type MaterialProvenance,
	type SegmentProvenance,
	type StudyTarget,
} from "./study-api";
import type { StudyMarginEntry } from "./study-margin";
import { useChapterStudyMarks } from "./study-marks-query";
import { nativeSelectionKey } from "./study-overlays";
import { freshestUsage, OpenAction } from "./usage";
import {
	type ReaderCopyEditor,
	useReaderCopyEditor,
} from "./use-reader-copy-editor";
import {
	atChapterEnd,
	chapterEndAdjustment,
	readingFrameDistance,
	readingViewport,
	viewportSize,
} from "./viewport";
import {
	readVocabularyReaderTarget,
	type VocabularyReaderTarget,
	validateVocabularyReaderTarget,
	vocabularyReaderPosition,
} from "./vocabulary-navigation";

const defaults: Settings = DEFAULT_READING_SETTINGS;
type ReaderPositionWriter = {
	current: PositionQueue<Position> | null;
	healthy: boolean;
};
function Reader({
	book,
	returnTo,
	notice,
	readingsSummary,
	initialOrigin,
	initialVocabulary,
	sessionToken,
	discard,
	positionWriter,
	copyEditor,
	copyEditRequest,
	onThemeChange,
}: {
	book: Material;
	returnTo: ReturnDestination;
	sessionToken: string;
	discard: { current: boolean };
	positionWriter: ReaderPositionWriter;
	copyEditor: ReaderCopyEditor;
	copyEditRequest: number;
	onThemeChange: (theme: "white" | "black") => void;
	initialOrigin: SegmentProvenance | null;
	initialVocabulary: VocabularyReaderTarget | null;
	readingsSummary: ReadingsSummary;
	notice: "imported" | "reused" | null;
}) {
	const { active, activation } = useViewActivity();
	const activeRef = useRef(active);
	activeRef.current = active;
	useStopSpeechOnLeave(book.id);
	useMaterialTranslationActivity(book.id, active, activation);
	const [translationTarget, setTranslationTarget] =
		useState<StudyTarget | null>(null);
	const [translationOpen, setTranslationOpen] = useState(false);
	const [translationAnchor, setTranslationAnchor] =
		useState<ScreenAnchor | null>(null);
	const client = useQueryClient();
	const selectedTranslations = useRef(new TranslationPreferences());
	const rememberTranslation = useCallback((result: TranslationResult) => {
		selectedTranslations.current.remember(result);
	}, []);
	const translationSessions = useTranslationSessions();
	const readingGeneration = readingsSummary.generation_id;
	const navigate = useNavigate();
	const initialAnchor = initialVocabulary
		? vocabularyReaderPosition(
				initialVocabulary,
				book.reading_position?.settings ?? defaults,
			)
		: initialOrigin
			? originPosition(
					initialOrigin,
					book.reading_position?.settings ?? defaults,
				)
			: book.reading_position;
	const [studyTarget, setStudyTarget] = useState<StudyTarget | null>(null);
	const [selectionError, setSelectionError] = useState<Error | null>(null);
	const [originError, setOriginError] = useState<Error | null>(null);
	const [recordState, setRecordState] = useState(EMPTY_READER_RECORD_STATE);
	const { selection, markHit, manualPosition, inlineRequest, previewSerial } =
		recordState;
	const frames = useRef(new ReaderFrames());
	const recordContext = useRef<ReaderRecordContext | null>(null);
	const [records] = useState(
		() =>
			new ReaderRecordPresentation({
				current: () => {
					if (!recordContext.current)
						throw new Error("Reader record context is unavailable");
					return {
						...recordContext.current,
						active: activeRef.current,
						alive: alive.current,
					};
				},
				frames: frames.current,
				closeStudyPanel: () =>
					setPanels((current) =>
						current.right === "study"
							? closeReaderPanel(current, "right")
							: current,
					),
				hideTranslation: () => setTranslationOpen(false),
				showTools: () => controller.current?.show(),
				changed: setRecordState,
			}),
	);
	const [marginEntries, setMarginEntries] = useState<StudyMarginEntry[]>([]);
	const [markError, setMarkError] = useState<Error | null>(null);
	const [savedNotice, setSavedNotice] = useState<{
		id: string;
		kind: "created" | "existing";
		serial: number;
	} | null>(null);
	const source = useQuery({
		queryKey: queries.source(book.source_id),
		enabled: active,
		queryFn: () => getSource(book.source_id),
	});
	const usage = useQuery({
		queryKey: usageKey(book.id),
		enabled: active,
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
		if (active && presented) void opened();
	}, [active, presented, opened]);
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
	const [presentationState, setPresentationState] =
		useState<ReaderPresentationState>({
			chapterId: initialAnchor?.chapter_id ?? book.chapters[0]?.id ?? "",
			settings: book.reading_position?.settings ?? defaults,
			generation: 0,
			layoutRevision: 0,
		});
	const { chapterId, settings, generation } = presentationState;
	const contextCopy = useReaderContextCopy(
		active && selection
			? `${chapterId}:${generation}:${translationTargetKey(selection.target.reference)}`
			: null,
	);
	const bookmarks = useReaderBookmarks(book.id, book.version_id);
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
	const copySettings = copyEditor.query;
	const [settingsExpanded, setSettingsExpanded] = useState(
		DEFAULT_READER_SETTINGS_EXPANDED,
	);
	const settingsScrollTop = useRef(0);
	const copyEditorStatus = copyEditor.pending
		? "处理中"
		: copyEditor.needsReload || copyEditor.noticeError || copySettings.isError
			? "待处理"
			: copyEditor.dirty
				? "未保存"
				: "";
	const [copySettingsError, setCopySettingsError] = useState<Error | null>(
		null,
	);
	const [bookUi, setBookUi] = useState(() =>
		readBookUiPreferences(book.id, book.version_id),
	);
	const [systemDark, setSystemDark] = useState(
		() => matchMedia("(prefers-color-scheme: dark)").matches,
	);
	const theme = resolveReaderTheme(ui.theme, systemDark);
	useLayoutEffect(() => onThemeChange(theme), [theme, onThemeChange]);
	const [storageFailed, setStorageFailed] = useState(false);
	const jumpReading = useRef(new JumpReadingSession());
	const [directImage, setDirectImage] = useState<
		| {
				chapterId: string;
				partIndex: number;
				imageId: number;
				requestId: number;
				source: { src: string; alt: string };
		  }
		| undefined
	>();
	const [imageCache] = useState(
		() => new ReaderImageCache(readerResourceCache(client)),
	);
	const cacheCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	useEffect(() => {
		if (cacheCloseTimer.current) clearTimeout(cacheCloseTimer.current);
		return () => {
			cacheCloseTimer.current = setTimeout(() => imageCache.close(), 0);
		};
	}, [imageCache]);
	const galleryTicket = useRef(0);
	const [galleryRequest, setGalleryRequest] = useState<{
		ordinal: number;
		requestId: number;
	}>();
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
	const pendingOrigin = useRef<SegmentProvenance | null>(null);
	const pendingVocabulary = useRef<VocabularyReaderTarget | null>(null);
	const highlight = useRef<{
		chapterId: string;
		ranges: readonly ReaderHighlightRange[];
		kind: "study" | "search";
	} | null>(
		initialVocabulary
			? {
					kind: "search",
					chapterId: initialVocabulary.chapter_id,
					ranges: [initialVocabulary],
				}
			: initialOrigin?.material_provenance && initialOrigin.chapter_id
				? {
						kind: "study",
						chapterId: initialOrigin.chapter_id,
						ranges: initialOrigin.material_provenance.ranges,
					}
				: null,
	);
	const navigationHighlight = useRef<NavigationHighlightLifetime | null>(null);
	if (!navigationHighlight.current) {
		navigationHighlight.current = new NavigationHighlightLifetime(
			() => {
				if (highlight.current?.kind === "search") highlight.current = null;
				frames.current.clearSearchHighlights();
			},
			undefined,
			{ opacity: (value) => frames.current.setSearchHighlightOpacity(value) },
		);
	}
	useEffect(() => () => navigationHighlight.current?.dispose(), []);
	useEffect(() => {
		if (initialVocabulary) navigationHighlight.current?.replace();
	}, [initialVocabulary]);
	const latest = useRef({
		panels,
		chapterId,
		compactPanels,
		theme,
		bookUi,
		settings,
		directImage,
		presented,
		ui,
		translationTarget,
		studyActive: translationOpen || studyTarget !== null,
	});
	latest.current = {
		panels,
		chapterId,
		compactPanels,
		theme,
		bookUi,
		settings,
		directImage,
		presented,
		ui,
		translationTarget,
		studyActive: translationOpen || studyTarget !== null,
	};
	const dismissReadingBackground = useCallback(
		() => records.dismissBackground(),
		[records],
	);
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
			records.panelSelected(next);
			jumpReading.current.pause();
			invalidateNavigation();
			navigation.current.dismissError();
			setPanels((current) =>
				selectReaderPanel(current, next, toggle, latest.current.compactPanels),
			);
			controller.current?.show();
		},
		[invalidateNavigation, records],
	);
	const closePanel = useCallback(
		(side?: ReaderPanelSide, invalidate = true) => {
			records.panelClosed(side);
			jumpReading.current.pause();
			if (invalidate) invalidateNavigation();
			setPanels((current) =>
				side ? closeReaderPanel(current, side) : EMPTY_READER_PANELS,
			);
			controller.current?.show();
		},
		[invalidateNavigation, records],
	);
	useEffect(() => {
		const escapeViewer = (event: KeyboardEvent) => {
			if (!activeRef.current) return;
			if (
				event.key !== "Escape" ||
				event.isComposing ||
				event.defaultPrevented ||
				!viewerEscape.current
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
		if (!active || !shell.current) return;
		const focus = createFocusController({
			root: shell.current,
			focus: readReaderUiPreferences().focus,
			onVisibilityChange: setToolsVisible,
			onBackgroundTap: dismissReadingBackground,
			onTabReveal: (event, wasHidden) => {
				flushSync(() => setToolsVisible(true));
				if ((event.target as Element | null)?.closest?.('[aria-modal="true"]'))
					return;
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
				records.active ||
				latest.current.directImage !== undefined ||
				latest.current.panels.left !== null ||
				latest.current.panels.right !== null ||
				!latest.current.presented,
			onEscapeOverlay: () => {
				if (viewerEscape.current) {
					viewerEscape.current();
					return true;
				}
				if (records.escape()) return true;
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
	}, [active, closePanel, records, dismissReadingBackground, setUiPreference]);
	useEffect(() => {
		controller.current?.setFocus(ui.focus);
	}, [ui.focus]);
	useEffect(() => {
		if (panels.left || panels.right || !presented) controller.current?.show();
		controller.current?.refresh();
	}, [panels, presented]);
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
		staleTime: Number.POSITIVE_INFINITY,
		enabled: active && !!chapterId,
	});
	const marks = useChapterStudyMarks(
		book.id,
		book.version_id,
		chapterId,
		active,
		activation,
	);
	const chapterTranslations = useChapterTranslations(
		book.id,
		book.version_id,
		chapterId,
		active,
		activation,
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
		enabled: active && !!chapterId,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const viewportReady =
		chapter.isSuccess && (bookUi.rubyScope !== "all" || readings.isSuccess);
	const container = useRef<HTMLElement>(null);
	const presentation = useRef(
		new ReaderPresentation(presentationState, initialAnchor, {
			frames: frames.current,
			navigation: navigation.current,
			reading: jumpReading.current,
			writer: () => queue.current,
			changed: setPresentationState,
		}),
	);
	const alive = useRef(true);
	const inlineMutation = useRef(false);
	useLayoutEffect(() => {
		presentation.current.setActive(active, discard.current);
		return () => presentation.current.setActive(false, discard.current);
	}, [active, discard]);
	recordContext.current = {
		active,
		alive: alive.current,
		materialId: book.id,
		versionId: book.version_id,
		chapterId,
		chapter: chapter.data,
		direction: settings.writing_mode,
		panels,
		compactPanels,
		studyTargetActive: studyTarget !== null,
		segments: marks.items,
		translations: chapterTranslations.items,
		settled:
			!marks.loading &&
			!marks.isFetching &&
			!chapterTranslations.loading &&
			!chapterTranslations.isFetching,
	};
	const openMarkHit = useCallback(
		(value: StudyMarkHit, trigger: HTMLButtonElement | null = null) =>
			records.openPreview(value, trigger),
		[records],
	);
	const closeMarkHit = useCallback(() => records.closePreview(), [records]);
	useLayoutEffect(() => {
		frames.current.bindStudy({
			materialId: book.id,
			versionId: book.version_id,
			chapterId,
			onSelection: (value) => records.selectionChanged(value),
			onEntries: setMarginEntries,
			onMarks: (value) => records.markChanged(value),
			onBackgroundTap: dismissReadingBackground,
		});
	});
	const hitRecords = records.hitRecords;
	const visibleHitItems = hitRecords.segments;
	const forgetTranslation = useCallback<TranslationRemoved>(
		(removed, reference) => {
			selectedTranslations.current.forget(removed.identity_sha256);
			records.translationRemoved(removed.identity_sha256);
			if (
				latest.current.translationTarget &&
				translationTargetKey(latest.current.translationTarget.reference) ===
					translationTargetKey(reference)
			) {
				setTranslationOpen(false);
				setTranslationTarget(null);
			}
		},
		[records],
	);
	const inlineResult = useQuery({
		queryKey: ["translation-result", inlineRequest?.item.result_id],
		queryFn: ({ signal }) =>
			getTranslationResult(inlineRequest?.item.result_id ?? "", signal),
		staleTime: Number.POSITIVE_INFINITY,
		enabled:
			active &&
			!!inlineRequest &&
			inlineRequest.chapterId === chapterId &&
			settings.writing_mode === "horizontal-tb",
		retry: false,
	});
	useEffect(() => {
		records.reconcile();
	});
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
				if (state === "error") positionWriter.healthy = false;
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
	positionWriter.current = queue.current;
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
		if (!activeRef.current || frames.current.inlineMotionRunning) return null;
		if (
			!root ||
			!chapter.data ||
			!presentation.current.canSample(viewportSize(root))
		)
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
			!activeRef.current ||
			!root ||
			document.hidden ||
			!document.hasFocus() ||
			navigation.current.state.returning ||
			!presentation.current.canSample(viewportSize(root))
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
			if (!activeRef.current || !event.isTrusted || event.defaultPrevented)
				return;
			const target = event.target as Node | null;
			if (
				target?.ownerDocument &&
				target.ownerDocument !== document &&
				!isReaderFrameTarget(target.ownerDocument, target)
			)
				return;
			frames.current.finishInlineMotion();
			// Sample before granting input so a prior programmatic move cannot count.
			navigationHighlight.current?.clear();
			if (sampleJumpReading()) jumpReading.current.input(performance.now());
		},
		[sampleJumpReading],
	);
	const readWheel = useCallback(
		(event: WheelEvent, outside = false) => {
			const root = container.current;
			if (
				!activeRef.current ||
				!root ||
				event.ctrlKey ||
				event.defaultPrevented
			)
				return;
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
		if (!activeRef.current || !root || frames.current.inlineMotionRunning)
			return;
		const anchor = presentation.current.observe(viewportSize(root), capture);
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
		(
			anchor: Position | null,
			{ initialPresentation, beginning }: ReaderRestoreIntent,
		) => {
			const root = container.current;
			const data = chapter.data;
			if (!activeRef.current || !root || !data) return false;
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
			// Margin markers can retain the previous layout's overflow until React
			// commits their new coordinates. Reset that axis before locating text.
			if (vertical) root.scrollTop = 0;
			else root.scrollLeft = 0;
			let navigationFailure: Error | undefined;
			if (beginning) {
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
								"无法精确定位原文，已保留附近正文。",
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

			return {
				located,
				error: navigationFailure,
				afterRestore: () => {
					setPresented(true);
					if (located && highlight.current?.kind === "search")
						navigationHighlight.current?.presented();
					frames.current.refreshStudyGeometry();
					if (!inlineMutation.current) observe();
				},
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
	const reflowFrames = useCallback(() => {
		if (activeRef.current) presentation.current.reflow();
	}, []);
	const mutateInlineLayout = useCallback(
		(update: () => void) => {
			const root = container.current;
			const data = chapter.data;
			if (!activeRef.current) return;
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
				inlineMutation.current = true;
				try {
					presentation.current.reflow(
						() => {
							applied = true;
							update();
						},
						() => anchor,
					);
				} finally {
					inlineMutation.current = false;
				}
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
		presentation.current.mount();
		const unregister = queue.current
			? registerPositionWriter(book.id, queue.current)
			: () => {};
		return () => {
			alive.current = false;
			presentation.current.unmount(discard.current);
			unregister();
		};
	}, [book.id, discard]);
	const load = (index: number, element: HTMLIFrameElement, token: number) => {
		if (!chapter.data) return;
		presentation.current.load(index, element, token, {
			chapter: chapter.data,
			readingGeneration,
			readings: readings.data,
			current: () => latest.current,
			root: () => container.current,
			bindFocus: (doc, frame) => controller.current?.bindFrame(doc, frame),
			key: readKey,
			wheel: readWheel,
			touch: recordReadingInput,
			interaction: recordReadingInput,
			image: (partIndex, imageId, source) => {
				jumpReading.current.pause();
				invalidateNavigation();
				controller.current?.show();
				setDirectImage({
					requestId: ++galleryTicket.current,
					chapterId,
					partIndex,
					imageId,
					source,
				});
			},
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
		if (!active || !viewportReady) return;
		const root = container.current;
		if (!root) return;
		let lastWidth = root.clientWidth,
			lastHeight = root.clientHeight;
		const resize = () => {
			if (!activeRef.current || root !== container.current || !alive.current)
				return;
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
	}, [active, reflowFrames, generation, viewportReady]);
	useLayoutEffect(() => {
		if (!active) return;
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
			presentedAnchor: () => presentation.current.presentedAnchor(capture),
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
				if (!root || !presentation.current.canSample(viewportSize(root)))
					return false;
				const offset =
					latest.current.settings.writing_mode === "vertical-rl"
						? root.scrollLeft
						: root.scrollTop;
				return Number.isFinite(offset) && Math.abs(offset) <= 1;
			},
			loadChapter: (id) => {
				if (chapter.data?.id === id) return Promise.resolve(chapter.data);
				navigationHighlight.current?.clear(true);
				return client.fetchQuery({
					queryKey: materialKeys.chapter(book.id, id),
					queryFn: () => getChapter(book.id, id),
				});
			},
			saveDeparture: (anchor) => {
				queue.current?.enqueue(anchor);
			},
			present: (destination, complete) => {
				if (!destination) {
					presentation.current.present(null, complete, capture);
					return;
				}
				const { target, mark, part: targetPart, highlightRanges } = destination;
				highlight.current = highlightRanges
					? {
							kind: "search",
							chapterId: target.chapter_id,
							ranges: highlightRanges,
						}
					: mark
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
				if (
					pendingOrigin.current?.chapter_id === target.chapter_id &&
					pendingOrigin.current.material_provenance
				) {
					highlight.current = {
						kind: "study",
						chapterId: target.chapter_id,
						ranges: pendingOrigin.current.material_provenance.ranges,
					};
					pendingOrigin.current = null;
				}
				if (pendingVocabulary.current?.chapter_id === target.chapter_id) {
					highlight.current = {
						kind: "search",
						chapterId: target.chapter_id,
						ranges: [pendingVocabulary.current],
					};
					pendingVocabulary.current = null;
				}
				if (highlight.current?.kind === "search")
					navigationHighlight.current?.replace();
				else navigationHighlight.current?.clear(true);
				setOriginError(null);
				const previousChapter = presentation.current.state.chapterId;
				presentation.current.present(destination, complete, capture);
				if (previousChapter !== target.chapter_id) setProgress(null);
			},
			closePanels: (side) => closePanel(side, false),
			changed: setNavigationState,
		});
	});
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
			if (!activeRef.current) return;
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
		if (!active) return;
		document.addEventListener("keydown", readKey);
		return () => document.removeEventListener("keydown", readKey);
	}, [active, readKey]);
	const [rubyPreparing, setRubyPreparing] = useState(false);
	const [rubyError, setRubyError] = useState<Error | null>(null);
	const preferenceSubmission = useRef(new ReaderPreferenceSubmission());
	const change = (next: Settings) => {
		setTranslationAnchor(null);
		presentation.current.change(next, capture);
	};
	useLayoutEffect(() => {
		if (!active) return;
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
		if (!active || !viewportReady) return;
		const root = container.current;
		const data = chapter.data;
		if (!root || !data) return;

		try {
			presentation.current.commit(
				{
					state: presentationState,
					chapter: data,
					theme,
					bookUi,
					readings: readings.data,
				},
				{
					size: () => (container.current === root ? viewportSize(root) : null),
					capture,
					restore,
				},
			);
		} catch (failure) {
			setError(failure instanceof Error ? failure : new Error(String(failure)));
		}
	}, [
		active,
		presentationState,
		viewportReady,
		bookUi,
		theme,
		chapter.data,
		readings.data,
		capture,
		restore,
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the record module reads these committed content and visibility values through current().
	useLayoutEffect(() => {
		records.presentInline(
			inlineRequest,
			inlineResult.data,
			inlineResult.isError,
			mutateInlineLayout,
		);
	}, [
		records,
		active,
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
	]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: wait for React to commit the updated margin coordinates.
	useLayoutEffect(() => {
		if (active) frames.current.inlineMarginsChanged();
	}, [active, marginEntries]);
	const leave = () => presentation.current.checkpoint(capture);

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
		if (!active || !chapter.data || !viewportReady) return;
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
		active,
		chapter.data,
		viewportReady,
		recordMarks,
		ui.marks.studySegmentUnderlines,
		ui.marks.studySegmentMargins,
		panels.left,
		panels.right,
		leftView.value,
		rightView.value,
	]);

	useLayoutEffect(() => {
		if (active) return;
		navigationHighlight.current?.clear(true);
		navigationHighlight.current?.dispose();
		preferenceSubmission.current.suspend();
		getSpeechController().stop();
	}, [active]);
	const previousSession = useRef(sessionToken);
	useEffect(() => {
		if (!active || previousSession.current === sessionToken) return;
		previousSession.current = sessionToken;
		if (initialVocabulary) {
			pendingVocabulary.current = initialVocabulary;
			void navigation.current.navigate({
				type: "position",
				target: vocabularyReaderPosition(
					initialVocabulary,
					latest.current.settings,
				),
				mark: { start: initialVocabulary.start, end: initialVocabulary.end },
			});
			return;
		}
		if (!initialOrigin) return;
		pendingOrigin.current = initialOrigin;
		void navigation.current.navigate({
			type: "position",
			target: originPosition(initialOrigin, latest.current.settings),
		});
	}, [active, sessionToken, initialOrigin, initialVocabulary]);

	const locateRecordOrigin = (
		reference: MaterialProvenance,
		data: Chapter | undefined,
		targetChapterId: string,
	) => {
		try {
			if (
				!data ||
				data.id !== targetChapterId ||
				data.material_id !== book.id ||
				data.version_id !== book.version_id
			)
				throw new Error("原文版本或位置不可用");
			const target = recordOriginPosition(reference, data, settings);
			setSelectionError(null);
			closeMarkHit();
			setTranslationOpen(false);
			void navigation.current.navigate({
				type: "position",
				target,
				highlightRanges: reference.ranges,
			});
		} catch (failure) {
			setSelectionError(
				failure instanceof Error ? failure : new Error(String(failure)),
			);
		}
	};
	const backToTranslationOrigin = (
		result: TranslationResult,
		boundChapter?: Chapter,
	) => {
		const targetChapterId = boundChapter?.id ?? chapterId;
		if (result.material_deleted || result.chapter_id !== targetChapterId) {
			setSelectionError(new Error("原文版本或位置不可用"));
			return;
		}
		locateRecordOrigin(
			result.material_provenance,
			boundChapter ?? chapter.data,
			targetChapterId,
		);
	};
	const renderToken = generation;
	const handledCopyEdit = useRef(0);
	useEffect(() => {
		if (!active || copyEditRequest === handledCopyEdit.current) return;
		handledCopyEdit.current = copyEditRequest;
		setSettingsExpanded((previous) => ({ ...previous, copy: true }));
		selectPanel("settings");
		controller.current?.show();
	}, [active, copyEditRequest, selectPanel]);
	return (
		<main
			ref={shell}
			className="reader-r1"
			data-presented={presented}
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
					"--reader-toolbar-opacity": `${ui.toolbarOpacity}%`,
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
								(chapter.isError ? (
									"章节暂不可用"
								) : (
									<span className="reader-pending-message">正在打开章节…</span>
								))}
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
				{copySettingsError && (
					<button
						type="button"
						disabled={copySettings.isFetching}
						onClick={() => {
							void copySettings.refetch().then((result) => {
								if (result.isSuccess) {
									setCopySettingsError((current) =>
										current === copySettingsError ? null : current,
									);
									setSelectionError((current) =>
										current === copySettingsError ? null : current,
									);
								}
							});
						}}
					>
						重新读取复制设置
					</button>
				)}
				{originError && (
					<button
						type="button"
						onClick={() => {
							setError(null);
							setOriginError(null);
							presentation.current.retry();
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
				<div className="reader-loading reader-pending-message" role="status">
					正在打开章节…
				</div>
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
					key={`${chapterId}-${generation}`}
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
						marginEntries.map((entry) => {
							const count =
								entry.segmentIds.length + (entry.translationIds?.length ?? 0);
							const translation = !!entry.translationIds?.length;
							return (
								<button
									key={`${entry.segmentIds.join(":")}|${entry.translationIds?.join(":") ?? ""}`}
									type="button"
									className="reader-study-margin"
									data-reader-tool=""
									style={{ left: entry.left, top: entry.top }}
									aria-expanded={Boolean(
										markHit && sameMarginRecordHit(markHit, entry),
									)}
									aria-label={
										count > 1
											? `查看此处 ${count} 条记录`
											: translation
												? "打开此处翻译"
												: "打开此处学习片段"
									}
									onClick={(event) => {
										const current = records.state.markHit;
										if (current && sameMarginRecordHit(current, entry)) {
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
									{count > 1 ? (
										count
									) : translation ? (
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
											<path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h6" />
										</svg>
									)}
								</button>
							);
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
							data-tooltip="目录、书签与搜索"
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
						aria-label="添加当前位置书签"
						data-tooltip="添加当前位置书签"
						disabled={bookmarks.busy || chapterSwitchBusy || !presented}
						onClick={() =>
							bookmarks.add(() => {
								if (navigation.current.state.busy) return null;
								const sampled = capture();
								return sampled
									? presentation.current.presentedAnchor(() => sampled)
									: null;
							})
						}
					>
						<ReaderIcon name="bookmark" />
					</button>
					<button
						type="button"
						aria-label="插图库"
						data-tooltip="插图库"
						aria-expanded={panels.right === "gallery"}
						onClick={() => {
							if (panels.right !== "gallery") {
								setGalleryRequest(undefined);
							}
							selectPanel("gallery", true);
						}}
					>
						<ReaderIcon name="image" />
					</button>
					<button
						type="button"
						aria-label="阅读设置"
						className="reader-settings-trigger"
						data-tooltip={
							copyEditorStatus
								? `阅读设置 · 复制设置${copyEditorStatus}`
								: "阅读设置"
						}
						aria-expanded={panels.right === "settings"}
						onClick={() => selectPanel("settings", true)}
					>
						Aa
						{copyEditorStatus && (
							<small className="reader-settings-pending-label" role="status">
								{copyEditorStatus}
							</small>
						)}
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
			<ReaderBookmarkNotice
				bookmarks={bookmarks}
				onEdit={() => selectPanel("bookmarks")}
			/>
			<SpeechPlaybackBar />
			{translationTarget && (
				<div hidden={!translationOpen}>
					<TranslationPanel
						key={translationTargetKey(translationTarget.reference)}
						materialId={book.id}
						onResultSelected={rememberTranslation}
						onRemoved={forgetTranslation}
						translationSessions={translationSessions}
						visible={active && translationOpen}
						anchor={translationAnchor}
						direction={settings.writing_mode}
						sourceId={book.source_id}
						target={translationTarget}
						autoStart
						onOpenSegment={openStudySegment}
						onClose={() => {
							setTranslationOpen(false);
							requestAnimationFrame(() =>
								container.current?.focus({ preventScroll: true }),
							);
						}}
						onBackToOrigin={(result) =>
							backToTranslationOrigin(result, translationTarget.chapter)
						}
					/>
				</div>
			)}
			{studyTarget && (
				<StudySegmentPanel
					target={studyTarget}
					translations={chapterTranslations.items}
					translationsReady={
						!chapterTranslations.loading && !chapterTranslations.isError
					}
					preferredResultId={selectedTranslations.current.matching(
						studyTarget.reference,
					)}
					sourceId={book.source_id}
					sourceTitle={source.data?.title ?? "所属来源"}
					onCancel={() => setStudyTarget(null)}
					onSaved={(segment: Segment, kind) => {
						setStudyTarget(null);
						records.clearToolbar();
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
					copying={contextCopy.busy}
					onCopy={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!presentation.current.canSample(viewportSize(container.current))
							)
								throw new Error("正文仍在准备，请重新选择。");
							const target = frames.current.captureStudyTarget(
								book.id,
								book.version_id,
								chapter.data,
							);
							const savedCopySettings =
								client.getQueryData<ContextCopySettings>(contextCopyKey);
							if (
								!savedCopySettings ||
								client.getQueryState(contextCopyKey)?.status !== "success"
							) {
								const failure = new Error(
									"复制设置尚未就绪，请重新读取后再复制。原文可继续阅读。",
								);
								setCopySettingsError(failure);
								throw failure;
							}
							setCopySettingsError(null);
							const content = buildContextCopy(
								chapter.data,
								target.reference,
								savedCopySettings,
								book.title,
							);
							setSelectionError(null);
							void contextCopy.copy(content);
						} catch (failure) {
							setSelectionError(
								failure instanceof Error ? failure : new Error(String(failure)),
							);
						}
					}}
					onTranslate={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!presentation.current.canSample(viewportSize(container.current))
							)
								throw new Error("正文仍在准备，请重新选择。");
							const target = frames.current.captureStudyTarget(
								book.id,
								book.version_id,
								chapter.data,
							);
							setTranslationTarget(structuredClone(target));
							void translationSessions
								.forTarget(book.source_id, target)
								.open({ kind: "selection", newSelection: true });
							setTranslationAnchor(selection.anchor);
							setTranslationOpen(true);
							records.clearToolbar();
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
							records.clearToolbar();
						} catch (failure) {
							setSelectionError(
								failure instanceof Error ? failure : new Error(String(failure)),
							);
						}
					}}
					onClose={() => records.clearToolbar()}
					onSave={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!presentation.current.canSample(viewportSize(container.current))
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
							records.clearToolbar();
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
						marginEntry={marginRecordEntry(markHit)}
						manualPosition={manualPosition}
						onManualPositionChange={(value) => records.setManualPosition(value)}
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
						onResultSelected={rememberTranslation}
						onTranslationRemoved={forgetTranslation}
						translationSessions={translationSessions}
						onBackToOrigin={backToTranslationOrigin}
						onOpen={openStudySegment}
						onLocateOriginal={(item) =>
							locateRecordOrigin(
								item.material_provenance,
								chapter.data,
								chapterId,
							)
						}
						onClose={closeMarkHit}
						expanded={panels.right === "study"}
						inactive={
							!active ||
							(panels.right === "study" &&
								compactPanels &&
								panels.activeSide !== "right")
						}
						onExpand={() => {
							jumpReading.current.pause();
							invalidateNavigation();
							navigation.current.dismissError();
							setPanels((current) => selectReaderPanel(current, "study"));
							controller.current?.show();
						}}
						onCollapse={() =>
							setPanels((current) =>
								current.right === "study"
									? closeReaderPanel(current, "right")
									: current,
							)
						}
						onEmphasize={(id, kind = "segment") =>
							records.emphasizePreview(previewSerial, id, kind)
						}
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
			{active && selection && contextCopy.feedback && (
				<ContextCopyFeedback
					feedback={contextCopy.feedback}
					onClose={contextCopy.dismiss}
				/>
			)}
			{rightView.value === "settings" && (
				<ReaderSettings
					copyEditor={copyEditor}
					expanded={settingsExpanded}
					onExpandedChange={setSettingsExpanded}
					scrollTop={settingsScrollTop.current}
					onScrollTop={(value) => {
						settingsScrollTop.current = value;
					}}
					rubyStatus={
						rubyPreparing || rubyError ? (
							<p role={rubyError ? "alert" : "status"}>
								{rubyError
									? `注音暂不可用，已保留当前阅读范围。${rubyError.message}`
									: "正在获取全量注音，当前阅读可继续。"}
							</p>
						) : null
					}
					settings={settings}
					ui={ui}
					bookUi={bookUi}
					closing={rightView.exiting}
					inactive={
						!active ||
						(compactPanels && !!panels.left && panels.activeSide === "left")
					}
					onSettings={change}
					onUi={setUiPreference}
					onBookUi={changeBookUi}
					onResetGroup={(group) => {
						const patch = restoreReaderSettingsGroup(group);
						if (patch.bookUi)
							void changeBookUi({ ...latest.current.bookUi, ...patch.bookUi });
						if (patch.settings)
							change({ ...latest.current.settings, ...patch.settings });
						if (patch.ui)
							setUiPreference({ ...latest.current.ui, ...patch.ui });
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
						!active ||
						(compactPanels && !!panels.right && panels.activeSide === "right")
					}
					bookmarks={bookmarks}
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
					key={`${book.id}-${book.version_id}-${galleryRequest?.requestId ?? "list"}`}
					materialId={book.id}
					versionId={book.version_id}
					imageCache={imageCache}
					bookTitle={book.title}
					settings={settings}
					initialOrdinal={galleryRequest?.ordinal}
					closing={rightView.exiting}
					inactive={
						!active ||
						(compactPanels && !!panels.left && panels.activeSide === "left")
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
			{directImage && (
				<ReaderDirectImageViewer
					key={directImage.requestId}
					materialId={book.id}
					versionId={book.version_id}
					imageCache={imageCache}
					settings={settings}
					target={directImage}
					inactive={!active}
					navigationError={navigationError}
					onViewerEscape={registerViewerEscape}
					onClose={() => {
						invalidateNavigation();
						setDirectImage(undefined);
					}}
					onOpenGallery={(ordinal) => {
						setDirectImage(undefined);
						setGalleryRequest({ ordinal, requestId: ++galleryTicket.current });
						selectPanel("gallery");
					}}
					onNavigate={(target) => {
						void navigation.current
							.navigate({ type: "position", target })
							.then((success) => {
								if (success) setDirectImage(undefined);
							});
					}}
				/>
			)}
			{rightView.value === "info" && (
				<ReaderPanel
					title="书籍信息"
					closing={rightView.exiting}
					inactive={
						!active ||
						(compactPanels && !!panels.left && panels.activeSide === "left")
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

function MaterialOpening({ id, location }: { id: string; location: Location }) {
	const host = useViewActivity();
	const copyEditor = useReaderCopyEditor(host.active);
	const [copyEditRequest, setCopyEditRequest] = useState(0);
	const [dialogHost, setDialogHost] = useState<HTMLDivElement | null>(null);
	const [dialogTheme, setDialogTheme] = useState(() =>
		resolveReaderTheme(
			readReaderUiPreferences().theme,
			matchMedia("(prefers-color-scheme: dark)").matches,
		),
	);
	const client = useQueryClient();
	const navigate = useNavigate();
	const segmentId = new URLSearchParams(location.search).get("segment");
	const [retry, setRetry] = useState(0);
	const token = `${host.activation}:${location.search}:${retry}`;
	const [session, setSession] = useState<{
		book: Material;
		summary: ReadingsSummary;
		origin: SegmentProvenance | null;
		vocabulary: VocabularyReaderTarget | null;
		token: string;
		serial: number;
		activation: number;
		discard: { current: boolean };
		positionWriter: ReaderPositionWriter;
	} | null>(null);
	const currentSession = useRef(session);
	currentSession.current = session;
	const [failure, setFailure] = useState<Error | null>(null);
	const [validated, setValidated] = useState<string | null>(null);
	const [notice] = useState<"imported" | "reused" | null>(() => {
		if (location.state?.materialReused === true) return "reused";
		return location.state?.materialImported === true ||
			location.state?.materialReused === false
			? "imported"
			: null;
	});
	useEffect(() => {
		if (
			!notice ||
			!host.active ||
			!location.state ||
			!(
				"materialReused" in location.state ||
				"materialImported" in location.state
			)
		)
			return;
		const state = { ...location.state };
		delete state.materialReused;
		delete state.materialImported;
		navigate(`${location.pathname}${location.search}`, {
			replace: true,
			state,
		});
	}, [
		host.active,
		notice,
		location.pathname,
		location.search,
		location.state,
		navigate,
	]);
	useEffect(() => {
		if (!host.active) return;
		let current = true;
		setFailure(null);
		setValidated(null);
		void (async () => {
			const vocabulary = readVocabularyReaderTarget(location.search);
			await waitForPositionWrites(id);
			if (!current) return;
			const bookKey = materialKeys.book(id);
			const originKey = ["segments", segmentId, "material-provenance"] as const;
			if (
				!(await cancelReaderSessionReads(
					client,
					[bookKey, ...(segmentId ? [originKey] : [])],
					() => current,
				))
			)
				return;
			const previous = currentSession.current;
			const drainedRevision = previous?.positionWriter.current?.revision ?? 0;
			const [book, origin] = await Promise.all([
				client.fetchQuery({
					queryKey: bookKey,
					queryFn: () => getMaterial(id),
					staleTime: 0,
				}),
				segmentId
					? client.fetchQuery({
							queryKey: originKey,
							queryFn: ({ signal }) => getSegmentProvenance(segmentId, signal),
							staleTime: 0,
						})
					: Promise.resolve(null),
			]);
			if (!current) return;
			if (origin) {
				const message = originFailure(origin);
				if (message) throw new Error(message);
				if (origin.material_provenance?.material_id !== id)
					throw new Error("片段出处不属于当前材料，无法精确定位。");
				if (origin.material_provenance?.version_id !== book.version_id)
					throw new Error("出处绑定的材料版本不可用，不能套用到当前版本。");
				originPosition(origin, defaults);
			}
			if (vocabulary) {
				if (
					vocabulary.material_id !== id ||
					vocabulary.version_id !== book.version_id
				)
					throw new Error(
						"词汇原文位置绑定的材料版本已不可用，请返回词汇页重新选择。",
					);
				const targetChapter = await client.fetchQuery({
					queryKey: materialKeys.chapter(id, vocabulary.chapter_id),
					queryFn: () => getChapter(id, vocabulary.chapter_id),
					staleTime: 0,
				});
				validateVocabularyReaderTarget(vocabulary, book, targetChapter);
			}
			const summary = await prepareReadings(id, book.version_id);
			if (summary.version_id !== book.version_id)
				throw new Error("材料注音版本已改变，请重新打开。");
			if (!current) return;
			void refreshMaterialAnalysis(
				client,
				id,
				book.version_id,
				summary.generation_id,
			);
			const identity = {
				materialId: id,
				versionId: book.version_id,
				generationId: summary.generation_id,
			};
			const reuse =
				previous &&
				canResumeReader(
					{
						materialId: id,
						versionId: previous.book.version_id,
						generationId: previous.summary.generation_id,
					},
					identity,
					drainedRevision,
					book.reading_position?.revision ?? 0,
					previous.positionWriter.healthy,
				);
			if (previous && !reuse) {
				previous.discard.current = true;
				if (previous.book.version_id !== book.version_id)
					await client.invalidateQueries({
						queryKey: ["materials", id, "chapter"],
						refetchType: "none",
					});
			}
			if (!current) return;
			setSession({
				book,
				summary,
				origin,
				vocabulary,
				token,
				activation: previous ? previous.activation + 1 : 0,
				serial: reuse ? previous.serial : (previous?.serial ?? 0) + 1,
				discard: reuse ? previous.discard : { current: false },
				positionWriter: reuse
					? previous.positionWriter
					: { current: null, healthy: true },
			});
			setValidated(token);
		})().catch((error: unknown) => {
			if (!current) return;
			if (currentSession.current) currentSession.current.discard.current = true;
			setSession(null);
			setFailure(error instanceof Error ? error : new Error(String(error)));
		});
		return () => {
			current = false;
		};
	}, [host.active, id, segmentId, token, client, location.search]);
	const ready = host.active && validated === token && !failure;
	const back = returnDestination(location.state, {
		to: "/materials",
		label: "素材库",
	});
	return (
		<ReaderLeaveProvider active={host.active} dialogHost={dialogHost}>
			<div
				className="reader-r1 reader-dialog-host"
				data-theme={dialogTheme}
				ref={setDialogHost}
			/>
			<ReaderCopyLeaveGuard
				editor={copyEditor}
				materialId={id}
				onContinueEditing={() => setCopyEditRequest((value) => value + 1)}
			/>
			{session && (
				<ViewActivityProvider
					value={{ active: ready, activation: session.activation }}
				>
					<div
						hidden={!ready}
						inert={!ready}
						style={!ready ? { display: "none" } : undefined}
					>
						<Reader
							key={`${readerSessionIdentity({ materialId: id, versionId: session.book.version_id, generationId: session.summary.generation_id })}:${session.serial}`}
							copyEditor={copyEditor}
							copyEditRequest={copyEditRequest}
							onThemeChange={setDialogTheme}
							book={session.book}
							returnTo={back}
							readingsSummary={session.summary}
							initialOrigin={session.origin}
							initialVocabulary={session.vocabulary}
							sessionToken={session.token}
							discard={session.discard}
							positionWriter={session.positionWriter}
							notice={notice}
						/>
					</div>
				</ViewActivityProvider>
			)}
			{!ready && host.active && (
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
						{failure ? (
							<>
								<InlineError error={failure} />
								<button
									type="button"
									onClick={() => setRetry((value) => value + 1)}
								>
									重试打开
								</button>
							</>
						) : (
							<p className="reader-pending-message" role="status">
								正在打开书籍…
							</p>
						)}
					</div>
				</main>
			)}
		</ReaderLeaveProvider>
	);
}
export type ReaderSessionEntry = { materialId: string; location: Location };

export function MaterialReaderSession({
	entry,
}: {
	entry: ReaderSessionEntry;
}) {
	return (
		<MaterialOpening
			key={entry.materialId}
			id={entry.materialId}
			location={entry.location}
		/>
	);
}

/** Route adapter for independently mounted readers; the app uses ReaderSessionHost. */
export function MaterialReader() {
	const { id = "" } = useParams();
	const location = useLocation();
	return <MaterialReaderSession entry={{ materialId: id, location }} />;
}
