import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Link } from "react-router";
import { chapterTranslationsKey } from "../materials/chapter-translations-query";
import type { ScreenAnchor } from "../materials/reader-study";
import type { MaterialProvenance, StudyTarget } from "../materials/study-api";
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
} from "./state";
import "./translation.css";

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
	onOpenSegment,
	onBackToOrigin,
}: {
	result: TranslationResult;
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
			<small className="translation-result-meta">
				{result.target_language} · 已留存
			</small>
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
	const element = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const speech = getSpeechController();
	const speechState = useSyncExternalStore(
		speech.subscribe,
		speech.getSnapshot,
	);
	const [position, setPosition] =
		useState<ReturnType<typeof translationCardPosition>>();
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
			setPosition(
				translationCardPosition(
					anchor,
					{ width: window.innerWidth, height: window.innerHeight },
					{ width: node.offsetWidth, height: node.scrollHeight + 2 },
					direction,
					bottomInset,
				),
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		if (content.current) observer.observe(content.current);
		if (playback) observer.observe(playback);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [anchor, direction, visible, speechState, embedded]);
	const translations = useTranslationSessions(translationSessions);
	const session = translations.forTarget(sourceId, target);
	const state = useTranslationSession(session);
	const client = useQueryClient();
	const [offset, setOffset] = useState(0);
	const [resultId, setResultId] = useState<string | null>(
		initialResultId ?? null,
	);
	const [selectedTaskId, setTaskId] = useState<string | null | undefined>(
		undefined,
	);
	const choiceGeneration = useRef(0);
	const view = useRef({ mounted: true, session });
	view.current.session = session;
	useEffect(() => {
		view.current.mounted = true;
		return () => {
			view.current.mounted = false;
		};
	}, []);
	const heading = useRef<HTMLHeadingElement>(null);
	const settings = useQuery({
		queryKey: translationSettingsKey,
		queryFn: getTranslationSettings,
	});
	const identity = useQuery({
		queryKey: ["translation-identity", target.reference],
		queryFn: () => targetIdentity(target.reference),
	});
	const history = useQuery({
		queryKey: ["translations", materialId, identity.data, offset],
		queryFn: () => {
			if (!identity.data) throw new Error("缺少翻译目标身份");
			return getTranslationHistory(materialId, offset, identity.data);
		},
		enabled: !!identity.data,
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.tasks.some(activeTranslation) ? 1200 : false,
	});
	const historyReady =
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
		enabled: !!taskId,
		refetchInterval: (query) =>
			activeTranslation(query.state.data) ? 800 : false,
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
		void applyOutcome(
			session.open({ kind: autoStart ? "selection" : "history" }),
			session,
		);
	}, [session, autoStart, applyOutcome]);
	useEffect(() => {
		if (
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
		if (publishedResult)
			void client.invalidateQueries({
				queryKey: chapterTranslationsKey(materialId),
			});
	}, [client, materialId, publishedResult]);
	const resolvedId =
		resultId ?? (taskId ? task.data?.result_id : history.data?.results[0]?.id);
	const result = useQuery({
		queryKey: ["translation-result", resolvedId],
		queryFn: () => getTranslationResult(resolvedId ?? ""),
		enabled: !!resolvedId,
		retry: false,
	});
	useEffect(() => {
		if (visible && result.isSuccess && result.data.id === resolvedId)
			onResultSelected?.(result.data);
	}, [visible, result.isSuccess, result.data, resolvedId, onResultSelected]);
	useEffect(() => {
		if (visible) heading.current?.focus({ preventScroll: true });
	}, [visible]);
	const start = () => {
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
	};
	return (
		<section
			ref={element}
			className={`translation-card${embedded ? " embedded" : ""}`}
			style={embedded ? undefined : position}
			role={embedded ? "region" : "dialog"}
			aria-label={embedded ? "译文" : undefined}
			aria-labelledby={embedded ? undefined : "translation-heading"}
			data-reader-tool=""
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
				<header>
					<h2 id="translation-heading" ref={heading} tabIndex={-1}>
						选区翻译
					</h2>
					<div className="translation-header-actions">
						<button
							type="button"
							aria-label="关闭翻译（任务继续）"
							onClick={onClose}
						>
							×
						</button>
					</div>
				</header>
			)}
			<div ref={content} className="translation-content">
				{(history.isPending || identity.isPending) && (
					<p role="status">正在找回译文与任务…</p>
				)}
				<InlineError error={history.error ?? identity.error} />
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
				{result.data && (
					<ResultView
						key={result.data.id}
						result={result.data}
						onOpenSegment={onOpenSegment}
						onBackToOrigin={onBackToOrigin}
					/>
				)}
				{!result.data && (
					<>
						<InlineError error={localError ?? settings.error ?? state.error} />
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
				{!result.data && (
					<TranslationOriginal
						text={targetText(target.reference)}
						reference={target.reference}
					/>
				)}
				<details>
					<summary>{result.data ? "语境与重新翻译" : "翻译语境与配置"}</summary>
					{result.data && (
						<>
							<ResultConfiguration result={result.data} />
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
					<InlineError error={localError ?? state.error} />
					{uncertain && <p>提交响应尚未核实，请重试原请求。</p>}
					{(historyReady || uncertain) && (uncertain || !busy) && (
						<button
							type="button"
							disabled={
								(!uncertain && !initialized) ||
								(!uncertain && !settings.data?.model_id) ||
								pending ||
								(!uncertain && !!resolvedId && !result.data)
							}
							onClick={start}
						>
							{uncertain
								? "核实原提交"
								: result.data || history.data?.results.length
									? "按当前语境重新翻译"
									: "开始翻译"}
						</button>
					)}
				</details>
				{currentTask && currentTask.status !== "succeeded" && (
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
						{activeTranslation(currentTask) && (
							<button
								type="button"
								disabled={stop.isPending || currentTask.status === "stopping"}
								onClick={() => stop.mutate(currentTask.id)}
							>
								停止翻译
							</button>
						)}
					</section>
				)}
				<InlineError error={task.error ?? stop.error ?? result.error} />
				{result.isFetching && !result.data && (
					<p role="status">正在读取译文…</p>
				)}

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
