import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { queries, type Segment } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type ContextBudget,
	getSegmentContextSettings,
	segmentContextKey,
} from "../settings/segment-context-api";
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
	beginContextFill,
	type ContextDraft,
	type ContextFill,
	type ContextSide,
	contextInputError,
	createContextDraft,
	editContext,
	prepareStudyRequest,
	uncertainStudyFailure,
} from "./study-draft";
import "./study.css";

export function StudySegmentPanel({
	target,
	sourceId,
	sourceTitle,
	onCancel,
	onSaved,
	reopenToken,
}: {
	target: StudyTarget;
	sourceId: string;
	sourceTitle: string;
	onCancel: () => void;
	onSaved: (segment: Segment, kind: "created" | "existing") => void;
	reopenToken?: number;
}) {
	const client = useQueryClient();
	const titleId = useId();
	const [snapshot] = useState(() => structuredClone(target));
	const [targetKey] = useState(() => JSON.stringify(snapshot.reference));
	const [draft, setDraft] = useState(() => createContextDraft(targetKey));
	const draftRef = useRef(draft);
	const updateDraft = (next: ContextDraft) => {
		draftRef.current = next;
		setDraft(next);
	};
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
	const changed = draft.before.edited || draft.after.edited;
	const blocker = useBlocker(
		() => !completed.current && (changed || uncertain || submitting.current),
	);
	const blockerRef = useRef(blocker);
	blockerRef.current = blocker;
	useBeforeUnload(
		useCallback((event) => {
			if (
				!completed.current &&
				(draftRef.current.before.edited ||
					draftRef.current.after.edited ||
					pendingRequest.current ||
					submitting.current)
			) {
				event.preventDefault();
				event.returnValue = "";
			}
		}, []),
	);
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
		if (blockerRef.current.state === "blocked") blockerRef.current.reset();
		onSaved(segment, kind);
	};
	const save = useMutation({
		mutationFn: (body: MaterialSegmentInput) =>
			createMaterialSegment(sourceId, body),
		onSuccess: (segment) => accept(segment, "created"),
		onError: (error) => {
			if (!alive.current) return;
			const lost = uncertainStudyFailure(error);
			if (!lost) pendingRequest.current = null;
			setUncertain(lost);
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
					type="button"
					onClick={() => setCollapsed(!collapsed)}
					aria-expanded={!collapsed}
				>
					{collapsed ? "展开草稿" : "收起"}
				</button>
			</header>
			<div hidden={collapsed} className="study-segment-content">
				<p className="study-source">所属来源：{sourceTitle}</p>
				<blockquote lang="ja" className="study-target">
					{targetText}
				</blockquote>
				<p className="study-hint">
					目标已固定为此次选区。保存后可添加讲解或按需讨论。
				</p>
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
						<p className="study-hint">选用后保留该片段的已存语境。</p>
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
				<fieldset disabled={locked} className="study-context-fields">
					<legend>新建片段的语境</legend>
					<p className="study-hint">
						自动摘录会整理边缘空白和连续空行，并按整理后的字数取文。
					</p>
					{(["before", "after"] as const).map((side) => (
						<details key={side}>
							<summary>
								{side === "before" ? "前文" : "后文"} ·{" "}
								{draft[side].edited
									? "用户已编辑"
									: draft[side].automatic
										? "自动摘录"
										: "尚未填写"}
								{draft[side].truncated ? " · 已截断" : ""}
								<span className="study-context-preview" lang="ja">
									{Array.from(draft[side].value).slice(0, 70).join("") ||
										"（空）"}
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
							<button type="button" onClick={() => edit(side, "")}>
								清空{side === "before" ? "前文" : "后文"}
							</button>
						</details>
					))}
					<details className="study-budget">
						<summary>本次语境预算</summary>
						{budget ? (
							<>
								<label className="study-toggle">
									<input
										type="checkbox"
										checked={budget.enabled}
										onChange={(event) =>
											setBudget({ ...budget, enabled: event.target.checked })
										}
									/>
									自动预装语境
								</label>
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
								<p className="study-hint">
									每项 0–100,000。调整仅用于本草稿；点击重新取文后生效。
								</p>
							</>
						) : (
							<p>
								{defaults.isPending
									? "正在读取默认预算…"
									: "默认预算读取失败，仍可手动填写或保存目标。"}
							</p>
						)}
					</details>
					{defaults.isError && (
						<div>
							<InlineError error={defaults.error} />
							<button type="button" onClick={() => void defaults.refetch()}>
								重试读取默认预算
							</button>
						</div>
					)}
					<button
						type="button"
						disabled={!budget || prefilling}
						onClick={() => budget && fill(budget, true)}
					>
						{prefilling ? "正在取文…" : "重新按预算取文"}
					</button>
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
				<footer>
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
						{save.isPending
							? "保存中…"
							: uncertain
								? "核实本次保存"
								: "新建学习片段"}
					</button>
				</footer>
			</div>
			{(confirmDiscard || blocker.state === "blocked") && (
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
							: "未保存的语境修改会丢失。"}
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
			)}
			{reuse && (
				<ConfirmDialog
					titleId={`${titleId}-reuse`}
					onClose={() => setReuse(null)}
				>
					<h2 id={`${titleId}-reuse`}>选用已有片段？</h2>
					<p>将保留已有片段的语境，本次未保存的修改会被放弃。</p>
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
			)}
		</aside>
	);
}
