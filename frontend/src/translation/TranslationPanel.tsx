import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Link } from "react-router";
import { chapterTranslationsKey } from "../materials/chapter-translations-query";
import {
	clampReaderCardPosition,
	type ReaderCardBounds,
	type ReaderCardPosition,
} from "../materials/reader-card-drag";
import { useReaderSessionRefresh } from "../materials/reader-session-query";
import type { ScreenAnchor } from "../materials/reader-study";
import type { MaterialProvenance, StudyTarget } from "../materials/study-api";
import { studySidebarPosition } from "../materials/study-overlays";
import { useReaderCardDrag } from "../materials/use-reader-card-drag";
import { useViewActivity } from "../navigation/view-activity";
import { InlineError } from "../Shared";
import { SpeechControls } from "../speech";
import { getSpeechController } from "../speech/browser";
import {
	getTranslationHistory,
	getTranslationResult,
	getTranslationSettings,
	getTranslationTask,
	type TranslationResult,
	translationSettingsKey,
} from "./api";
import { translationCardPosition } from "./placement";
import { SavedTranslationDestinations } from "./SavedTranslationDestinations";
import type { TranslationSession, TranslationSessions } from "./session";
import { useTranslationSession, useTranslationSessions } from "./session-react";
import {
	activeTranslation,
	targetIdentity,
	targetText,
	translationTargetKey,
	translationVersionShortcut,
} from "./state";
import {
	type TranslationRemoved,
	useTranslationRemoval,
} from "./TranslationRemoval";
import "./translation.css";
import "../materials/reader-popover.css";

type ResultSnapshot = {
	session: TranslationSession;
	activation: number;
	result: TranslationResult;
};

function ResultConfiguration({ result }: { result: TranslationResult }) {
	return (
		<>
			<p>前文：{result.context_before || "（空）"}</p>
			<p>后文：{result.context_after || "（空）"}</p>
			<details className="translation-technical">
				<summary>生成信息</summary>
				<p>译文语言：{result.target_language}</p>
				<p>
					{result.scheme_name} · {new Date(result.created_at).toLocaleString()}
				</p>
				<p>
					模型：{result.provider_name} / {result.model_id} · {result.protocol}
				</p>
				<p>
					方案版本：{result.scheme_revision} · 模板：{result.prompt_version}
				</p>
				<p>
					温度：{result.temperature ?? "默认"} · 推理：
					{result.reasoning_effort ?? "默认"} · 输出上限：
					{result.max_output_tokens ?? "默认"}
				</p>
				<p>调用记录：{result.run_id}</p>
			</details>
		</>
	);
}

function TranslationOriginal({
	text,
	reference,
	showSpeech = true,
	onLocate,
}: {
	text: string;
	reference: MaterialProvenance;
	showSpeech?: boolean;
	onLocate?: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [clipped, setClipped] = useState(false);
	const original = useRef<HTMLQuoteElement>(null);
	useLayoutEffect(() => {
		const node = original.current;
		if (!node || expanded) return;
		const measure = () =>
			setClipped(Boolean(text) && node.scrollHeight > node.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [expanded, text]);
	return (
		<div className="translation-original" data-expanded={expanded || undefined}>
			<blockquote ref={original} lang="ja">
				{text}
			</blockquote>
			{showSpeech && (
				<SpeechControls
					compact
					iconOnly
					target={{
						id: translationTargetKey(reference),
						text,
						label: "译文对应原文",
					}}
				/>
			)}
			{onLocate && (
				<button
					type="button"
					className="reader-record-locate-original"
					onClick={onLocate}
				>
					定位原文
				</button>
			)}
			{(clipped || expanded) && (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "收起原文" : "展开原文"}
				</button>
			)}
		</div>
	);
}

function ResultView({
	result,
	versionAction,
	actions,
	onOpenSegment,
	onBackToOrigin,
}: {
	result: TranslationResult;
	versionAction: ReactNode;
	actions: ReactNode;
	onOpenSegment?: (id: string) => void;
	onBackToOrigin?: (result: TranslationResult) => void;
}) {
	return (
		<>
			<TranslationOriginal
				key={result.id}
				text={result.text}
				reference={result.material_provenance}
				showSpeech={false}
				onLocate={
					onBackToOrigin && !result.material_deleted
						? () => onBackToOrigin(result)
						: undefined
				}
			/>

			<p className="translation-output">{result.translation}</p>
			{actions}
			{versionAction && (
				<div className="translation-result-meta">{versionAction}</div>
			)}
			{result.adopted_segment_ids.length > 0 && (
				<SavedTranslationDestinations
					ids={result.adopted_segment_ids}
					onOpenSegment={onOpenSegment}
				/>
			)}
		</>
	);
}

function TranslationIcon({
	action,
}: {
	action: "retry" | "stop" | "close" | "history";
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{action === "stop" ? (
				<rect x="6" y="6" width="12" height="12" rx="1" />
			) : (
				<path
					d={
						{
							retry: "M20 10a8 8 0 1 0-1 7M20 4v6h-6",
							close: "m6 6 12 12M18 6 6 18",
							history: "M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l3 2",
						}[action]
					}
				/>
			)}
		</svg>
	);
}

export function TranslationPanel({
	materialId,
	sourceId,
	target,
	autoStart = false,
	visible = true,
	anchor = null,
	direction = "horizontal-tb",
	embedded = false,
	showDetails = true,
	expanded: controlledExpanded,
	onExpand,
	onCollapse,
	initialResultId,
	translationSessions,
	onClose,
	onOpenSegment,
	onBackToOrigin,
	onResultSelected,
	onRemoved,
}: {
	materialId: string;
	sourceId: string;
	target: StudyTarget;
	autoStart?: boolean;
	visible?: boolean;
	anchor?: ScreenAnchor | null;
	direction?: "horizontal-tb" | "vertical-rl";
	embedded?: boolean;
	showDetails?: boolean;
	expanded?: boolean;
	onExpand?: () => void;
	onCollapse?: () => void;
	initialResultId?: string;
	translationSessions?: TranslationSessions;
	onClose: () => void;
	onOpenSegment?: (id: string) => void;
	onBackToOrigin?: (result: TranslationResult) => void;
	onResultSelected?: (result: TranslationResult) => void;
	onRemoved?: TranslationRemoved;
}) {
	const { active, activation } = useViewActivity();
	const element = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const [localExpanded, setLocalExpanded] = useState(false);
	const expanded = controlledExpanded ?? localExpanded;
	const detailsVisible = embedded ? showDetails : expanded;
	const speech = getSpeechController();
	const speechState = useSyncExternalStore(
		speech.subscribe,
		speech.getSnapshot,
	);
	const [position, setPosition] =
		useState<ReturnType<typeof translationCardPosition>>();
	const [manualPosition, setManualPosition] =
		useState<ReaderCardPosition | null>(null);
	const manual = useRef(manualPosition);
	manual.current = manualPosition;
	const measurePosition = useRef<(() => void) | null>(null);
	const manualBounds = useRef<{
		bounds: ReaderCardBounds;
		height: number;
	} | null>(null);
	const [wide, setWide] = useState(() => innerWidth > 600);
	const draggable = active && wide && visible && !embedded && !expanded;
	const { dragging, handlers: dragHandlers } = useReaderCardDrag(
		element,
		draggable,
		(value) =>
			manualBounds.current
				? clampReaderCardPosition(
						value,
						manualBounds.current.bounds,
						manualBounds.current.height,
					)
				: value,
		setManualPosition,
	);
	useLayoutEffect(() => {
		const node = element.current;
		if (!node || !visible || embedded) return;
		const playback = speechState.target
			? node
					.closest(".reader-r1")
					?.querySelector<HTMLElement>(".device-speech-bar")
			: null;
		const measure = () => {
			const bottomInset = playback
				? Math.max(
						76,
						window.innerHeight - playback.getBoundingClientRect().top + 12,
					)
				: 76;
			const viewport = { width: innerWidth, height: innerHeight };
			const size = { width: node.offsetWidth, height: node.scrollHeight + 2 };
			if (expanded) {
				setPosition(studySidebarPosition(viewport, size.width, bottomInset));
				return;
			}
			const available = translationCardPosition(
				null,
				viewport,
				{ ...size, height: Number.MAX_SAFE_INTEGER },
				direction,
				bottomInset,
			);
			const renderedHeight = Math.min(size.height, available.maxHeight);
			manualBounds.current = {
				bounds: {
					left: 12,
					right: available.left,
					top: available.top,
					bottom: Math.max(available.top, viewport.height - bottomInset),
				},
				height: renderedHeight,
			};
			setWide(innerWidth > 600);
			setPosition(
				manual.current && innerWidth > 600
					? {
							...clampReaderCardPosition(
								manual.current,
								manualBounds.current.bounds,
								renderedHeight,
							),
							maxHeight: available.maxHeight,
						}
					: translationCardPosition(
							anchor,
							viewport,
							size,
							direction,
							bottomInset,
						),
			);
		};
		measurePosition.current = measure;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		if (content.current) observer.observe(content.current);
		if (playback) observer.observe(playback);
		window.addEventListener("resize", measure);
		return () => {
			measurePosition.current = null;
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [anchor, direction, visible, speechState, embedded, expanded]);
	useLayoutEffect(() => {
		manual.current = manualPosition;
		measurePosition.current?.();
	}, [manualPosition]);
	const translations = useTranslationSessions(translationSessions);
	const session = translations.forTarget(sourceId, target);
	const state = useTranslationSession(session);
	const client = useQueryClient();
	const [offset, setOffset] = useState(0);
	const [resultId, setResultId] = useState<string | null>(
		initialResultId ?? null,
	);
	const [retainedResult, setRetainedResult] = useState<ResultSnapshot>();
	const [versionReturnId, setVersionReturnId] = useState<string | null>(null);
	const [selectedTaskId, setTaskId] = useState<string | null | undefined>(
		undefined,
	);
	const choiceGeneration = useRef(0);
	const view = useRef({ mounted: true, session, active });
	view.current.session = session;
	view.current.active = active;
	useEffect(() => {
		view.current.mounted = true;
		return () => {
			view.current.mounted = false;
		};
	}, []);
	const heading = useRef<HTMLHeadingElement>(null);
	const settings = useQuery({
		enabled: active,
		queryKey: translationSettingsKey,
		queryFn: getTranslationSettings,
	});
	const identity = useQuery({
		enabled: active,
		queryKey: ["translation-identity", target.reference],
		queryFn: () => targetIdentity(target.reference),
	});
	const history = useQuery({
		queryKey: ["translations", materialId, identity.data, offset],
		queryFn: ({ signal }) => {
			if (!identity.data) throw new Error("缺少翻译目标身份");
			return getTranslationHistory(materialId, offset, identity.data, signal);
		},
		enabled: active && !!identity.data,
		retry: false,
		refetchInterval: (query) =>
			active && query.state.data?.tasks.some(activeTranslation) ? 1200 : false,
	});
	const historyRefreshed = useReaderSessionRefresh(
		["translations", materialId, identity.data, offset],
		history.refetch,
		active && !!identity.data,
		activation,
	);
	const historyReady =
		historyRefreshed &&
		!!identity.data &&
		history.isSuccess &&
		history.isFetchedAfterMount &&
		!history.isFetching;
	const taskId =
		selectedTaskId === undefined && resultId === null
			? state.acceptedTaskId
			: selectedTaskId;
	const task = useQuery({
		queryKey: ["translation-task", taskId],
		queryFn: ({ signal }) => getTranslationTask(taskId ?? "", signal),
		enabled: active && !!taskId,
		refetchInterval: (query) =>
			active && activeTranslation(query.state.data) ? 800 : false,
	});
	const currentTask = resultId
		? undefined
		: taskId
			? task.data
			: selectedTaskId === undefined
				? history.data?.tasks.find(activeTranslation)
				: undefined;
	const { before, after, budget, initialized, localError } = state.draft;
	const uncertain = state.phase === "uncertain";
	const pending = state.phase === "submitting";
	const applyOutcome = useCallback(
		async (
			operation: ReturnType<TranslationSession["execute"]>,
			origin: TranslationSession,
		) => {
			const generation = choiceGeneration.current;
			const outcome = await operation;
			if (
				outcome.kind === "accepted" &&
				view.current.mounted &&
				view.current.active &&
				view.current.session === origin &&
				choiceGeneration.current === generation
			) {
				setResultId(null);
				setTaskId(outcome.taskId);
			}
		},
		[],
	);
	useEffect(() => {
		if (!active) return;
		void applyOutcome(
			session.open({ kind: autoStart ? "selection" : "history" }),
			session,
		);
	}, [active, session, autoStart, applyOutcome]);
	useEffect(() => {
		if (
			!active ||
			!historyRefreshed ||
			!history.isSuccess ||
			history.isFetching ||
			!settings.isSuccess ||
			!settings.data?.model_id
		)
			return;
		void applyOutcome(
			session.open({ kind: autoStart ? "selection" : "history" }),
			session,
		);
	}, [
		active,
		historyRefreshed,
		session,
		autoStart,
		applyOutcome,
		history.isSuccess,
		history.isFetching,
		settings.isSuccess,
		settings.data?.model_id,
	]);
	const publishedResult = task.data?.result_id ?? history.data?.results[0]?.id;
	useEffect(() => {
		if (active && publishedResult)
			void client.invalidateQueries({
				queryKey: chapterTranslationsKey(materialId),
			});
	}, [active, client, materialId, publishedResult]);
	const resolvedId =
		resultId ?? (taskId ? task.data?.result_id : history.data?.results[0]?.id);
	const result = useQuery({
		queryKey: ["translation-result", resolvedId],
		queryFn: ({ signal }) => getTranslationResult(resolvedId ?? "", signal),
		enabled: active && !!resolvedId,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const resultRefreshed = useReaderSessionRefresh(
		["translation-result", resolvedId],
		result.refetch,
		active && !!resolvedId,
		activation,
	);
	const readableResult =
		resultRefreshed &&
		result.isSuccess &&
		!result.data.reader_deleted &&
		!state.removal?.resultIds.includes(result.data.id) &&
		result.data.id === resolvedId
			? result.data
			: undefined;
	const lastLoadedResult = useRef<ResultSnapshot | null>(null);
	useLayoutEffect(() => {
		if (readableResult)
			lastLoadedResult.current = {
				session,
				activation,
				result: readableResult,
			};
	}, [session, activation, readableResult]);
	const followedResult =
		resultId === null &&
		selectedTaskId === undefined &&
		taskId &&
		lastLoadedResult.current?.session === session &&
		lastLoadedResult.current.activation === activation
			? lastLoadedResult.current.result
			: undefined;
	const retained =
		retainedResult?.session === session &&
		retainedResult.activation === activation
			? retainedResult.result
			: undefined;
	// Only this activation's validated output may bridge a pending or failed retranslation read.
	const resultCandidate = result.data?.reader_deleted
		? undefined
		: (readableResult ?? retained ?? followedResult);
	const displayedResult =
		resultCandidate && !state.removal?.resultIds.includes(resultCandidate.id)
			? resultCandidate
			: undefined;
	useLayoutEffect(() => {
		const removed = state.removal;
		if (!removed) return;
		const includes = (id: string | null | undefined) =>
			!!id && removed.resultIds.includes(id);
		if (
			includes(retainedResult?.result.id) ||
			includes(lastLoadedResult.current?.result.id)
		) {
			const fallback = removed.remainingResultId
				? client.getQueryData<TranslationResult>([
						"translation-result",
						removed.remainingResultId,
					])
				: undefined;
			setRetainedResult(
				fallback && !fallback.reader_deleted && !includes(fallback.id)
					? { session, activation, result: fallback }
					: undefined,
			);
		}
		if (includes(lastLoadedResult.current?.result.id))
			lastLoadedResult.current = null;
		if (includes(versionReturnId)) setVersionReturnId(null);
		if (includes(resolvedId)) {
			choiceGeneration.current++;
			setResultId(removed.remainingResultId);
			setTaskId(null);
			setOffset(0);
		}
	}, [
		state.removal,
		retainedResult,
		versionReturnId,
		resolvedId,
		client,
		session,
		activation,
	]);
	useEffect(() => {
		if (visible && readableResult) onResultSelected?.(readableResult);
	}, [visible, readableResult, onResultSelected]);
	useEffect(() => {
		if (visible) heading.current?.focus({ preventScroll: true });
	}, [visible]);
	const start = () => {
		setRetainedResult(
			displayedResult
				? { session, activation, result: displayedResult }
				: undefined,
		);
		setVersionReturnId(null);
		void applyOutcome(
			session.execute({ kind: uncertain ? "verify" : "translate" }),
			session,
		);
	};
	const stop = useMutation({
		mutationFn: (id: string) => session.stop(id),
	});
	const removing = state.phase === "removing";
	const busy = activeTranslation(currentTask) || pending || removing;
	const removed: TranslationRemoved = (value, reference) => {
		const remaining =
			"remaining_result" in value ? value.remaining_result : null;
		setOffset(0);
		if (onRemoved) onRemoved(value, reference);
		else if (!remaining) onClose();
	};
	const moreId = useId();
	const more = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		if (!visible && more.current) more.current.open = false;
		const dismiss = (event: PointerEvent) => {
			if (more.current && !more.current.contains(event.target as Node))
				more.current.open = false;
		};
		window.addEventListener("pointerdown", dismiss);
		return () => window.removeEventListener("pointerdown", dismiss);
	}, [visible]);
	const removal = useTranslationRemoval({
		session,
		onRemoved: removed,
		restoreFocusId: moreId,
		withLabel: true,
		onOpenConfirmation: () => {
			if (more.current) {
				more.current.open = false;
				more.current.querySelector("summary")?.focus();
			}
		},
	});
	const moreActions = (
		<details
			ref={more}
			className="translation-more"
			onKeyDown={(event) => {
				if (event.key === "Escape" && more.current?.open) {
					event.preventDefault();
					event.stopPropagation();
					more.current.open = false;
					more.current.querySelector("summary")?.focus();
				}
			}}
		>
			<summary id={moreId} aria-label="更多翻译操作" title="更多翻译操作">
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="currentColor"
					aria-hidden="true"
				>
					<circle cx="5" cy="12" r="1.5" />
					<circle cx="12" cy="12" r="1.5" />
					<circle cx="19" cy="12" r="1.5" />
				</svg>
			</summary>
			<div className="translation-more-actions">{removal.action}</div>
		</details>
	);
	const fill = () => session.edit({ kind: "refill" });
	const setBudget = (value: typeof budget) =>
		session.edit({ kind: "budget", value });
	const browse = () => {
		choiceGeneration.current++;
		session.browseHistory();
		setRetainedResult(undefined);
		setVersionReturnId(null);
	};
	const versionShortcut = translationVersionShortcut(
		history.data?.results ?? [],
		displayedResult?.id ?? resolvedId ?? undefined,
		versionReturnId,
	);
	const versionAction = versionShortcut && (
		<button
			type="button"
			className="translation-version-action"
			disabled={busy || (!!displayedResult && !!resolvedId && !readableResult)}
			onClick={() => {
				const returnId = versionReturnId ? null : (displayedResult?.id ?? null);
				browse();
				setVersionReturnId(returnId);
				setResultId(versionShortcut.id);
				setTaskId(null);
			}}
		>
			<TranslationIcon action="history" />
			{versionShortcut.label}
		</button>
	);
	const progressLabel = removing
		? "正在删除"
		: pending
			? "提交中"
			: currentTask?.status === "queued"
				? "等待翻译"
				: currentTask?.status === "running"
					? displayedResult
						? "重译中"
						: "翻译中"
					: currentTask?.status === "stopping"
						? "停止中"
						: history.isPending ||
								identity.isPending ||
								(result.isFetching && !readableResult && !!resolvedId)
							? "读取中"
							: "";
	const actionLabel = uncertain
		? "核实原提交"
		: displayedResult || history.data?.results.length
			? "重新翻译"
			: "开始翻译";
	const actionDisabled =
		pending ||
		(!uncertain &&
			(!historyReady ||
				!initialized ||
				!settings.data?.model_id ||
				busy ||
				(!!resolvedId && !readableResult)));
	const translationAction = (withText = false) => (
		<button
			type="button"
			className={
				withText ? "translation-text-action" : "translation-icon-button"
			}
			aria-label={actionLabel}
			title={
				actionLabel === "重新翻译"
					? "用当前语境与设置重新翻译，保留已有译文"
					: actionLabel
			}
			disabled={actionDisabled}
			onClick={start}
		>
			<TranslationIcon action="retry" />
			{withText && actionLabel}
		</button>
	);
	const stopAction = (withText = false) =>
		activeTranslation(currentTask) && currentTask ? (
			<button
				type="button"
				className={
					withText ? "translation-text-action" : "translation-icon-button"
				}
				aria-label="停止翻译"
				title="停止翻译"
				disabled={stop.isPending || currentTask.status === "stopping"}
				onClick={() => stop.mutate(currentTask.id)}
			>
				<TranslationIcon action="stop" />
				{withText && "停止翻译"}
			</button>
		) : null;
	const resultActions = displayedResult && (
		<fieldset className="translation-result-actions" aria-label="译文操作">
			<SpeechControls
				compact
				target={{
					id: translationTargetKey(displayedResult.material_provenance),
					text: displayedResult.text,
					label: "译文对应原文",
				}}
			/>
			{!uncertain && activeTranslation(currentTask)
				? stopAction(true)
				: translationAction(true)}
			{moreActions}
		</fieldset>
	);
	const showHeaderActions =
		!displayedResult &&
		(initialized || uncertain || !!history.data?.tasks.length || !!currentTask);
	const showToolbar = !!progressLabel || showHeaderActions || !embedded;
	const toolbar = (
		<>
			{progressLabel && (
				<span className="translation-progress" role="status">
					<span className="translation-spinner" aria-hidden="true" />
					{progressLabel}
				</span>
			)}
			{(showHeaderActions || !embedded) && (
				<div className="translation-header-actions">
					{!displayedResult &&
						(!!history.data?.tasks.length || currentTask) &&
						moreActions}
					{!displayedResult &&
						(initialized || uncertain) &&
						translationAction()}
					{!displayedResult && stopAction()}
					{!embedded && (
						<button
							type="button"
							aria-expanded={expanded}
							onClick={() => {
								if (expanded) {
									onCollapse?.();
									setLocalExpanded(false);
								} else {
									onExpand?.();
									setLocalExpanded(true);
								}
							}}
						>
							{expanded ? "收起" : "展开"}
						</button>
					)}
					{!embedded && (
						<button
							type="button"
							className="translation-icon-button"
							aria-label="关闭翻译（任务继续）"
							title="收起译文（任务继续）"
							onClick={onClose}
						>
							<TranslationIcon action="close" />
						</button>
					)}
				</div>
			)}
		</>
	);
	return (
		<section
			ref={element}
			className={`translation-card reader-popover${embedded ? " embedded" : ""}${!embedded && expanded ? " expanded" : ""}`}
			style={
				embedded
					? undefined
					: { ...position, height: expanded ? position?.maxHeight : undefined }
			}
			role={embedded ? "region" : "dialog"}
			aria-label={embedded ? "译文" : undefined}
			aria-labelledby={embedded ? undefined : "translation-heading"}
			data-reader-tool=""
			data-reader-panel-side={!embedded && expanded ? "right" : undefined}
			data-reader-card-manual={manualPosition ? "true" : undefined}
			data-reader-card-dragging={dragging ? "true" : undefined}
			onKeyDown={(event) => {
				if (
					event.key === "Escape" &&
					(event.target as Element).closest("dialog")
				) {
					event.stopPropagation();
					return;
				}
				if (
					!embedded &&
					event.key === "Escape" &&
					!event.defaultPrevented &&
					!event.nativeEvent.isComposing
				) {
					event.stopPropagation();
					event.preventDefault();
					onClose();
				}
			}}
		>
			{!embedded && (
				<header
					data-reader-card-drag-handle=""
					data-reader-card-draggable={draggable ? "true" : "false"}
					tabIndex={draggable ? 0 : undefined}
					title={
						draggable
							? "拖动标题栏移动；聚焦后用方向键移动，Shift 加快"
							: undefined
					}
					{...dragHandlers}
				>
					<div className="reader-popover-title">
						<span className="reader-popover-seal" aria-hidden="true">
							译
						</span>
						<h2 id="translation-heading" ref={heading} tabIndex={-1}>
							翻译
						</h2>
					</div>
					{toolbar}
				</header>
			)}
			{embedded && showToolbar && (
				<div className="translation-embedded-toolbar">{toolbar}</div>
			)}
			<div ref={content} className="translation-content">
				<InlineError error={history.error ?? identity.error} />
				<InlineError error={localError ?? settings.error ?? state.error} />
				{uncertain && <p role="status">提交响应尚未核实，请核实原提交。</p>}
				{history.isError && (
					<button
						type="button"
						onClick={() => {
							void history.refetch().then(() => {
								void applyOutcome(
									session.open({ kind: autoStart ? "selection" : "history" }),
									session,
								);
							});
						}}
					>
						重试读取已有翻译
					</button>
				)}
				{displayedResult && (
					<div className="translation-result-view" aria-busy={busy}>
						<ResultView
							result={displayedResult}
							versionAction={versionAction}
							actions={resultActions}
							onOpenSegment={onOpenSegment}
							onBackToOrigin={onBackToOrigin}
						/>
					</div>
				)}
				{!displayedResult && (
					<>
						{settings.isError && (
							<button
								type="button"
								onClick={() => {
									void settings.refetch().then(() => {
										void applyOutcome(
											session.open({
												kind: autoStart ? "selection" : "history",
											}),
											session,
										);
									});
								}}
							>
								重试翻译设置
							</button>
						)}
						{settings.data && !settings.data.model_id && (
							<p>
								请先在<Link to="/settings?section=translation">翻译设置</Link>
								选择模型。
							</p>
						)}
					</>
				)}
				{!displayedResult && (
					<TranslationOriginal
						text={targetText(target.reference)}
						reference={target.reference}
					/>
				)}
				{!displayedResult && versionAction}
				<details hidden={!detailsVisible}>
					<summary>语境与设置</summary>
					{displayedResult && (
						<>
							<ResultConfiguration result={displayedResult} />
							<hr />
							<p>准备新的翻译</p>
						</>
					)}
					{settings.data ? (
						<p>
							{settings.data.name} · {settings.data.target_language}
						</p>
					) : (
						<InlineError error={settings.error} />
					)}
					<Link to="/settings?section=translation">翻译设置</Link>
					<div className="translation-budget">
						{(["before", "after"] as const).map((side) => (
							<label key={side}>
								{side === "before" ? "前文" : "后文"}句数
								<input
									type="number"
									min={0}
									max={100}
									value={budget[`${side}_sentences`]}
									onChange={(event) =>
										setBudget({
											...budget,
											[`${side}_sentences`]: event.target.valueAsNumber,
										})
									}
								/>
							</label>
						))}
						{(["before", "after"] as const).map((side) => (
							<label key={`${side}-characters`}>
								{side === "before" ? "前文" : "后文"}码点
								<input
									type="number"
									min={0}
									max={settings.data?.max_context_characters ?? 2000}
									value={budget[`${side}_characters`]}
									onChange={(event) =>
										setBudget({
											...budget,
											[`${side}_characters`]: event.target.valueAsNumber,
										})
									}
								/>
							</label>
						))}
					</div>
					<button
						type="button"
						disabled={!initialized || busy || uncertain}
						onClick={fill}
					>
						按句数重新摘录（替换下面语境）
					</button>
					<label>
						前文
						<textarea
							rows={3}
							disabled={busy || uncertain}
							value={before}
							onChange={(event) => {
								session.edit({
									kind: "context",
									before: event.target.value,
								});
							}}
						/>
					</label>
					<label>
						后文
						<textarea
							rows={2}
							disabled={busy || uncertain}
							value={after}
							onChange={(event) => {
								session.edit({
									kind: "context",
									after: event.target.value,
								});
							}}
						/>
					</label>
					<small>提交后固定本次输入。旧译文仍使用上次生成时的语境。</small>
					{settings.data && !settings.data.model_id && (
						<p>
							先在<Link to="/settings?section=translation">翻译设置</Link>
							选择模型。
						</p>
					)}
				</details>
				{currentTask &&
					currentTask.status !== "succeeded" &&
					!activeTranslation(currentTask) && (
						<section role="status">
							<p>
								{
									(
										{
											queued: "等待翻译…",
											running: "正在翻译…",
											stopping: "正在停止…",
											succeeded: "翻译完成",
											failed: "翻译失败",
											cancelled: "已停止翻译",
											interrupted: "任务因应用重启中断",
										} as const
									)[currentTask.status]
								}
							</p>
							{currentTask.error && <p>{currentTask.error}</p>}
						</section>
					)}
				<InlineError error={task.error ?? stop.error ?? result.error} />

				{history.data &&
					(history.data.results.length > 0 ||
						history.data.tasks.length > 0 ||
						offset > 0) && (
						<>
							<details hidden={!detailsVisible}>
								<summary>
									历史译文（本页 {history.data.results.length}）
								</summary>
								{history.data.results.map((item) => (
									<button
										className="translation-history-item"
										type="button"
										key={item.id}
										aria-pressed={resolvedId === item.id}
										onClick={() => {
											browse();
											setResultId(item.id);
											setTaskId(null);
										}}
									>
										<small>
											{new Date(item.created_at).toLocaleString()} ·{" "}
											{item.target_language}
										</small>
										<span>{item.translation}</span>
									</button>
								))}
								{!history.data.tasks.length && !history.data.results.length && (
									<p>还没有翻译记录。</p>
								)}
								{history.data.tasks
									.filter((item) => !item.result_id)
									.map((item) => (
										<button
											className="translation-history-item"
											type="button"
											key={item.id}
											onClick={() => {
												browse();
												setTaskId(item.id);
												setResultId(null);
											}}
										>
											{item.text.slice(0, 45)} · {item.status}
										</button>
									))}
							</details>
							{(offset > 0 || history.data.next_offset !== null) && (
								<div hidden={!detailsVisible}>
									<div className="translation-actions">
										<button
											type="button"
											disabled={offset === 0}
											onClick={() => {
												browse();
												setOffset(Math.max(0, offset - 15));
												setResultId(null);
												setTaskId(null);
											}}
										>
											上一页
										</button>
										<button
											type="button"
											disabled={history.data.next_offset === null}
											onClick={() => {
												browse();
												setOffset(history.data?.next_offset ?? 0);
												setResultId(null);
												setTaskId(null);
											}}
										>
											下一页
										</button>
									</div>
								</div>
							)}
						</>
					)}
			</div>
			{removal.dialog}
		</section>
	);
}
