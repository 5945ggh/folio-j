import { useDictionaryPreferences } from "../dictionary/use-dictionary-preferences";
import { NativeSelect } from "../NativeSelect";
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
import { AnkiComposer } from "../anki/AnkiComposer";
import { AnkiHeaderStatus } from "../anki/AnkiHeaderStatus";
import type { AnkiCollectionInfo } from "../anki/api";
import {
	type AnkiMaterialContext,
	type AnkiSentenceSource,
	expandedSentenceSource,
	extractExpandedSentence,
	formatSourceMetadata,
} from "../anki/context";
import { originalSentenceRuby } from "../anki/sentence-ruby";
import { Icon as CatalogIcon } from "../catalog/LibraryTools";
import { refreshMaterialAnalysis } from "../catalog/statistics-query";
import {
	getSource,
	queries,
	RequestError,
	type Segment,
	trimTrailingPunctuation,
} from "../content";
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
import { SettingsLink } from "../settings/SettingsNavigation";
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
	type ReadingsResponse,
	type ReadingsSummary,
	readingsKey,
	recordOpened,
	type Settings,
	savePosition,
	setUsage,
	usageKey,
} from "./api";
import { BookImportWarnings } from "./BookImportWarnings";
import { type Bookmark, bookmarkKeys, getBookmark } from "./bookmarks-api";
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
	imageAtReadingEdge,
	imageCoordinate,
	imageFraction,
	PositionQueue,
	prepareChapterProgress,
} from "./position";
import { ReaderPreferenceSubmission } from "./preference-submission";
import {
	type BookUiPreferences,
	DEFAULT_DICTIONARY_OPACITY,
	READER_UI_KEY,
	type ReaderUiPreferences,
	readBookUiPreferences,
	readReaderUiPreferences,
	resolveReaderTheme,
	writeBookUiPreferences,
	writeReaderUiPreferences,
} from "./preferences";
import { ReaderBookmarkDetail } from "./ReaderBookmarkDetail";
import { ReaderBookmarkNotice, useReaderBookmarks } from "./ReaderBookmarks";
import { ContextCopyFeedback, useReaderContextCopy } from "./ReaderContextCopy";
import { ReaderIcon, ReaderPanel, ReaderSettings } from "./ReaderControls";
import { type DictionaryControl, ReaderDictionary } from "./ReaderDictionary";
import { ReaderLeaveProvider } from "./ReaderLeaveProvider";
import {
	ReaderDirectImageViewer,
	ReaderGalleryPanel,
	ReaderNavigationPanel,
} from "./ReaderPanels";
import { ReaderSearchPanel } from "./ReaderSearchPanel";
import { ReaderSearchTranslation } from "./ReaderSearchTranslation";
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
	type ChapterRecordStatus,
	EMPTY_READER_RECORD_STATE,
	hasSearchRecord,
	type ReaderPreviewHit,
	type ReaderRecordContext,
	ReaderRecordPresentation,
	type SearchPreviewTarget,
} from "./reader-record-presentation";
import { readerResourceCache } from "./reader-resource-cache";
import { initialReaderSearch } from "./reader-search";
import type { ReaderSearchHit } from "./reader-search-api";
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
import type { ScreenAnchor } from "./reader-study";
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

function ReaderNavigationIcon({
	name,
}: {
	name: "home" | "back" | "settings";
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{name === "home" ? (
				<path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" />
			) : name === "back" ? (
				<path d="m14 6-6 6 6 6" />
			) : (
				<>
					<path d="m9.5 3-.6 2.2-2 .9-2-.6-2.5 4.3L4 11.4v2.2l-1.6 1.6L5 19.5l2-.6 2 .9.6 2.2h5l.6-2.2 2-.9 2 .6 2.5-4.3-1.6-1.6v-2.2l1.6-1.6L19 5.5l-2 .6-2-.9-.5-2.2z" />
					<circle cx="12" cy="12.5" r="3" />
				</>
			)}
		</svg>
	);
}
type ReaderPositionWriter = {
	current: PositionQueue<Position> | null;
	healthy: boolean;
};

function chapterRecordStatus(
	active: boolean,
	query: { loading: boolean; isError: boolean; isFetching: boolean },
): ChapterRecordStatus {
	if (!active || query.loading) return "checking";
	if (query.isError) return "error";
	return query.isFetching ? "refreshing" : "ready";
}

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
	onThemeChange,
}: {
	book: Material;
	returnTo: ReturnDestination;
	sessionToken: string;
	discard: { current: boolean };
	positionWriter: ReaderPositionWriter;
	copyEditor: ReaderCopyEditor;
	onThemeChange: (theme: "white" | "black") => void;
	initialOrigin: SegmentProvenance | null;
	initialVocabulary: VocabularyReaderTarget | null;
	readingsSummary: ReadingsSummary;
	notice: "imported" | "reused" | null;
}) {
	const { active, activation } = useViewActivity();
	const activeRef = useRef(active);
	activeRef.current = active;
	useStopSpeechOnLeave(book.id, active);
	useMaterialTranslationActivity(book.id, active, activation);
	const [translationTarget, setTranslationTarget] =
		useState<StudyTarget | null>(null);
	const [translationOpen, setTranslationOpen] = useState(false);
	const [translationAnchor, setTranslationAnchor] =
		useState<ScreenAnchor | null>(null);
	const client = useQueryClient();
	const [selectedTranslations] = useState(() => new TranslationPreferences());
	const rememberTranslation = useCallback(
		(result: TranslationResult) => {
			selectedTranslations.remember(result);
		},
		[selectedTranslations],
	);
	const translationSessions = useTranslationSessions();
	const readingGeneration = readingsSummary.generation_id;
	const navigate = useNavigate();
	const [initialAnchor] = useState(() =>
		initialVocabulary
			? vocabularyReaderPosition(
					initialVocabulary,
					book.reading_position?.settings ?? defaults,
				)
			: initialOrigin
				? originPosition(
						initialOrigin,
						book.reading_position?.settings ?? defaults,
					)
				: book.reading_position,
	);
	const [studyTarget, setStudyTarget] = useState<StudyTarget | null>(null);
	const [ankiStatus, setAnkiStatus] = useState<{
		state: "idle" | "checking" | "connected" | "error";
		info?: AnkiCollectionInfo;
		message?: string;
	}>({ state: "idle" });
	const [ankiDraft, setAnkiDraft] = useState<{
		chapterId: string;
		context: AnkiMaterialContext;
		sentenceSource: AnkiSentenceSource | null;
		anchor: ScreenAnchor;
	} | null>(null);
	const [ankiNotice, setAnkiNotice] = useState<{
		message: string;
		serial: number;
	} | null>(null);
	useEffect(() => {
		if (!ankiNotice) return;
		const timer = setTimeout(() => setAnkiNotice(null), 5000);
		return () => clearTimeout(timer);
	}, [ankiNotice]);
	const ankiCard = useRef<HTMLElement>(null);
	function closeAnkiComposer(key: string) {
		setAnkiDraft((current) => (current?.context.key === key ? null : current));
		requestAnimationFrame(() => {
			if (!activeRef.current || ankiCard.current) return;
			if (document.activeElement === document.body)
				container.current?.focus({ preventScroll: true });
			controller.current?.refresh();
		});
	}
	function openAnkiComposer(
		input: Omit<
			AnkiMaterialContext,
			| "key"
			| "sentence"
			| "sentenceFocus"
			| "sentenceRuby"
			| "sentenceRubyPending"
			| "sourceMetadata"
		>,
		anchor: ScreenAnchor,
		originChapter: Chapter | undefined = chapter.data,
		fallbackSentence = input.selection,
	) {
		dictionary.current?.close();
		records.clearToolbar();
		setTranslationOpen(false);
		setStudyTarget(null);
		closeMarkHit();
		if (ankiDraft) {
			ankiCard.current?.focus({ preventScroll: true });
			return;
		}
		const sentenceSource = expandedSentenceSource(
			originChapter,
			input.reference,
			input.origin === "selection" || input.origin === "dictionary"
				? input.selection
				: undefined,
		);
		const context = {
			...input,
			key: crypto.randomUUID(),
			sentence:
				sentenceSource?.sentence ??
				extractExpandedSentence(null, null, fallbackSentence),
			sentenceFocus: sentenceSource?.focus,
			sourceMetadata: formatSourceMetadata([
				source.data?.title,
				book.title,
				originChapter?.title,
			]),
		};
		setAnkiDraft({
			context,
			sentenceSource,
			anchor,
			chapterId: originChapter?.id ?? chapterId,
		});
		setSelectionError(null);
		controller.current?.show();
	}

	const [selectionError, setSelectionError] = useState<Error | null>(null);
	const [originError, setOriginError] = useState<Error | null>(null);
	const [recordState, setRecordState] = useState(EMPTY_READER_RECORD_STATE);
	const {
		selection,
		markHit,
		manualPosition,
		inlineRequest,
		previewSerial,
		previewEntrance,
	} = recordState;
	const [frames] = useState(() => new ReaderFrames());
	const dictionary = useRef<DictionaryControl>(null);
	const [dictionaryReady, setDictionaryReady] = useState(false);
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
				frames,
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
						setUsageError(new Error("阅读状态已刷新。"));
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
				setUsageError(new Error("阅读状态已变更，请重新选择。"));
			} else
				setUsageError(
					failure instanceof Error ? failure : new Error(String(failure)),
				);
		} finally {
			setUsageBusy(false);
		}
	};
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
			? `${chapterId}:${generation}:${translationTargetKey(selection.reference)}`
			: null,
	);
	const bookmarks = useReaderBookmarks(book.id, book.version_id);
	const [searchState, setSearchState] = useState(initialReaderSearch);
	const searchScrollTop = useRef(0);
	const [pendingSearchRecord, setPendingSearchRecord] = useState<{
		chapterId: string | null;
		target: SearchPreviewTarget;
		current: () => boolean;
	} | null>(null);
	const [searchBookmark, setSearchBookmark] = useState<Bookmark | null>(null);
	const [searchBookmarkLocatable, setSearchBookmarkLocatable] = useState(true);
	const [searchTranslationId, setSearchTranslationId] = useState<string | null>(
		null,
	);
	const [searchOpenError, setSearchOpenError] = useState<Error | null>(null);
	const [panels, setPanels] = useState<ReaderPanelsState>(EMPTY_READER_PANELS);
	const [rightToolInFront, setRightToolInFront] = useState(false);
	const panelAboveCards =
		rightToolInFront &&
		panels.activeSide === "right" &&
		(panels.right === "settings" || panels.right === "gallery");
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
	const {
		preferences: dictionaryPreferences,
		storageFailed: dictionaryStorageFailed,
		updatePreferences: updateDictionaryPreferences,
	} = useDictionaryPreferences();
	const [ui, setUi] = useState(readReaderUiPreferences);
	const copySettings = copyEditor.query;
	const [settingsExpanded, setSettingsExpanded] = useState(
		DEFAULT_READER_SETTINGS_EXPANDED,
	);
	const settingsScrollTop = useRef(0);
	const copyEditorStatus = copyEditor.pending
		? "处理中"
		: copyEditor.noticeError ||
				copySettings.isError ||
				(!!copyEditor.fields && !copyEditor.valid)
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
	const [jumpReading] = useState(() => new JumpReadingSession());
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
	const [navigation] = useState(() => new ReaderNavigation(jumpReading));
	const [navigationState, setNavigationState] = useState(navigation.state);
	const {
		origin,
		error: navigationError,
		busy: chapterSwitchBusy,
	} = navigationState;
	const invalidateNavigation = useCallback(() => {
		navigation.invalidate();
		setPendingSearchRecord(null);
		setSearchOpenError(null);
	}, [navigation]);
	const viewerEscape = useRef<(() => void) | null>(null);
	const registerViewerEscape = useCallback((close: (() => void) | null) => {
		viewerEscape.current = close;
	}, []);
	const highlight = useRef<{
		chapterId: string;
		ranges: readonly ReaderHighlightRange[];
	} | null>(
		initialVocabulary
			? {
					chapterId: initialVocabulary.chapter_id,
					ranges: [initialVocabulary],
				}
			: initialOrigin?.material_provenance && initialOrigin.chapter_id
				? {
						chapterId: initialOrigin.chapter_id,
						ranges: initialOrigin.material_provenance.ranges,
					}
				: null,
	);
	const navigationHighlight = useRef<NavigationHighlightLifetime | null>(null);
	if (!navigationHighlight.current) {
		navigationHighlight.current = new NavigationHighlightLifetime(
			() => {
				highlight.current = null;
				frames.clearSearchHighlights();
			},
			undefined,
			{ opacity: (value) => frames.setSearchHighlightOpacity(value) },
		);
	}
	useLayoutEffect(() => {
		if (highlight.current) navigationHighlight.current?.replace();
		return () => navigationHighlight.current?.dispose();
	}, []);
	const latest = useRef({
		panels,
		panelAboveCards,
		chapterId,
		compactPanels,
		theme,
		bookUi,
		settings,
		directImage,
		presented,
		ui,
		translationTarget,
		translationOpen,
		ankiActive: ankiDraft !== null,
		studyActive: translationOpen || studyTarget !== null,
	});
	latest.current = {
		panels,
		panelAboveCards,
		chapterId,
		compactPanels,
		theme,
		bookUi,
		settings,
		directImage,
		presented,
		ui,
		translationTarget,
		translationOpen,
		ankiActive: ankiDraft !== null,
		studyActive: translationOpen || studyTarget !== null,
	};
	const dismissReadingBackground = useCallback(
		() => dictionary.current?.close() || records.dismissBackground(),
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
			setSearchBookmark(null);
			if (next !== "search") setSearchTranslationId(null);
			if (
				latest.current.translationOpen &&
				latest.current.panels.right === "study" &&
				(next === "settings" || next === "gallery" || next === "info")
			)
				setTranslationOpen(false);
			if (next === "settings" || next === "gallery") {
				dictionary.current?.dismissMenu();
				setRightToolInFront(true);
			} else {
				dictionary.current?.close();
			}
			records.panelSelected(next);
			jumpReading.pause();
			invalidateNavigation();
			navigation.dismissError();
			setPanels((current) =>
				selectReaderPanel(current, next, toggle, latest.current.compactPanels),
			);
			controller.current?.show();
		},
		[invalidateNavigation, records, jumpReading, navigation],
	);
	const closePanel = useCallback(
		(side?: ReaderPanelSide, invalidate = true) => {
			if (!side || side === "right") setSearchTranslationId(null);
			if (invalidate) setSearchBookmark(null);
			if (
				(!side || side === "right") &&
				latest.current.panels.right === "study" &&
				latest.current.translationOpen
			)
				setTranslationOpen(false);
			records.panelClosed(side);
			jumpReading.pause();
			if (invalidate) invalidateNavigation();
			setPanels((current) =>
				side ? closeReaderPanel(current, side) : EMPTY_READER_PANELS,
			);
			controller.current?.show();
		},
		[invalidateNavigation, records, jumpReading],
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
				!!dictionary.current?.isOpen() ||
				latest.current.ankiActive ||
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
				if (latest.current.panelAboveCards && dictionary.current?.isOpen()) {
					closePanel("right");
					return true;
				}
				if (dictionary.current?.back() || records.escape()) return true;
				if (
					latest.current.translationOpen &&
					(latest.current.panels.right !== "study" ||
						latest.current.panels.activeSide !== "left")
				) {
					setTranslationOpen(false);
					if (latest.current.panels.right === "study") closePanel("right");
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
		for (const frame of frames.values())
			focus.bindFrame(frame.doc, frame.element);
		return () => {
			focus.dispose();
			controller.current = null;
		};
	}, [
		active,
		closePanel,
		records,
		dismissReadingBackground,
		setUiPreference,
		frames,
	]);
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
	const documents = useMemo(() => {
		const data = chapter.data;
		if (!data) return [];
		const resources = new Map(
			data.resources.map((resource) => [resource.id, resource]),
		);
		return data.parts.flatMap((part, index) => {
			const resource = resources.get(part.resource_id);
			return resource
				? [
						{
							index,
							key: `${data.id}-${part.spine_index}-${part.resource_id}-${part.start}`,
							title: `${data.title} ${index + 1}`,
							srcDoc: partDocument(part, resource, defaults),
							register: (element: HTMLIFrameElement | null) =>
								frames.register(index, element),
						},
					]
				: [];
		});
	}, [chapter.data, frames]);
	const progressAt = useMemo(
		() =>
			chapter.data
				? prepareChapterProgress(chapter.data.parts, chapter.data.resources)
				: null,
		[chapter.data],
	);
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
	const otherAnkiChapter =
		ankiDraft && ankiDraft.chapterId !== chapterId ? ankiDraft.chapterId : "";
	const otherMarks = useChapterStudyMarks(
		book.id,
		book.version_id,
		otherAnkiChapter,
		active && !!otherAnkiChapter,
		activation,
	);
	const otherTranslations = useChapterTranslations(
		book.id,
		book.version_id,
		otherAnkiChapter,
		active && !!otherAnkiChapter,
		activation,
	);
	const ankiSegments = otherAnkiChapter ? otherMarks : marks;
	const ankiTranslations = otherAnkiChapter
		? otherTranslations
		: chapterTranslations;
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
	const chapterReadingOptions = (id: string) => ({
		queryKey: readingsKey(book.id, book.version_id, id, readingGeneration),
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			getReadings(book.id, book.version_id, id, readingGeneration, signal),
		enabled: active && !!id,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const chapterReading = chapterReadingOptions(chapterId);
	const chapterReadingsKey = chapterReading.queryKey;
	const readings = useQuery(chapterReading);
	const ankiSourceChapterId = ankiDraft?.sentenceSource?.chapter.id;
	const ankiOtherChapterReadings = useQuery(
		chapterReadingOptions(
			ankiSourceChapterId === chapterId ? "" : (ankiSourceChapterId ?? ""),
		),
	);
	const ankiReadings =
		ankiSourceChapterId === chapterId ? readings : ankiOtherChapterReadings;
	const sentenceRuby = useMemo(
		() =>
			ankiDraft?.sentenceSource
				? originalSentenceRuby(
						ankiDraft.sentenceSource,
						ankiReadings.data,
						readingGeneration,
						document,
					)
				: undefined,
		[ankiDraft?.sentenceSource, ankiReadings.data, readingGeneration],
	);
	const sentenceRubyPending = Boolean(
		ankiDraft?.sentenceSource &&
			ankiReadings.isPending &&
			ankiReadings.isFetching,
	);
	const ankiContext = useMemo(
		() =>
			ankiDraft && { ...ankiDraft.context, sentenceRuby, sentenceRubyPending },
		[ankiDraft, sentenceRuby, sentenceRubyPending],
	);
	const viewportReady =
		chapter.isSuccess && (bookUi.rubyScope !== "all" || readings.isSuccess);
	const container = useRef<HTMLElement>(null);
	const [presentation] = useState(
		() =>
			new ReaderPresentation(presentationState, initialAnchor, {
				frames,
				navigation,
				reading: jumpReading,
				writer: () => queue.current,
				changed: setPresentationState,
			}),
	);
	const alive = useRef(true);
	const inlineMutation = useRef(false);
	useLayoutEffect(() => {
		presentation.setActive(active, discard.current);
		return () => presentation.setActive(false, discard.current);
	}, [active, discard, presentation]);
	const recordStatus = {
		segment: chapterRecordStatus(active, marks),
		translation: chapterRecordStatus(active, chapterTranslations),
	};
	const searchPreviewTarget = markHit?.searchTarget;
	const searchPreviewChecking = searchPreviewTarget
		? recordStatus[searchPreviewTarget.kind] === "checking"
		: marks.loading || chapterTranslations.loading;
	const pendingSearchStatus = pendingSearchRecord
		? recordStatus[pendingSearchRecord.target.kind]
		: null;
	// Keep each type's last verified rows during refresh. The status controls visibility.
	const recordFacts = useRef({
		chapterId,
		segments: [] as typeof marks.items,
		translations: [] as typeof chapterTranslations.items,
	});
	if (recordFacts.current.chapterId !== chapterId)
		recordFacts.current = {
			chapterId,
			segments: [],
			translations: [],
		};
	if (searchPreviewTarget || pendingSearchRecord) {
		if (recordStatus.segment === "ready")
			recordFacts.current.segments = marks.items;
		if (recordStatus.translation === "ready")
			recordFacts.current.translations = chapterTranslations.items;
	} else if (
		recordStatus.segment !== "checking" &&
		recordStatus.segment !== "refreshing" &&
		recordStatus.translation !== "checking" &&
		recordStatus.translation !== "refreshing"
	) {
		if (!marks.isError) recordFacts.current.segments = marks.items;
		if (!chapterTranslations.isError)
			recordFacts.current.translations = chapterTranslations.items;
	}
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
		segments: recordFacts.current.segments,
		translations: recordFacts.current.translations,
		status: recordStatus,
	};
	const openMarkHit = useCallback(
		(value: ReaderPreviewHit, trigger: HTMLButtonElement | null = null) => {
			dictionary.current?.close();
			records.openPreview(value, trigger);
		},
		[records],
	);
	const closeMarkHit = useCallback(() => records.closePreview(), [records]);
	useLayoutEffect(() => {
		frames.bindStudy({
			materialId: book.id,
			versionId: book.version_id,
			chapterId,
			dictionaryMode:
				active && dictionaryReady && !studyTarget
					? dictionaryPreferences.mode
					: "off",
			onLookup: (hit) => {
				if (hit) {
					if (
						recordState.markHit &&
						!recordState.markHit.fixed &&
						!recordState.manualPosition
					)
						records.closePreview();
					records.clearToolbar();
				}
				dictionary.current?.lookup(hit);
			},
			onSelection: (value) => {
				if (value) dictionary.current?.close();
				records.selectionChanged(value);
			},
			onEntries: setMarginEntries,
			onMarks: (value) => {
				if (value) dictionary.current?.close();
				records.markChanged(value);
			},
			onBackgroundTap: dismissReadingBackground,
		});
	});
	const hitRecords = records.hitRecords;
	const visibleHitItems = hitRecords.segments;
	const forgetTranslation = useCallback<TranslationRemoved>(
		(removed, reference) => {
			selectedTranslations.forget(removed.identity_sha256);
			records.translationRemoved(removed.identity_sha256);
			if (
				latest.current.translationTarget &&
				translationTargetKey(latest.current.translationTarget.reference) ===
					translationTargetKey(reference)
			) {
				setTranslationOpen(false);
				setTranslationTarget(null);
				setPanels((current) =>
					current.right === "study"
						? closeReaderPanel(current, "right")
						: current,
				);
			}
		},
		[records, selectedTranslations],
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
	useEffect(() => {
		if (
			!pendingSearchRecord ||
			!active ||
			navigationState.adjacentDisabled ||
			pendingSearchStatus === "checking" ||
			pendingSearchStatus === "refreshing"
		)
			return;
		const { chapterId: targetChapterId, target, current } = pendingSearchRecord;
		setPendingSearchRecord(null);
		if (!current()) return;
		if (chapterId !== targetChapterId || pendingSearchStatus === "error") {
			setSearchOpenError(new Error("章节已切换或记录暂不可用"));
			return;
		}
		if (
			!hasSearchRecord(
				{ segments: marks.items, translations: chapterTranslations.items },
				target,
				target.kind === "translation" ? target.resultId : undefined,
			)
		) {
			setSearchOpenError(new Error("该记录已更新或删除，请重新搜索"));
			return;
		}
		openMarkHit({
			segmentIds: target.kind === "segment" ? [target.id] : [],
			translationIds: target.kind === "translation" ? [target.identity] : [],
			searchTarget:
				target.kind === "segment"
					? target
					: { kind: "translation", identity: target.identity },
			anchor: {
				left: window.innerWidth - 20,
				right: window.innerWidth - 12,
				top: 100,
				bottom: 110,
			},
			anchorPlacement: "margin-right",
		});
		// Search is an explicit persistent preview, independent of a transient DOM mark hover.
		records.setManualPosition({
			left: Math.max(12, window.innerWidth - 432),
			top: 88,
		});
	}, [
		pendingSearchRecord,
		active,
		navigationState.adjacentDisabled,
		pendingSearchStatus,
		chapterId,
		marks.items,
		chapterTranslations.items,
		openMarkHit,
		records,
	]);
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
	const chapterContentEnd = useCallback(
		(vertical: boolean) => {
			let end: number | null = null;
			for (const frame of frames.values()) {
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
		},
		[frames],
	);
	const capture = useCallback((): Position | null => {
		const root = container.current;
		if (!activeRef.current || frames.inlineMotionRunning) return null;
		if (!root || !chapter.data || !presentation.canSample(viewportSize(root)))
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
		for (const [index, frame] of frames) {
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
	}, [
		book.version_id,
		chapterId,
		chapter.data,
		settings,
		chapterContentEnd,
		frames,
		presentation,
	]);
	const sampleJumpReading = useCallback(() => {
		const root = container.current;
		if (
			!activeRef.current ||
			!root ||
			document.hidden ||
			!document.hasFocus() ||
			navigation.state.returning ||
			!presentation.canSample(viewportSize(root))
		) {
			jumpReading.pause();
			return false;
		}
		const vertical = latest.current.settings.writing_mode === "vertical-rl";
		const view = readingViewport(root, getComputedStyle(root));
		jumpReading.sample(
			vertical ? -root.scrollLeft : root.scrollTop,
			vertical ? view.width : view.height,
			performance.now(),
		);
		return true;
	}, [jumpReading, navigation, presentation]);
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
			frames.finishInlineMotion();
			// Sample before granting input so a prior programmatic move cannot count.
			navigationHighlight.current?.clear();
			if (sampleJumpReading()) jumpReading.input(performance.now());
		},
		[sampleJumpReading, frames, jumpReading],
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
		const pause = () => jumpReading.pause();
		document.addEventListener("visibilitychange", pause);
		window.addEventListener("blur", pause);
		return () => {
			document.removeEventListener("visibilitychange", pause);
			window.removeEventListener("blur", pause);
		};
	}, [jumpReading]);
	const observe = useCallback(() => {
		const root = container.current;
		if (!activeRef.current || !root || frames.inlineMotionRunning) return;
		const anchor = presentation.observe(viewportSize(root), capture);
		if (anchor && progressAt) {
			sampleJumpReading();
			const value = progressAt(
				anchor,
				frames.get(anchor.part_index)?.imageOffsets.get(anchor.image_id ?? -1),
			);
			setProgress(value);
			setChapterPositions((previous) =>
				new Map(previous).set(anchor.chapter_id, { anchor, progress: value }),
			);
		} else jumpReading.pause();
	}, [
		capture,
		sampleJumpReading,
		frames,
		jumpReading,
		progressAt,
		presentation,
	]);
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
					frames.highlight(data, highlight.current.ranges);
					setOriginError(null);
				} catch (failure) {
					setOriginError(
						failure instanceof Error ? failure : new Error(String(failure)),
					);
					return false;
				}
			}
			jumpReading.pause();
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
				const frame = frames.get(anchor.part_index);
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
				setOriginError(new Error("未能定位到目标位置，请重试。"));
				return false;
			}

			return {
				located,
				error: navigationFailure,
				afterRestore: () => {
					setPresented(true);
					if (located && highlight.current)
						navigationHighlight.current?.presented();
					frames.refreshStudyGeometry();
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
			frames,
			jumpReading,
		],
	);
	const reflowFrames = useCallback(() => {
		if (activeRef.current) presentation.reflow();
	}, [presentation]);
	const mutateInlineLayout = useCallback(
		(update: () => void) => {
			const root = container.current;
			const data = chapter.data;
			if (!activeRef.current) return;
			if (!root || !data || !alive.current) {
				update();
				return;
			}
			frames.preserveStudyPreviewDuringLayout(() => {
				const anchor = capture();
				const screenTop = () => {
					if (!anchor) return null;
					const frame = frames.get(anchor.part_index);
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
				jumpReading.pause();
				let applied = false;
				inlineMutation.current = true;
				try {
					presentation.reflow(
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
		[capture, chapter.data, observe, frames, jumpReading, presentation],
	);
	useEffect(() => {
		alive.current = true;
		presentation.mount();
		const unregister = queue.current
			? registerPositionWriter(book.id, queue.current)
			: () => {};
		return () => {
			alive.current = false;
			presentation.unmount(discard.current);
			unregister();
		};
	}, [book.id, discard, presentation]);
	const load = (index: number, element: HTMLIFrameElement, token: number) => {
		if (!chapter.data) return;
		presentation.load(index, element, token, {
			chapter: chapter.data,
			readingGeneration,
			readings: () => client.getQueryData<ReadingsResponse>(chapterReadingsKey),
			current: () => latest.current,
			root: () => container.current,
			bindFocus: (doc, frame) => controller.current?.bindFrame(doc, frame),
			key: readKey,
			wheel: readWheel,
			touch: recordReadingInput,
			interaction: recordReadingInput,
			image: (partIndex, imageId, source) => {
				jumpReading.pause();
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
						? new Error("未能完成定位，请重新打开后重试。")
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
			frames.finishInlineMotion();
			setTranslationAnchor(null);
			const width = root.clientWidth,
				height = root.clientHeight;
			frames.invalidateStudyGeometry();
			if (width === lastWidth && height === lastHeight) {
				frames.refreshStudyGeometry();
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
		navigation.bind({
			versionId: book.version_id,
			chapterId,
			chapters: book.chapters,
			settings,
			unavailable:
				!!error ||
				chapter.isError ||
				(bookUi.rubyScope === "all" && readings.isError),
			remembered: (id) => chapterPositions.get(id)?.anchor,
			presentedAnchor: () => presentation.presentedAnchor(capture),
			progressFor: (anchor) => {
				const data = chapter.data;
				if (!progressAt || data?.id !== anchor.chapter_id)
					return chapterPositions.get(anchor.chapter_id)?.progress ?? null;
				return progressAt(
					anchor,
					frames
						.get(anchor.part_index)
						?.imageOffsets.get(anchor.image_id ?? -1),
				);
			},
			loadChapter: (id) => {
				navigationHighlight.current?.clear(true);
				if (chapter.data?.id === id) return Promise.resolve(chapter.data);
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
					presentation.present(null, complete, capture);
					return;
				}
				const { target, mark, part: targetPart, highlightRanges } = destination;
				highlight.current = highlightRanges
					? {
							chapterId: target.chapter_id,
							ranges: highlightRanges,
						}
					: mark
						? {
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
				if (highlight.current) navigationHighlight.current?.replace();
				else navigationHighlight.current?.clear(true);
				setOriginError(null);
				const previousChapter = presentation.state.chapterId;
				presentation.present(destination, complete, capture);
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
			const settings = latest.current.settings;
			const vertical = settings.writing_mode === "vertical-rl";
			const lineStep = settings.font_size * settings.line_height * 1.5;
			const root = container.current;
			if (!root) return;
			const page = vertical
				? root.clientWidth
				: readingViewport(root, getComputedStyle(root)).height;
			let step = 0;
			if (event.key === "PageDown" || event.key === " ")
				step = page * 0.85 * (event.shiftKey ? -1 : 1);
			else if (event.key === "PageUp") step = -page * 0.85;
			else if (vertical && event.key === "ArrowLeft") step = lineStep;
			else if (vertical && event.key === "ArrowRight") step = -lineStep;
			else if (!vertical && event.key === "ArrowDown") step = lineStep;
			else if (!vertical && event.key === "ArrowUp") step = -lineStep;
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
	const rubyErrorDetail =
		rubyError && trimTrailingPunctuation(rubyError.message);
	const [preferenceSubmission] = useState(
		() => new ReaderPreferenceSubmission(),
	);
	const change = (next: Settings) => {
		setTranslationAnchor(null);
		presentation.change(next, capture);
	};
	useLayoutEffect(() => {
		if (!active) return;
		preferenceSubmission.bind({
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
	useLayoutEffect(
		() => () => preferenceSubmission.suspend(),
		[preferenceSubmission],
	);
	const changeBookUi = (next: BookUiPreferences) =>
		preferenceSubmission.submit(next);
	useLayoutEffect(() => {
		if (!active || !viewportReady) return;
		const root = container.current;
		const data = chapter.data;
		if (!root || !data) return;

		try {
			presentation.commit(
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
		presentation,
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
		if (active) frames.inlineMarginsChanged();
	}, [active, marginEntries]);
	const leave = () => presentation.checkpoint(capture);

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
			frames.setStudyMarks(
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
		preferenceSubmission.suspend();
	}, [active, preferenceSubmission]);
	const previousSession = useRef(sessionToken);
	useEffect(() => {
		if (!active || previousSession.current === sessionToken) return;
		previousSession.current = sessionToken;
		if (initialVocabulary) {
			void navigation.navigate({
				type: "position",
				target: vocabularyReaderPosition(
					initialVocabulary,
					latest.current.settings,
				),
				highlightRanges: [initialVocabulary],
			});
			return;
		}
		if (!initialOrigin) return;
		void navigation.navigate({
			type: "position",
			target: originPosition(initialOrigin, latest.current.settings),
			highlightRanges: initialOrigin.material_provenance?.ranges,
		});
	}, [active, sessionToken, initialOrigin, initialVocabulary, navigation]);

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
			void navigation.navigate({
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
	const chooseSearchResult = async (
		hit: ReaderSearchHit,
		current: () => boolean,
	) => {
		invalidateNavigation();
		closeMarkHit();
		bookmarks.closeEditor();
		setSearchBookmark(null);
		setSearchTranslationId(null);
		if (hit.kind === "original") {
			const item = hit.item;
			const success = await navigation.navigate({
				type: "position",
				target: {
					version_id: book.version_id,
					chapter_id: item.chapter_id,
					part_index: item.part_index,
					resource_id: item.resource_id,
					kind: "text",
					offset: item.start,
					at_chapter_end: false,
					settings: latest.current.settings,
				},
				mark: { start: item.start, end: item.end },
			});
			if (success && current() && latest.current.compactPanels)
				closePanel("left", false);
			return;
		}
		const item = hit.item;
		const navigationCurrent = navigation.currentRequest();
		const bookmark = item.bookmark_id
			? await client.fetchQuery({
					queryKey: bookmarkKeys.item(book.id, item.bookmark_id),
					queryFn: ({ signal }) =>
						getBookmark(book.id, item.bookmark_id ?? "", signal),
					staleTime: 0,
				})
			: null;
		if (!current() || !navigationCurrent() || !activeRef.current) return;
		if (!item.position) {
			if (bookmark) {
				setSearchBookmark(bookmark);
				setSearchBookmarkLocatable(false);
				bookmarks.edit(bookmark, false);
				return;
			}
			if (item.segment_id) {
				openStudySegment(item.segment_id);
				return;
			}
			if (item.result_id) {
				setSearchTranslationId(item.result_id);
				setPanels((previous) => selectReaderPanel(previous, "study"));
				return;
			}
			throw new Error("无法定位该记录对应的原文位置");
		}
		const success = await navigation.navigate({
			type: "position",
			target: {
				...(bookmark?.position ?? item.position),
				settings: latest.current.settings,
			},
			highlightRanges: item.material_provenance?.ranges,
		});
		if (!success || !current()) return;
		if (bookmark) {
			setSearchBookmark(bookmark);
			setSearchBookmarkLocatable(true);
			bookmarks.edit(bookmark, false);
		} else {
			const target: SearchPreviewTarget | null =
				item.kind === "segment" && item.segment_id
					? { kind: "segment", id: item.segment_id }
					: item.kind === "translation" &&
							item.identity_sha256 &&
							item.result_id
						? {
								kind: "translation",
								identity: item.identity_sha256,
								resultId: item.result_id,
							}
						: null;
			if (!target) throw new Error("该记录信息已失效，请重新搜索");
			setPendingSearchRecord({
				chapterId: item.chapter_id ?? null,
				target,
				current: navigation.currentRequest(),
			});
		}
		if (latest.current.compactPanels) closePanel("left", false);
	};
	const renderToken = generation;
	const activateReaderTool = (target: Element) => {
		if (target.closest(".dict-deck, .dict-config, .dict-trigger")) {
			setRightToolInFront(false);
			return;
		}
		const side = target.closest<HTMLElement>(
			"[data-reader-panel-side]:not([inert])",
		)?.dataset.readerPanelSide;
		if (side !== "left" && side !== "right") return;
		if (side === "right") {
			dictionary.current?.dismissMenu();
			setRightToolInFront(true);
		}
		setPanels((current) =>
			current.activeSide === side ? current : { ...current, activeSide: side },
		);
	};
	return (
		<main
			ref={shell}
			className="reader-r1"
			data-presented={presented}
			data-theme={theme}
			data-tools-visible={toolsVisible}
			data-left-open={!!panels.left}
			data-search-open={panels.left === "search" || undefined}
			data-right-open={!!panels.right}
			data-active-side={panels.activeSide}
			data-panel-above-cards={panelAboveCards || undefined}
			onFocusCapture={(event) => activateReaderTool(event.target)}
			onPointerDownCapture={(event) => {
				const target = event.target as Element;
				if (
					target.closest("[data-reader-tools], [data-reader-tool]") &&
					!target.closest(".dict-deck, .dict-config, .dict-trigger")
				)
					dictionary.current?.dismissMenu();
				activateReaderTool(target);
			}}
			style={
				{
					"--reader-width": `${bookUi.width}px`,
					"--reader-toolbar-opacity": `${ui.toolbarOpacity}%`,
					"--reader-popover-opacity": `${ui.dictionaryOpacity ?? DEFAULT_DICTIONARY_OPACITY}%`,
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
				<div className="reader-heading-navigation">
					<Link
						className="reader-navigation-icon reader-home-link"
						to="/"
						onClick={leave}
						aria-label="素材库"
						data-tooltip="素材库"
					>
						<ReaderNavigationIcon name="home" />
					</Link>
					<span className="reader-navigation-divider" aria-hidden="true" />
					<Link
						className="reader-return-link"
						to={returnTo.to}
						state={returnTo.state}
						onClick={leave}
						aria-label={`返回${returnTo.label}`}
						data-tooltip={`返回${returnTo.label}`}
					>
						<ReaderNavigationIcon name="back" />
						<span>返回{returnTo.label}</span>
					</Link>
				</div>
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
							{progress === null ? "—" : `本章 ${Math.round(progress * 100)}%`}
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
					<SettingsLink
						className="reader-navigation-icon"
						to="/settings"
						onClick={leave}
						aria-label="全局设置"
						data-tooltip="全局设置"
					>
						<ReaderNavigationIcon name="settings" />
					</SettingsLink>
					<AnkiHeaderStatus
						settingsState={returnState(
							{ to: `/materials/${book.id}`, label: book.title },
							returnTo,
							"/settings",
						)}
						externalStatus={ankiStatus}
						onStatusChange={setAnkiStatus}
					/>
				</div>
			</header>
			<div className="reader-alerts" aria-live="polite">
				{inlineRequest && inlineResult.isPending && (
					<p role="status">正在加载译文…</p>
				)}
				{marks.loading && <p>正在加载本章学习片段标记…</p>}
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
						searchOpenError ??
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
						重试
					</button>
				)}
				{originError && (
					<button
						type="button"
						onClick={() => {
							setError(null);
							setOriginError(null);
							presentation.retry();
						}}
					>
						重试定位
					</button>
				)}
				{(error || positionError) && (
					<button type="button" onClick={() => window.location.reload()}>
						重新打开
					</button>
				)}
				{navigationError && (
					<button type="button" onClick={() => navigation.dismissError()}>
						关闭
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
						重试同步状态
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
						重试加载
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
					{documents.map(({ index, key, title, srcDoc, register }) => (
						<iframe
							key={key}
							title={title}
							className="material-part"
							sandbox="allow-same-origin"
							srcDoc={srcDoc}
							ref={register}
							onLoad={(event) => load(index, event.currentTarget, renderToken)}
						/>
					))}
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
												? "打开此处译文"
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
					<span className="reader-progress" title="本章阅读进度">
						{progress === null ? "—" : `本章 ${Math.round(progress * 100)}%`}
					</span>
					{origin && (
						<button
							type="button"
							className="reader-return-origin"
							aria-label={returnLabel}
							data-tooltip={returnLabel}
							onClick={() => void navigation.navigate({ type: "return" })}
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
								void navigation.navigate({
									type: "adjacent",
									direction: "previous",
								})
							}
						>
							<ReaderIcon name="previous" />
						</button>
						<button
							type="button"
							aria-label="目录与书签"
							data-tooltip="目录与书签"
							aria-expanded={
								panels.left === "toc" || panels.left === "bookmarks"
							}
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
								void navigation.navigate({
									type: "adjacent",
									direction: "next",
								})
							}
						>
							<ReaderIcon name="next" />
						</button>
					</div>
					<button
						id="reader-search-trigger"
						type="button"
						aria-label="本书搜索"
						data-tooltip="本书搜索"
						aria-expanded={panels.left === "search"}
						onClick={() => selectPanel("search", true)}
					>
						<CatalogIcon name="search" />
					</button>
					<button
						type="button"
						aria-label="添加书签"
						data-tooltip="添加书签"
						disabled={bookmarks.busy || chapterSwitchBusy || !presented}
						onClick={() =>
							bookmarks.add(() => {
								if (navigation.state.busy) return null;
								const sampled = capture();
								return sampled
									? presentation.presentedAnchor(() => sampled)
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
					<ReaderDictionary
						ref={dictionary}
						storageFailed={dictionaryStorageFailed}
						onActivate={() => setRightToolInFront(false)}
						behindPanel={panelAboveCards || directImage !== undefined}
						manageState={returnState(
							{ to: `/materials/${book.id}`, label: book.title },
							returnTo,
							"/settings",
						)}
						onManage={leave}
						onReady={setDictionaryReady}
						portal={shell.current}
						opacity={ui.dictionaryOpacity ?? DEFAULT_DICTIONARY_OPACITY}
						autoExpand={dictionaryPreferences.autoExpand}
						onAutoExpand={(autoExpand) =>
							updateDictionaryPreferences({ autoExpand })
						}
						assistedRanking={dictionaryPreferences.assistedRanking}
						onAssistedRanking={(assistedRanking) =>
							updateDictionaryPreferences({ assistedRanking })
						}
						mode={dictionaryPreferences.mode}
						onMode={(mode) => updateDictionaryPreferences({ mode })}
						onRecord={openMarkHit}
						onAnki={(payload) => {
							openAnkiComposer(
								{
									origin: "dictionary",
									selection: payload.surface,
									reference: payload.reference,
									dictionarySeed: {
										surface: payload.surface,
										term: payload.term,
										reading: payload.reading,
										entries: payload.entries,
										dictionaryTitle: payload.dictionaryTitle,
										partOfSpeech: payload.partOfSpeech,
									},
									lookupInput: payload.lookupInput,
								},
								payload.anchor,
								chapter.data,
								payload.lookupInput.text || payload.surface,
							);
						}}
						restoreFocus={() =>
							container.current?.focus({ preventScroll: true })
						}
					/>
					<button
						type="button"
						aria-label="阅读设置"
						className="reader-settings-trigger"
						data-tooltip={
							copyEditorStatus
								? `阅读设置（复制设置${copyEditorStatus}）`
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
				<div
					hidden={
						!translationOpen ||
						(panels.right === "study" &&
							compactPanels &&
							panels.activeSide !== "right")
					}
				>
					<TranslationPanel
						key={translationTargetKey(translationTarget.reference)}
						materialId={book.id}
						onResultSelected={rememberTranslation}
						onRemoved={forgetTranslation}
						translationSessions={translationSessions}
						visible={
							active &&
							translationOpen &&
							!(
								panels.right === "study" &&
								compactPanels &&
								panels.activeSide !== "right"
							)
						}
						expanded={panels.right === "study"}
						onExpand={() => {
							jumpReading.pause();
							invalidateNavigation();
							navigation.dismissError();
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
						anchor={translationAnchor}
						direction={settings.writing_mode}
						sourceId={book.source_id}
						target={translationTarget}
						autoStart
						onOpenSegment={openStudySegment}
						onAnki={(result) => {
							const ref = result.material_provenance;
							const selectionText = targetText(ref);

							openAnkiComposer(
								{
									origin: "translation",
									selection: selectionText,
									reference: ref,
									initialTranslation: result,
								},
								translationAnchor ?? {
									left: 120,
									right: 260,
									top: 120,
									bottom: 160,
								},
								translationTarget.chapter,
							);
						}}
						onClose={() => {
							setTranslationOpen(false);
							setPanels((current) =>
								current.right === "study"
									? closeReaderPanel(current, "right")
									: current,
							);
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
					preferredResultId={selectedTranslations.matching(
						studyTarget.reference,
					)}
					sourceId={book.source_id}
					sourceTitle={source.data?.title ?? "所属来源"}
					onCancel={() => setStudyTarget(null)}
					onSaved={(segment: Segment, kind) => {
						setStudyTarget(null);
						records.clearToolbar();
						frames.clearStudySelection();
						setSavedNotice({ id: segment.id, kind, serial: Date.now() });
						void client.invalidateQueries({
							queryKey: ["material-chapter-segments", book.id],
						});
					}}
				/>
			)}
			{selection && !studyTarget && (
				<SelectionToolbar
					onLookup={() => {
						records.clearToolbar();
						dictionary.current?.selection(selection);
					}}
					anchor={selection.anchor}
					copying={contextCopy.busy}
					onCopy={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!presentation.canSample(viewportSize(container.current))
							)
								throw new Error("章节正在加载，请稍后重新选择。");
							const reference = frames.captureStudyReference(
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
									"复制设置尚未加载完成，请重试后再复制。",
								);
								setCopySettingsError(failure);
								throw failure;
							}
							setCopySettingsError(null);
							const content = buildContextCopy(
								chapter.data,
								reference,
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
								!presentation.canSample(viewportSize(container.current))
							)
								throw new Error("章节正在加载，请稍后重新选择。");
							const target = frames.captureStudyTarget(
								book.id,
								book.version_id,
								chapter.data,
							);
							setTranslationTarget(target);
							void translationSessions
								.forTarget(book.source_id, target)
								.open({ kind: "selection", newSelection: true });
							setTranslationAnchor(selection.anchor);
							records.clearToolbar();
							closeMarkHit();
							closePanel();
							setTranslationOpen(true);
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
							if (!chapter.data)
								throw new Error("章节正在加载，请稍后重新选择。");
							const reference = frames.captureStudyReference(
								book.id,
								book.version_id,
								chapter.data,
							);
							getSpeechController().play({
								id: translationTargetKey(reference),
								text: targetText(reference),
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
					onAnki={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!presentation.canSample(viewportSize(container.current))
							)
								throw new Error("章节正在加载，请稍后重新选择。");
							const reference = frames.captureStudyReference(
								book.id,
								book.version_id,
								chapter.data,
							);
							const selectionText = targetText(reference);

							openAnkiComposer(
								{
									origin: "selection",
									selection: selectionText,
									reference,
								},
								selection.anchor,
							);
						} catch (failure) {
							setSelectionError(
								failure instanceof Error
									? failure
									: new Error("无法读取选区，请重新选择。"),
							);
						}
					}}
					onSave={() => {
						try {
							if (
								!chapter.data ||
								!container.current ||
								!presentation.canSample(viewportSize(container.current))
							)
								throw new Error("章节正在加载，请稍后重新选择。");
							setTranslationOpen(false);
							setStudyTarget(
								frames.captureStudyTarget(
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
						animateEntrance={previewEntrance}
						marginEntry={marginRecordEntry(markHit)}
						manualPosition={manualPosition}
						onManualPositionChange={(value) => records.setManualPosition(value)}
						anchor={markHit.anchor}
						anchorPlacement={markHit.anchorPlacement}
						fixed={markHit.fixed}
						loading={marks.loading}
						searchPreview={!!searchPreviewTarget}
						segmentsError={marks.error}
						onRetrySegments={() => {
							void marks.refetch();
						}}
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
						onAnkiSegment={(segmentItem) => {
							if (!chapter.data) return;
							const ref = segmentItem.material_provenance;
							const selectionText = targetText(ref);

							openAnkiComposer(
								{
									origin: "segment",
									selection: selectionText,
									reference: ref,
									initialSegmentId: segmentItem.segment_id,
								},
								markHit.anchor,
							);
						}}
						onAnkiTranslation={(result) => {
							if (!chapter.data) return;
							const ref = result.material_provenance;
							const selectionText = targetText(ref);

							openAnkiComposer(
								{
									origin: "translation",
									selection: selectionText,
									reference: ref,
									initialTranslation: result,
								},
								markHit.anchor,
							);
						}}
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
							searchPreviewChecking ||
							(panels.right === "study" &&
								compactPanels &&
								panels.activeSide !== "right")
						}
						onExpand={() => {
							jumpReading.pause();
							invalidateNavigation();
							navigation.dismissError();
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
			{ankiDraft && ankiContext && (
				<AnkiComposer
					key={ankiDraft.context.key}
					cardRef={ankiCard}
					night={theme === "black"}
					context={ankiContext}
					materialId={book.id}
					anchor={ankiDraft.anchor}
					chapterSegments={ankiSegments.items}
					chapterTranslations={ankiTranslations.items}
					recordsStatus={
						ankiSegments.isError || ankiTranslations.isError
							? "error"
							: ankiSegments.loading || ankiTranslations.loading
								? "loading"
								: "ready"
					}
					settingsState={returnState(
						{ to: `/materials/${book.id}`, label: book.title },
						returnTo,
						"/settings",
					)}
					onConnectionStatus={setAnkiStatus}
					onClose={() => closeAnkiComposer(ankiDraft.context.key)}
					onExported={(message) => {
						closeAnkiComposer(ankiDraft.context.key);
						setAnkiNotice({ message, serial: Date.now() });
					}}
				/>
			)}
			{ankiNotice && (
				<div
					className="reader-study-notice"
					role="status"
					aria-live="polite"
					data-reader-tool=""
				>
					<span>{ankiNotice.message}</span>
					<button
						type="button"
						className="reader-study-notice-close"
						aria-label="关闭通知"
						onClick={() => setAnkiNotice(null)}
					>
						×
					</button>
				</div>
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
									? `全量注音加载失败，当前注音设置已保留${rubyErrorDetail ? `（${rubyErrorDetail}）` : ""}`
									: "正在加载全量注音…"}
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
					设置未能保存到浏览器，仅在本次阅读中生效。
				</p>
			)}
			{leftView.value !== null && leftView.value !== "search" && (
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
					closing={leftView.exiting}
					inactive={
						!active ||
						(compactPanels && !!panels.right && panels.activeSide === "right")
					}
					bookmarks={bookmarks}
					tab={leftView.value}
					onTab={(tab) => selectPanel(tab)}
					onChoose={(id) =>
						void navigation.navigate({ type: "chapter", id }, "left")
					}
					settings={settings}
					navigationError={navigationError}
					onCancelNavigation={() => {
						invalidateNavigation();
					}}
					onClose={() => closePanel("left")}
					onNavigate={(target, mark) =>
						void navigation.navigate({ type: "position", target, mark }, "left")
					}
				/>
			)}
			{leftView.value === "search" && (
				<ReaderSearchPanel
					key={`${book.id}-${book.version_id}`}
					book={book}
					state={searchState}
					onState={setSearchState}
					scrollTop={searchScrollTop}
					closing={leftView.exiting}
					inactive={
						!active ||
						(compactPanels && !!panels.right && panels.activeSide === "right")
					}
					error={searchOpenError ?? navigationError}
					onCancelNavigation={invalidateNavigation}
					onClose={() => closePanel("left")}
					onChoose={chooseSearchResult}
				/>
			)}
			{active &&
				searchBookmark &&
				bookmarks.editing?.id === searchBookmark.id && (
					<ReaderBookmarkDetail
						key={`search-${bookmarks.editorRequest}`}
						bookmark={searchBookmark}
						canLocate={searchBookmarkLocatable}
						bookmarks={bookmarks}
						listUpdatedAt={0}
						settings={settings}
						restoreFocusId="reader-search-trigger"
						onDeleted={() => setSearchBookmark(null)}
						onNavigate={(target) => {
							bookmarks.closeEditor();
							setSearchBookmark(null);
							void navigation.navigate({ type: "position", target });
						}}
					/>
				)}
			{searchTranslationId && panels.right === "study" && (
				<ReaderSearchTranslation
					materialId={book.id}
					resultId={searchTranslationId}
					inactive={!active || (compactPanels && panels.activeSide !== "right")}
					onClose={() => closePanel("right")}
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
						void navigation.navigate({ type: "position", target }, "right")
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
						void navigation
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
								aria-label={
									source.data?.title
										? `查看来源「${source.data.title}」`
										: undefined
								}
								onClick={leave}
							>
								{source.data?.title ? (
									<>
										{source.data.title}
										<span className="reader-info-link-hint" aria-hidden="true">
											查看来源 →
										</span>
									</>
								) : (
									<>
										查看来源 <span aria-hidden="true">→</span>
									</>
								)}
							</Link>
						</dd>
					</dl>
					<label>
						阅读状态
						<NativeSelect
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
						</NativeSelect>
					</label>
					<dl className="reader-book-info">
						<dt>阅读位置保存状态</dt>
						<dd role="status">{status}</dd>
					</dl>
					{notice && (
						<p>{notice === "reused" ? "已打开此前导入的书籍" : "已导入书籍"}</p>
					)}
					<BookImportWarnings warnings={book.warnings} />
				</ReaderPanel>
			)}
		</main>
	);
}

function MaterialOpening({ id, location }: { id: string; location: Location }) {
	const host = useViewActivity();
	const copyEditor = useReaderCopyEditor(host.active);
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
					throw new Error("片段出处不属于本书，无法定位。");
				if (origin.material_provenance?.version_id !== book.version_id)
					throw new Error("出处对应的原书版本已失效，无法定位。");
				originPosition(origin, defaults);
			}
			if (vocabulary) {
				if (
					vocabulary.material_id !== id ||
					vocabulary.version_id !== book.version_id
				)
					throw new Error(
						"本书文件已更新，原词汇位置已失效，请返回词汇页重新选择。",
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
				throw new Error("本书注音数据已更新，请重新打开。");
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
