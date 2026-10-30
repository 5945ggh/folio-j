import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { queries, type Segment } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type ContextBudget,
	getSegmentContextSettings,
	segmentContextKey,
} from "../settings/segment-context-api";
import {
	getTranslationResult,
	type TranslationResult,
} from "../translation/api";
import type { ChapterTranslation } from "./chapter-translations-query";
import {
	ReaderLeaveDialog,
	useReaderLeaveBlocker,
} from "./ReaderLeaveProvider";
import {
	createMaterialSegment,
	type MaterialSegmentInput,
	matchMaterialSegments,
	type StudyTarget,
	selectMaterialSegment,
} from "./study-api";
import { prefillContext } from "./study-context";
import {
	applyContextFill,
	applyStudyTranslation,
	beginContextFill,
	type ContextDraft,
	type ContextFill,
	type ContextSide,
	contextInputError,
	createContextDraft,
	detachStudyTranslation,
	editContext,
	editStudyTranslation,
	prepareStudyRequest,
	uncertainStudyFailure,
} from "./study-draft";
import {
	matchingStudyTranslation,
	translationReferenceKey,
} from "./study-translation";
import "./study.css";

export function StudySegmentPanel({
	target,
	sourceId,
	sourceTitle,
	onCancel,
	onSaved,
	reopenToken,
	translations = [],
	translationsReady = true,
	preferredTranslations = [],
	preferredResultId,
}: {
	target: StudyTarget;
	sourceId: string;
	sourceTitle: string;
	onCancel: () => void;
	onSaved: (segment: Segment, kind: "created" | "existing") => void;
	reopenToken?: number;
	translations?: readonly ChapterTranslation[];
	translationsReady?: boolean;
	preferredTranslations?: readonly TranslationResult[];
	preferredResultId?: string | null;
}) {
	const client = useQueryClient();
	const titleId = useId();
	const [snapshot] = useState(() => structuredClone(target));
	const [targetKey] = useState(() => JSON.stringify(snapshot.reference));
	const [draft, setDraft] = useState(() => createContextDraft(targetKey));
	const draftRef = useRef(draft);
	const updateDraft = useCallback((next: ContextDraft) => {
		draftRef.current = next;
		setDraft(next);
	}, []);
	const [preferred] = useState(() => structuredClone(preferredTranslations));
	const [preferredId] = useState(preferredResultId);
	const [translationResultId, setTranslationResultId] = useState<
		string | null
	>();
	useEffect(() => {
		if (translationResultId !== undefined) return;
		const chosen =
			preferredId ??
			matchingStudyTranslation(
				snapshot.reference,
				translationsReady ? translations : [],
				preferred,
			);
		if (chosen || translationsReady) setTranslationResultId(chosen);
	}, [
		translationResultId,
		translationsReady,
		snapshot.reference,
		translations,
		preferred,
		preferredId,
	]);
	const savedTranslation = useQuery({
		queryKey: ["translation-result", translationResultId],
		queryFn: ({ signal }) =>
			getTranslationResult(translationResultId ?? "", signal),
		enabled: !!translationResultId,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const [budget, setBudget] = useState<ContextBudget | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		if (reopenToken !== undefined) setCollapsed(false);
	}, [reopenToken]);
	const [prefilling, setPrefilling] = useState(false);
	const [prefillError, setPrefillError] = useState<Error | null>(null);
	const [localError, setLocalError] = useState<Error | null>(null);
	const [proposal, setProposal] = useState<{
		generation: number;
		fill: ContextFill;
	} | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [reuse, setReuse] = useState<Segment | null>(null);
	const [uncertain, setUncertain] = useState(false);
	const [detachedTranslation, setDetachedTranslation] = useState<
		"deleted" | "unavailable" | null
	>(null);
	const alive = useRef(true);
	const completed = useRef(false);
	const submitting = useRef(false);
	const initialized = useRef(false);
	const pendingRequest = useRef<MaterialSegmentInput | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const defaults = useQuery({
		queryKey: segmentContextKey,
		queryFn: ({ signal }) => getSegmentContextSettings(signal),
		refetchOnMount: "always",
	});
	const candidates = useQuery({
		queryKey: ["material-segment-matches", sourceId, snapshot.reference],
		queryFn: ({ signal }) =>
			matchMaterialSegments(sourceId, snapshot.reference, signal),
		retry: false,
	});
	const changed =
		draft.before.edited || draft.after.edited || draft.translation.edited;
	const protectedDraft = () =>
		!completed.current &&
		(draftRef.current.before.edited ||
			draftRef.current.after.edited ||
			draftRef.current.translation.edited ||
			Boolean(pendingRequest.current) ||
			submitting.current);
	const blocker = useReaderLeaveBlocker(
		"segment",
		protectedDraft,
		protectedDraft,
	);
	const blockerRef = useRef(blocker);
	blockerRef.current = blocker;
	useEffect(() => {
		alive.current = true;
		heading.current?.focus({ preventScroll: true });
		return () => {
			alive.current = false;
		};
	}, []);

	const accept = (segment: Segment, kind: "created" | "existing") => {
		if (!alive.current) return;
		completed.current = true;
		pendingRequest.current = null;
		client.setQueryData(queries.segment(segment.id), segment);
		void client.invalidateQueries({ queryKey: queries.segments(sourceId) });
		void client.invalidateQueries({ queryKey: queries.source(sourceId) });
		void client.invalidateQueries({ queryKey: ["catalog"] });
		if (kind === "created" && draftRef.current.translation.resultId) {
			void client.invalidateQueries({
				queryKey: ["translation-result", draftRef.current.translation.resultId],
			});
			void client.invalidateQueries({
				queryKey: ["translations", snapshot.reference.material_id],
			});
			void client.invalidateQueries({
				queryKey: ["segment-translations", segment.id],
			});
		}
		if (blockerRef.current.state === "blocked") blockerRef.current.reset();
		onSaved(segment, kind);
	};
	const save = useMutation({
		mutationFn: (body: MaterialSegmentInput) =>
			createMaterialSegment(sourceId, body),
		onSuccess: (segment) => accept(segment, "created"),
		onError: (error, body) => {
			if (!alive.current) return;
			const lost = uncertainStudyFailure(error);
			if (!lost) pendingRequest.current = null;
			setUncertain(lost);
			if (
				body.translation_result_id &&
				error &&
				typeof error === "object" &&
				"status" in error &&
				error.status === 404
			)
				void client.invalidateQueries({
					queryKey: ["translation-result", body.translation_result_id],
					exact: true,
				});
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const select = useMutation({
		mutationFn: (segment: Segment) =>
			selectMaterialSegment(segment.id, snapshot.reference),
		onSuccess: (segment) => accept(segment, "existing"),
		onSettled: () => {
			submitting.current = false;
		},
	});
	const locked = save.isPending || select.isPending || uncertain;
	const detachTranslation = useCallback(
		(resultId: string, reason: "deleted" | "unavailable") => {
			if (!alive.current || completed.current) return;
			const previous = draftRef.current;
			const next = detachStudyTranslation(
				previous,
				resultId,
				pendingRequest.current,
				locked || submitting.current,
			);
			if (next === previous) return;
			updateDraft(next);
			setDetachedTranslation(reason);
		},
		[locked, updateDraft],
	);
	useEffect(() => {
		const result = savedTranslation.data;
		if (result && result.id === translationResultId && result.reader_deleted)
			detachTranslation(result.id, "deleted");
	}, [savedTranslation.data, translationResultId, detachTranslation]);
	useEffect(() => {
		const result = savedTranslation.data;
		if (
			!result ||
			result.id !== translationResultId ||
			result.material_deleted ||
			result.reader_deleted ||
			result.source_id !== sourceId ||
			!alive.current ||
			completed.current ||
			locked ||
			submitting.current ||
			pendingRequest.current ||
			translationReferenceKey(snapshot.reference) !==
				translationReferenceKey(result.material_provenance)
		)
			return;
		updateDraft(applyStudyTranslation(draftRef.current, targetKey, result));
	}, [
		savedTranslation.data,
		translationResultId,
		snapshot.reference,
		sourceId,
		targetKey,
		locked,
		updateDraft,
	]);
	const fill = (chosen: ContextBudget, explicit: boolean) => {
		if (submitting.current || pendingRequest.current) return;
		const next = beginContextFill(draftRef.current);
		updateDraft(next);
		setProposal(null);
		setPrefilling(true);
		setPrefillError(null);
		void Promise.resolve()
			.then(() => prefillContext(snapshot.chapter, snapshot.reference, chosen))
			.then((result) => {
				if (
					!alive.current ||
					completed.current ||
					submitting.current ||
					pendingRequest.current ||
					draftRef.current.generation !== next.generation
				)
					return;
				if (
					explicit &&
					(draftRef.current.before.edited || draftRef.current.after.edited)
				)
					setProposal({ generation: next.generation, fill: result });
				else
					updateDraft(
						applyContextFill(
							draftRef.current,
							targetKey,
							next.generation,
							result,
						),
					);
			})
			.catch((error: unknown) => {
				if (alive.current && draftRef.current.generation === next.generation)
					setPrefillError(
						error instanceof Error
							? error
							: new Error("语境预装失败，可手动填写或仅保存目标。"),
					);
			})
			.finally(() => {
				if (alive.current && draftRef.current.generation === next.generation)
					setPrefilling(false);
			});
	};
	// Defaults are captured once for this draft; later settings reads never replace its budget or fields.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fill deliberately reads the current edited-field refs only on first defaults resolution.
	useEffect(() => {
		if (
			initialized.current ||
			!defaults.isSuccess ||
			!defaults.isFetchedAfterMount ||
			defaults.isFetching ||
			locked
		)
			return;
		initialized.current = true;
		const { revision: _revision, ...chosen } = defaults.data;
		setBudget(chosen);
		if (chosen.enabled) fill(chosen, false);
	}, [
		defaults.data,
		defaults.isSuccess,
		defaults.isFetchedAfterMount,
		defaults.isFetching,
		locked,
	]);

	function edit(side: ContextSide, value: string) {
		if (locked || submitting.current) return;
		updateDraft(editContext(draftRef.current, side, value));
		setProposal(null);
		setLocalError(null);
	}
	function dismiss() {
		if (submitting.current) return;
		if (changed || uncertain) setConfirmDiscard(true);
		else {
			completed.current = true;
			onCancel();
		}
	}
	function discard() {
		if (submitting.current) return;
		completed.current = true;
		if (blocker.state === "blocked") blocker.proceed();
		onCancel();
	}
	function choose(segment: Segment) {
		if (locked || submitting.current) return;
		if (changed) setReuse(segment);
		else {
			submitting.current = true;
			select.mutate(segment);
		}
	}
	const targetText = snapshot.reference.ranges
		.map((range) => range.exact)
		.join("")
		.normalize("NFC");
	const invalid = contextInputError(draft);
	const budgetFields = [
		["before_sentences", "前文句数"],
		["before_characters", "前文字符"],
		["after_sentences", "后文句数"],
		["after_characters", "后文字符"],
	] as const;
	return (
		<aside
			className={`study-segment-panel${collapsed ? " collapsed" : ""}`}
			role="dialog"
			aria-modal="false"
			aria-labelledby={titleId}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault();
					event.stopPropagation();
					setCollapsed(true);
				}
			}}
		>
			<header>
				<h2 id={titleId} ref={heading} tabIndex={-1}>
					保存为学习片段
				</h2>
				<button
					className="study-collapse"
					type="button"
					onClick={() => setCollapsed(!collapsed)}
					aria-expanded={!collapsed}
				>
					{collapsed ? "展开草稿" : "收起"}
				</button>
			</header>
			<div hidden={collapsed} className="study-segment-content">
				<p className="study-source">{sourceTitle}</p>
				<blockquote lang="ja" className="study-target">
					{targetText}
				</blockquote>
				{candidates.isPending && <p role="status">正在查找同一出处的片段…</p>}
				{candidates.isError && (
					<div>
						<InlineError error={candidates.error} />
						<button type="button" onClick={() => void candidates.refetch()}>
							重试查找已有片段
						</button>
					</div>
				)}
				{!!candidates.data?.segments.length && (
					<section className="study-matches">
						<h3>同一出处的已有片段</h3>
						{candidates.data.segments.map((segment) => (
							<button
								key={segment.id}
								type="button"
								disabled={locked}
								onClick={() => choose(segment)}
							>
								选用 {new Date(segment.created_at).toLocaleString()} 的片段
							</button>
						))}
						{candidates.data.truncated && <p>这里只列出最近 20 个匹配项。</p>}
					</section>
				)}
				<label className="study-translation-field">
					译文（可选）
					<textarea
						rows={3}
						disabled={locked}
						value={draft.translation.value}
						onChange={(event) => {
							if (!submitting.current)
								updateDraft(
									editStudyTranslation(draftRef.current, event.target.value),
								);
						}}
					/>
				</label>
				{detachedTranslation && (
					<p role="status">
						{detachedTranslation === "deleted"
							? "原阅读翻译已删除，草稿文字仍保留，可独立保存为片段"
							: "已解除译文关联，草稿文字仍保留，可独立保存为片段"}
					</p>
				)}
				{savedTranslation.isFetching && <p role="status">正在读取已存译文…</p>}
				{(savedTranslation.isError ||
					savedTranslation.data?.material_deleted) && (
					<div>
						<InlineError error={savedTranslation.error} />
						{savedTranslation.data?.material_deleted && (
							<p>原阅读译文当前不可用，可重试读取或解除关联。</p>
						)}
						<button
							type="button"
							disabled={locked}
							onClick={() => void savedTranslation.refetch()}
						>
							重试读取译文
						</button>
						{draft.translation.resultId && (
							<button
								type="button"
								disabled={locked || Boolean(pendingRequest.current)}
								onClick={() => {
									const resultId = draftRef.current.translation.resultId;
									if (resultId) detachTranslation(resultId, "unavailable");
								}}
							>
								保留草稿并解除译文关联
							</button>
						)}
					</div>
				)}
				<fieldset disabled={locked} className="study-context-fields">
					<legend>
						<span>前后文</span>
						<span className="study-optional">可选</span>
						{prefilling && <span role="status">正在摘录…</span>}
						<button
							className="study-clear-all"
							type="button"
							disabled={locked || (!draft.before.value && !draft.after.value)}
							onClick={() => {
								edit("before", "");
								edit("after", "");
							}}
						>
							清空前后文
						</button>
					</legend>
					{(["before", "after"] as const).map((side) => (
						<details key={side} className="study-context-side">
							<summary
								aria-labelledby={`${titleId}-${side}-label ${titleId}-${side}-status`}
							>
								<span className="study-context-label">
									<span id={`${titleId}-${side}-label`}>
										{side === "before" ? "前文" : "后文"}
									</span>
									<span
										id={`${titleId}-${side}-status`}
										className="study-context-status"
									>
										{draft[side].edited
											? "已编辑"
											: draft[side].automatic
												? "自动摘录"
												: "未添加"}
										{draft[side].truncated ? " · 已截断" : ""}
									</span>
									<span className="study-disclosure-icon" aria-hidden="true" />
								</span>
								<span
									className="study-context-preview"
									lang="ja"
									aria-hidden="true"
								>
									{draft[side].value || "（空）"}
								</span>
							</summary>
							<label>
								{side === "before" ? "编辑前文" : "编辑后文"}
								<textarea
									rows={4}
									value={draft[side].value}
									onChange={(event) => edit(side, event.target.value)}
								/>
							</label>
							<button
								className="study-clear"
								type="button"
								onClick={() => edit(side, "")}
							>
								清空{side === "before" ? "前文" : "后文"}
							</button>
						</details>
					))}
					<details className="study-budget">
						<summary>
							本次摘录设置
							<span className="study-disclosure-icon" aria-hidden="true" />
						</summary>
						{budget ? (
							<>
								<div className="study-budget-grid">
									{budgetFields.map(([key, label]) => (
										<label key={key}>
											{label}
											<input
												type="number"
												min={0}
												max={100000}
												step={1}
												value={budget[key]}
												onChange={(event) =>
													setBudget({
														...budget,
														[key]: event.target.valueAsNumber,
													})
												}
											/>
										</label>
									))}
								</div>
								<button
									className="study-refill"
									type="button"
									disabled={prefilling}
									onClick={() => fill({ ...budget, enabled: true }, true)}
								>
									{prefilling ? "正在摘录…" : "按此范围重新摘录"}
								</button>
							</>
						) : (
							<p>
								{defaults.isPending ? "正在读取摘录设置…" : "摘录设置读取失败"}
							</p>
						)}
					</details>
					{defaults.isError && (
						<div>
							<InlineError error={defaults.error} />
							<button type="button" onClick={() => void defaults.refetch()}>
								重试读取摘录设置
							</button>
						</div>
					)}
				</fieldset>
				{prefillError && (
					<div>
						<InlineError error={prefillError} />
						<p className="study-hint">
							目标和草稿已保留，可重试、手动填写或仅保存目标。
						</p>
					</div>
				)}
				{proposal && (
					<section className="study-replacement">
						<h3>新的语境摘录</h3>
						<p>原草稿仍保留。确认后替换前后文。</p>
						<pre lang="ja">
							前文：{proposal.fill.before || "（空）"}
							{"\n"}后文：{proposal.fill.after || "（空）"}
						</pre>
						<button
							type="button"
							disabled={locked}
							onClick={() => {
								updateDraft(
									applyContextFill(
										draftRef.current,
										targetKey,
										proposal.generation,
										proposal.fill,
										true,
									),
								);
								setProposal(null);
							}}
						>
							使用新摘录
						</button>
						<button type="button" onClick={() => setProposal(null)}>
							保留当前草稿
						</button>
					</section>
				)}
				<InlineError error={localError ?? save.error ?? select.error} />
				{invalid && (
					<p role="alert" className="inline-error">
						{invalid}
					</p>
				)}
				{uncertain && (
					<p role="alert">
						保存结果尚未确认，内容已保留。再次核实使用同一个请求，不会重复创建。
					</p>
				)}
			</div>
			<footer hidden={collapsed}>
				<button
					type="button"
					disabled={save.isPending || select.isPending}
					onClick={dismiss}
				>
					取消
				</button>
				<button
					className="primary"
					type="button"
					disabled={
						save.isPending ||
						select.isPending ||
						(!uncertain && Boolean(invalid))
					}
					onClick={() => {
						if (submitting.current) return;
						try {
							const body = prepareStudyRequest(
								pendingRequest.current,
								snapshot.reference,
								draftRef.current,
								() => crypto.randomUUID(),
							);
							pendingRequest.current = body;
							submitting.current = true;
							setLocalError(null);
							save.mutate(body);
						} catch (error) {
							setLocalError(
								error instanceof Error ? error : new Error("无法保存片段。"),
							);
						}
					}}
				>
					{save.isPending ? "保存中…" : uncertain ? "核实本次保存" : "保存片段"}
				</button>
			</footer>
			{(confirmDiscard || blocker.state === "blocked") && (
				<ReaderLeaveDialog>
					<ConfirmDialog
						titleId={`${titleId}-discard`}
						onClose={() => {
							setConfirmDiscard(false);
							if (blocker.state === "blocked") blocker.reset();
						}}
					>
						<h2 id={`${titleId}-discard`}>放弃本次草稿？</h2>
						<p>
							{uncertain
								? "保存结果尚未确认。放弃后可从来源检查片段是否已保存。"
								: "未保存的译文或语境修改会丢失。"}
						</p>
						<div className="actions">
							<button
								type="button"
								data-dialog-cancel
								onClick={() => {
									setConfirmDiscard(false);
									if (blocker.state === "blocked") blocker.reset();
								}}
							>
								继续编辑
							</button>
							<button
								type="button"
								disabled={save.isPending || select.isPending}
								onClick={discard}
							>
								放弃草稿
							</button>
						</div>
					</ConfirmDialog>
				</ReaderLeaveDialog>
			)}
			{reuse && (
				<ReaderLeaveDialog>
					<ConfirmDialog
						titleId={`${titleId}-reuse`}
						onClose={() => setReuse(null)}
					>
						<h2 id={`${titleId}-reuse`}>选用已有片段？</h2>
						<p>将保留已有片段的译文和语境，本次未保存的修改会被放弃。</p>
						<div className="actions">
							<button
								type="button"
								data-dialog-cancel
								onClick={() => setReuse(null)}
							>
								继续编辑
							</button>
							<button
								type="button"
								onClick={() => {
									const chosen = reuse;
									setReuse(null);
									submitting.current = true;
									select.mutate(chosen);
								}}
							>
								选用并打开
							</button>
						</div>
					</ConfirmDialog>
				</ReaderLeaveDialog>
			)}
		</aside>
	);
}
