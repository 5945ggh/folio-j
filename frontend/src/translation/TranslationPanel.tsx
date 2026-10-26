import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
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
import { useReaderCardDrag } from "../materials/use-reader-card-drag";
import { useViewActivity } from "../navigation/view-activity";
import { InlineError } from "../Shared";
import { SpeechControls } from "../speech";
import { getSpeechController } from "../speech/browser";
import { SavedTranslationDestinations } from "./AdoptTranslation";
import {
	getTranslationHistory,
	getTranslationResult,
	getTranslationSettings,
	getTranslationTask,
	type TranslationResult,
	translationSettingsKey,
} from "./api";
import { translationCardPosition } from "./placement";
import type { TranslationSession, TranslationSessions } from "./session";
import { useTranslationSession, useTranslationSessions } from "./session-react";
import {
	activeTranslation,
	targetIdentity,
	targetText,
	translationTargetKey,
	translationVersionShortcut,
} from "./state";
import "./translation.css";

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
}: {
	text: string;
	reference: MaterialProvenance;
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
			<SpeechControls
				compact
				iconOnly
				target={{
					id: translationTargetKey(reference),
					text,
					label: "译文对应原文",
				}}
			/>
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
	onOpenSegment,
	onBackToOrigin,
}: {
	result: TranslationResult;
	versionAction: ReactNode;
	onOpenSegment?: (id: string) => void;
	onBackToOrigin?: (result: TranslationResult) => void;
}) {
	return (
		<>
			<TranslationOriginal
				text={result.text}
				reference={result.material_provenance}
			/>

			<p className="translation-output">{result.translation}</p>
			<div className="translation-result-meta">
				<small>{result.target_language} · 已留存</small>
				{versionAction}
			</div>
			{result.adopted_segment_ids.length > 0 && (
				<SavedTranslationDestinations
					ids={result.adopted_segment_ids}
					allowCreateNew={false}
					onOpenSegment={onOpenSegment}
				/>
			)}
			<div className="translation-actions">
				{onBackToOrigin && (
					<button
						type="button"
						disabled={result.material_deleted}
						onClick={() => onBackToOrigin(result)}
					>
						{result.material_deleted ? "原材料已删除" : "返回原处"}
					</button>
				)}
			</div>
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
	initialResultId,
	translationSessions,
	onClose,
	onOpenSegment,
	onBackToOrigin,
	onResultSelected,
}: {
	materialId: string;
	sourceId: string;
	target: StudyTarget;
	autoStart?: boolean;
	visible?: boolean;
	anchor?: ScreenAnchor | null;
	direction?: "horizontal-tb" | "vertical-rl";
	embedded?: boolean;
	initialResultId?: string;
	translationSessions?: TranslationSessions;
	onClose: () => void;
	onOpenSegment?: (id: string) => void;
	onBackToOrigin: (result: TranslationResult) => void;
	onResultSelected?: (result: TranslationResult) => void;
}) {
	const { active, activation } = useViewActivity();
	const element = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
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
	const draggable = active && wide && visible && !embedded;
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
	}, [anchor, direction, visible, speechState, embedded]);
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
		queryFn: () => {
			if (!identity.data) throw new Error("缺少翻译目标身份");
			return getTranslationHistory(materialId, offset, identity.data);
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
		queryFn: () => getTranslationTask(taskId ?? ""),
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
		queryFn: () => getTranslationResult(resolvedId ?? ""),
		enabled: active && !!resolvedId,
		retry: false,
	});
	const resultRefreshed = useReaderSessionRefresh(
		["translation-result", resolvedId],
		result.refetch,
		active && !!resolvedId,
		activation,
	);
	const readableResult =
		resultRefreshed && result.isSuccess && result.data.id === resolvedId
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
	const displayedResult = readableResult ?? retained ?? followedResult;
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
	const busy = activeTranslation(currentTask) || pending;
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
	const progressLabel = pending
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
	const toolbar = (
		<>
			<span className="translation-progress" role="status">
				{progressLabel && (
					<>
						<span className="translation-spinner" aria-hidden="true" />
						{progressLabel}
					</>
				)}
			</span>
			<div className="translation-header-actions">
				{(displayedResult || initialized || uncertain) && (
					<button
						type="button"
						className="translation-icon-button"
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
					</button>
				)}
				{activeTranslation(currentTask) && currentTask && (
					<button
						type="button"
						className="translation-icon-button"
						aria-label="停止翻译"
						title="停止翻译"
						disabled={stop.isPending || currentTask.status === "stopping"}
						onClick={() => stop.mutate(currentTask.id)}
					>
						<TranslationIcon action="stop" />
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
		</>
	);
	return (
		<section
			ref={element}
			className={`translation-card${embedded ? " embedded" : ""}`}
			style={embedded ? undefined : position}
			role={embedded ? "region" : "dialog"}
			aria-label={embedded ? "译文" : undefined}
			aria-labelledby={embedded ? undefined : "translation-heading"}
			data-reader-tool=""
			data-reader-card-manual={manualPosition ? "true" : undefined}
			data-reader-card-dragging={dragging ? "true" : undefined}
			onKeyDown={(event) => {
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
					<h2 id="translation-heading" ref={heading} tabIndex={-1}>
						译文
					</h2>
					{toolbar}
				</header>
			)}
			{embedded && (
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
							key={displayedResult.id}
							result={displayedResult}
							versionAction={versionAction}
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
				<details>
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
							<details>
								<summary>
									此处历史翻译（本页 {history.data.results.length}）
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
								{!history.data.tasks.length && <p>还没有翻译记录。</p>}
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
							)}
						</>
					)}
			</div>
		</section>
	);
}
