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
import { RequestError } from "../content";
import {
	chapterTranslationsKey,
	translationActivityKey,
} from "../materials/chapter-translations-query";
import type { ScreenAnchor } from "../materials/reader-study";
import type { StudyTarget } from "../materials/study-api";
import { prefillContext } from "../materials/study-context";
import { InlineError } from "../Shared";
import { SpeechControls } from "../speech";
import { getSpeechController } from "../speech/browser";
import {
	type AdoptionSession,
	AdoptTranslation,
	adoptionDestinations,
	beginSeparateAdoption,
	createAdoptionSession,
	SavedTranslationDestinations,
} from "./AdoptTranslation";
import {
	createTranslation,
	getTranslationHistory,
	getTranslationResult,
	getTranslationSettings,
	getTranslationTask,
	stopTranslation,
	type TranslationResult,
	translationSettingsKey,
} from "./api";
import { translationCardPosition } from "./placement";
import {
	activeTranslation,
	createTranslationSession,
	notifyTranslationSession,
	type TranslationSession,
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

function TranslationOriginal({ text }: { text: string }) {
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
	showConfiguration = true,
	session,
	onSaved,
	onOpenSegment,
	onBackToOrigin,
}: {
	result: TranslationResult;
	showConfiguration?: boolean;
	session: AdoptionSession;
	onSaved: () => void;
	onOpenSegment?: (id: string) => void;
	onBackToOrigin?: (result: TranslationResult) => void;
}) {
	const [saving, setSaving] = useState(false);
	const destinations = adoptionDestinations(result, session);
	const [adoptionOpened, setAdoptionOpened] = useState(false);
	return (
		<>
			<TranslationOriginal text={result.text} />

			{adoptionOpened && (
				<div hidden={!saving}>
					<AdoptTranslation
						key={session.newDraftVersion ?? 0}
						result={result}
						session={session}
						onSaved={onSaved}
						onOpenSegment={onOpenSegment}
						onClose={() => setSaving(false)}
					/>
				</div>
			)}
			{!saving && (
				<>
					<p className="translation-output">{result.translation}</p>
					<small className="translation-result-meta">
						{result.target_language} · 已留存
					</small>
					{showConfiguration && (
						<details>
							<summary>本次语境与配置</summary>
							<ResultConfiguration result={result} />
						</details>
					)}
					{destinations.length > 0 && (
						<SavedTranslationDestinations
							ids={destinations}
							allowCreateNew={!result.material_deleted}
							onOpenSegment={onOpenSegment}
							onCreateNew={() => {
								beginSeparateAdoption(session);
								setAdoptionOpened(true);
								setSaving(true);
							}}
						/>
					)}
					<div className="translation-actions">
						{!result.material_deleted && !destinations.length && (
							<button
								type="button"
								onClick={() => {
									setAdoptionOpened(true);
									setSaving(true);
								}}
							>
								保存为学习片段
							</button>
						)}
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
			)}
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
	adoptionSessions,
	translationSessions,
	onClose,
	onSaved,
	onOpenSegment,
	onBackToOrigin,
}: {
	materialId: string;
	sourceId: string;
	target: StudyTarget | null;
	autoStart?: boolean;
	visible?: boolean;
	anchor?: ScreenAnchor | null;
	direction?: "horizontal-tb" | "vertical-rl";
	embedded?: boolean;
	initialResultId?: string;
	adoptionSessions?: Map<string, AdoptionSession>;
	translationSessions?: Map<string, TranslationSession>;
	onClose: () => void;
	onSaved: () => void;
	onOpenSegment?: (id: string) => void;
	onBackToOrigin: (result: TranslationResult) => void;
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
	const fallbackSessions = useRef(new Map<string, AdoptionSession>());
	const sessions = adoptionSessions ?? fallbackSessions.current;
	const sessionFor = (id: string) => {
		let session = sessions.get(id);
		if (!session) {
			session = createAdoptionSession();
			sessions.set(id, session);
		}
		return session;
	};
	const fallbackTranslations = useRef(new Map<string, TranslationSession>());
	const translations = translationSessions ?? fallbackTranslations.current;
	const sessionKey = target ? translationTargetKey(target.reference) : "recent";
	let translationSession = translations.get(sessionKey);
	if (!translationSession) {
		translationSession = createTranslationSession();
		translations.set(sessionKey, translationSession);
	}
	const session = translationSession;
	useSyncExternalStore(
		(listener) => {
			session.listeners.add(listener);
			return () => {
				session.listeners.delete(listener);
			};
		},
		() => session.version,
	);
	const client = useQueryClient();
	const [offset, setOffset] = useState(0);
	const [resultId, setResultId] = useState<string | null>(
		initialResultId ?? null,
	);
	const taskId = session.taskId;
	const setTaskId = (id: string | null) => {
		session.taskId = id;
		notifyTranslationSession(session);
	};
	const [before, setBefore] = useState(session.draft?.before ?? "");
	const [after, setAfter] = useState(session.draft?.after ?? "");
	const [edited, setEdited] = useState(session.draft?.edited ?? false);
	const [initialized, setInitialized] = useState(
		session.draft?.initialized ?? false,
	);
	const [localError, setLocalError] = useState<Error | null>(
		session.draft?.localError ?? null,
	);
	const uncertain = session.uncertain;
	const [budget, setBudget] = useState(
		session.draft?.budget ?? {
			before_sentences: 3,
			before_characters: 200,
			after_sentences: 0,
			after_characters: 0,
		},
	);
	useEffect(() => {
		session.draft = { before, after, edited, initialized, budget, localError };
	}, [session, before, after, edited, initialized, budget, localError]);
	const heading = useRef<HTMLHeadingElement>(null);
	const settings = useQuery({
		queryKey: translationSettingsKey,
		queryFn: getTranslationSettings,
	});
	const identity = useQuery({
		queryKey: ["translation-identity", target?.reference],
		queryFn: () => {
			if (!target) throw new Error("缺少翻译目标");
			return targetIdentity(target.reference);
		},
		enabled: !!target,
	});
	const history = useQuery({
		queryKey: ["translations", materialId, identity.data ?? "recent", offset],
		queryFn: () =>
			getTranslationHistory(
				materialId,
				offset,
				target ? identity.data : undefined,
			),
		enabled: !target || !!identity.data,
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.tasks.some(activeTranslation) ? 1200 : false,
	});
	const historyReady =
		(!target || !!identity.data) &&
		history.isSuccess &&
		history.isFetchedAfterMount &&
		!history.isFetching;
	const task = useQuery({
		queryKey: ["translation-task", taskId],
		queryFn: () => getTranslationTask(taskId ?? ""),
		enabled: !!taskId,
		refetchInterval: (q) => (activeTranslation(q.state.data) ? 800 : false),
	});
	const currentTask = task.data ?? history.data?.tasks.find(activeTranslation);
	const publishedResult = task.data?.result_id ?? history.data?.results[0]?.id;
	useEffect(() => {
		if (publishedResult)
			void client.invalidateQueries({
				queryKey: chapterTranslationsKey(materialId),
			});
	}, [client, materialId, publishedResult]);
	const resolvedId =
		resultId ?? task.data?.result_id ?? history.data?.results[0]?.id;
	const result = useQuery({
		queryKey: ["translation-result", resolvedId],
		queryFn: () => getTranslationResult(resolvedId ?? ""),
		enabled: !!resolvedId,
		retry: false,
	});
	useEffect(() => {
		if (visible) heading.current?.focus({ preventScroll: true });
	}, [visible]);
	useEffect(() => {
		if (initialized || !settings.data || !target) return;
		const b = settings.data;
		setBudget(b);
		try {
			const fill = prefillContext(target.chapter, target.reference, {
				...b,
				enabled: true,
			});
			if (!edited) {
				setBefore(fill.before);
				setAfter(fill.after);
			}
			setInitialized(true);
		} catch (error) {
			setLocalError(error instanceof Error ? error : new Error(String(error)));
			setInitialized(true);
		}
	}, [initialized, settings.data, target, edited]);
	const create = useMutation({
		onSettled: () => {
			void client.invalidateQueries({
				queryKey: translationActivityKey(materialId),
			});
		},
		mutationFn: async () => {
			if (session.request.current)
				return createTranslation(materialId, session.request.current);
			if (!historyReady) throw new Error("请先读取并核实已有翻译。");
			const recovery = currentTask;
			if (!target && !recovery) throw new Error("请从原文选区开始翻译。");
			const values = target
				? {
						source_id: sourceId,
						material_provenance: target.reference,
						text: targetText(target.reference),
						context_before: before,
						context_after: after,
					}
				: (() => {
						if (!recovery) throw new Error("缺少恢复任务");
						return {
							source_id: sourceId,
							material_provenance: recovery.material_provenance,
							text: recovery.text,
							context_before: recovery.context_before,
							context_after: recovery.context_after,
						};
					})();
			const body = session.request.prepare(JSON.stringify(values), () => ({
				...values,
				request_id: crypto.randomUUID(),
			}));
			return createTranslation(materialId, body);
		},
		onSuccess: (value) => {
			session.taskId = value.id;
			session.pending = false;
			setResultId(null);
			session.uncertain = false;
			session.error = null;
			session.request.clear();
			notifyTranslationSession(session);
			client.setQueryData(["translation-task", value.id], value);
			void history.refetch();
		},
		onError: (error) => {
			const lost =
				!!session.request.current &&
				(!(error instanceof RequestError) ||
					error.status === 0 ||
					error.status >= 500);
			session.uncertain = lost;
			session.pending = false;
			session.error = error;
			if (!lost) session.request.clear();
			notifyTranslationSession(session);
		},
	});
	const start = useCallback(() => {
		if (session.pending) return;
		session.pending = true;
		session.error = null;
		session.autoStartConsumed = true;
		notifyTranslationSession(session);
		create.mutate();
	}, [session, create.mutate]);
	useEffect(() => {
		if (!autoStart || session.autoStartConsumed || !target || !historyReady)
			return;
		// Only a complete initial lookup may conclude that no saved result exists.
		// Browsing history consumes the opening intent; it never requests generation.
		if (
			offset > 0 ||
			history.data.results.length ||
			history.data.tasks.some(activeTranslation) ||
			history.data.next_offset !== null
		) {
			session.autoStartConsumed = true;
			return;
		}
		if (
			session.pending ||
			session.uncertain ||
			!initialized ||
			localError ||
			!settings.data?.model_id
		)
			return;
		start();
	}, [
		autoStart,
		target,
		historyReady,
		offset,
		session,
		history.data,
		initialized,
		localError,
		settings.data,
		start,
	]);
	const stop = useMutation({
		mutationFn: (id: string) => stopTranslation(id),
		onSuccess: (value) => {
			client.setQueryData(["translation-task", value.id], value);
			void history.refetch();
		},
	});
	const busy =
		activeTranslation(currentTask) || session.pending || create.isPending;
	const fill = () => {
		if (!target) return;
		try {
			const next = prefillContext(target.chapter, target.reference, {
				...budget,
				enabled: true,
			});
			setBefore(next.before);
			setAfter(next.after);
			setEdited(true);
			setLocalError(null);
		} catch (error) {
			setLocalError(error instanceof Error ? error : new Error(String(error)));
		}
	};
	const speechReference = result.data?.material_provenance ?? target?.reference;
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
			<header>
				{embedded ? (
					<button type="button" onClick={onClose}>
						← 返回翻译列表
					</button>
				) : (
					<h2 id="translation-heading" ref={heading} tabIndex={-1}>
						{target ? "选区翻译" : "最近翻译"}
					</h2>
				)}
				<div className="translation-header-actions">
					{speechReference && (
						<SpeechControls
							compact
							target={{
								id: translationTargetKey(speechReference),
								text: result.data?.text ?? targetText(speechReference),
								label: "译文对应原文",
							}}
						/>
					)}
					{!embedded && (
						<button
							type="button"
							aria-label="关闭翻译（任务继续）"
							onClick={onClose}
						>
							×
						</button>
					)}
				</div>
			</header>
			<div ref={content} className="translation-content">
				{(history.isPending || (identity.isPending && !!target)) && (
					<p role="status">正在找回译文与任务…</p>
				)}
				<InlineError error={history.error ?? identity.error} />
				{history.isError && (
					<button type="button" onClick={() => void history.refetch()}>
						重试读取已有翻译
					</button>
				)}
				{result.data && (
					<ResultView
						key={result.data.id}
						result={result.data}
						showConfiguration={!target}
						session={sessionFor(result.data.id)}
						onSaved={onSaved}
						onOpenSegment={onOpenSegment}
						onBackToOrigin={onBackToOrigin}
					/>
				)}
				{target && !result.data && (
					<>
						<InlineError
							error={localError ?? settings.error ?? session.error}
						/>
						{settings.isError && (
							<button type="button" onClick={() => void settings.refetch()}>
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
				{target && (
					<>
						{!result.data && (
							<TranslationOriginal text={targetText(target.reference)} />
						)}
						<details>
							<summary>
								{result.data ? "语境与重新翻译" : "翻译语境与配置"}
							</summary>
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
										setBefore(event.target.value);
										setEdited(true);
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
										setAfter(event.target.value);
										setEdited(true);
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
							<InlineError error={localError ?? session.error} />
							{uncertain && <p>提交响应尚未核实，请重试原请求。</p>}
							{historyReady && !busy && (
								<button
									type="button"
									disabled={
										!initialized ||
										(!uncertain && !settings.data?.model_id) ||
										create.isPending ||
										(!!resolvedId && !result.data)
									}
									onClick={start}
								>
									{uncertain
										? "核实原提交"
										: result.data
											? "按当前语境重新翻译"
											: "开始翻译"}
								</button>
							)}
						</details>
					</>
				)}
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
						{!target && !activeTranslation(currentTask) && (
							<>
								<TranslationOriginal text={currentTask.text} />
								<details>
									<summary>任务实际语境</summary>
									<p>{currentTask.context_before || "（无前文）"}</p>
									<p>{currentTask.context_after || "（无后文）"}</p>
								</details>
								<InlineError error={session.error} />
								<button
									type="button"
									disabled={
										!historyReady ||
										session.pending ||
										create.isPending ||
										(!uncertain && !settings.data?.model_id)
									}
									onClick={start}
								>
									{uncertain ? "核实原提交" : "用原语境重新翻译"}
								</button>
							</>
						)}
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

				{!target && history.data?.tasks.length === 0 && (
					<p>还没有翻译记录。可在原文选区点击翻译。</p>
				)}
				{history.data &&
					(history.data.results.length > 0 ||
						history.data.tasks.length > 0 ||
						offset > 0) && (
						<>
							<details open={!target}>
								<summary>
									{target ? "此处历史翻译" : "翻译记录"}（本页{" "}
									{history.data.results.length}）
								</summary>
								{history.data.results.map((item) => (
									<button
										className="translation-history-item"
										type="button"
										disabled={session.pending || uncertain}
										key={item.id}
										aria-pressed={resolvedId === item.id}
										onClick={() => {
											setResultId(item.id);
											setTaskId(null);
										}}
									>
										<small>
											{new Date(item.created_at).toLocaleString()} ·{" "}
											{item.target_language}
										</small>
										<span lang="ja">{item.text}</span>
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
											disabled={session.pending || uncertain}
											key={item.id}
											onClick={() => {
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
										disabled={offset === 0 || session.pending || uncertain}
										onClick={() => {
											session.autoStartConsumed = true;
											setOffset(Math.max(0, offset - 15));
											setResultId(null);
											setTaskId(null);
										}}
									>
										上一页
									</button>
									<button
										type="button"
										disabled={
											history.data.next_offset === null ||
											session.pending ||
											uncertain
										}
										onClick={() => {
											session.autoStartConsumed = true;
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
