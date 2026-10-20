import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { queries, type Segment } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type AnalysisDetail,
	analysisKeys,
	createManualAnalysis,
	createManualAnalysisRevision,
} from "./api";
import {
	type AnalysisDraft,
	type AnalysisEditorBase,
	analysisDraftChanged,
	analysisFailure,
	type ManualAnalysisRequest,
	prepareAnalysisRequest,
	requestAfterFailure,
	sourceChanged,
	sourceError,
	titleError,
} from "./editor";
import "./editor.css";

export function AnalysisEditor({
	segment,
	initial,
	refreshError,
	onSaved,
	onClose,
	restoreFocusId,
}: {
	segment: Segment;
	initial?: AnalysisDetail;
	refreshError?: Error | null;
	onSaved: (result: AnalysisDetail) => void;
	onClose: () => void;
	restoreFocusId?: string;
}) {
	const client = useQueryClient();
	const titleId = useId();
	const [base] = useState<AnalysisEditorBase>(() => ({
		segment: {
			id: segment.id,
			source_id: segment.source_id,
			text_sha256: segment.text_sha256,
			text_locked_at: segment.text_locked_at,
		},
		analysis: initial
			? {
					id: initial.id,
					segment_id: initial.segment_id,
					revision_id: initial.revision_id,
					current_revision_id: initial.current_revision_id,
					source_md: initial.source_md,
				}
			: undefined,
	}));
	const [draft, setDraft] = useState<AnalysisDraft>(() => ({
		sourceMd: initial?.source_md ?? "",
		title: "",
		origin: "manual",
	}));
	const [uncertain, setUncertain] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [localError, setLocalError] = useState<Error | null>(null);
	const pendingRequest = useRef<ManualAnalysisRequest | null>(null);
	const submitting = useRef(false);
	const completed = useRef(false);
	const blockerRef = useRef<ReturnType<typeof useBlocker> | null>(null);
	const dirty = analysisDraftChanged(base, draft);
	const invalidSource = sourceError(draft.sourceMd);
	const invalidTitle = base.analysis ? null : titleError(draft.title);
	const save = useMutation({
		mutationFn: (request: ManualAnalysisRequest) =>
			request.kind === "create"
				? createManualAnalysis(request.segmentId, request.body)
				: createManualAnalysisRevision(request.analysisId, request.body),
		onSuccess: (result) => {
			completed.current = true;
			pendingRequest.current = null;
			void client.invalidateQueries({ queryKey: ["analysis", result.id] });
			client.setQueryData(
				analysisKeys.detail(result.id, result.revision_id),
				result,
			);
			void client.invalidateQueries({
				queryKey: analysisKeys.list(base.segment.id),
			});
			void client.invalidateQueries({
				queryKey: queries.segment(base.segment.id),
			});
			void client.invalidateQueries({
				queryKey: queries.source(base.segment.source_id),
			});
			void client.invalidateQueries({
				queryKey: queries.segments(base.segment.source_id),
			});
			void client.invalidateQueries({ queryKey: ["catalog"] });
			if (blockerRef.current?.state === "blocked") blockerRef.current.reset();
			onSaved(result);
		},
		onError: (error, request) => {
			pendingRequest.current = requestAfterFailure(request, error);
			setUncertain(Boolean(pendingRequest.current));
			const failure = analysisFailure(error);
			if (
				failure === "stale_revision" ||
				failure === "stale_text" ||
				failure === "not_found"
			) {
				void client.invalidateQueries({
					queryKey: queries.segment(base.segment.id),
				});
				if (request.kind === "revision")
					void client.invalidateQueries({
						queryKey: ["analysis", request.analysisId],
					});
			}
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const failure = save.error ? analysisFailure(save.error) : null;
	const conflict =
		failure === "stale_text" ||
		failure === "stale_revision" ||
		failure === "idempotency_conflict" ||
		failure === "not_found";
	const locked = save.isPending || uncertain;
	const blocker = useBlocker(
		() =>
			!completed.current &&
			(dirty || uncertain || submitting.current || save.isPending),
	);
	blockerRef.current = blocker;
	useBeforeUnload(
		useCallback(
			(event) => {
				if (
					!completed.current &&
					(dirty || uncertain || submitting.current || save.isPending)
				) {
					event.preventDefault();
					event.returnValue = "";
				}
			},
			[dirty, uncertain, save.isPending],
		),
	);
	function updateDraft(patch: Partial<AnalysisDraft>) {
		if (submitting.current || pendingRequest.current || locked) return;
		setDraft((current) => ({ ...current, ...patch }));
		setLocalError(null);
	}
	function dismiss() {
		if (submitting.current || save.isPending) return;
		if (dirty || uncertain) setConfirmDiscard(true);
		else onClose();
	}
	function continueEditing() {
		if (submitting.current || save.isPending) return;
		if (blocker.state === "blocked") blocker.reset();
		setConfirmDiscard(false);
	}
	function discard() {
		if (submitting.current || save.isPending) return;
		completed.current = true;
		if (blocker.state === "blocked") blocker.proceed();
		onClose();
	}
	const canSave =
		uncertain ||
		(!invalidSource &&
			!invalidTitle &&
			!conflict &&
			sourceChanged(base, draft.sourceMd));
	return (
		<ConfirmDialog
			titleId={titleId}
			onClose={dismiss}
			className="analysis-editor-dialog"
			restoreFocusId={restoreFocusId}
		>
			<h2 id={titleId}>{base.analysis ? "编辑讲解全文" : "新建讲解"}</h2>
			{refreshError && (
				<div className="analysis-editor-notice" role="alert">
					片段重新读取失败，当前草稿与最初原文依据已保留。保存时仍会校验该依据。
				</div>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (submitting.current || save.isPending || !canSave) return;
					try {
						const request = prepareAnalysisRequest(
							pendingRequest.current,
							base,
							draft,
							() => crypto.randomUUID(),
						);
						pendingRequest.current = request;
						submitting.current = true;
						setLocalError(null);
						save.mutate(request);
					} catch (error) {
						setLocalError(
							error instanceof Error ? error : new Error("无法提交讲解。"),
						);
					}
				}}
			>
				{!base.analysis && (
					<div className="analysis-editor-fields">
						<label className="field">
							讲解来源
							<select
								value={draft.origin}
								disabled={locked}
								onChange={(event) =>
									updateDraft({
										origin:
											event.target.value === "import" ? "import" : "manual",
									})
								}
							>
								<option value="manual">手写讲解</option>
								<option value="import">外部 Markdown</option>
							</select>
						</label>
						<label className="field">
							标题（可选）
							<input
								value={draft.title}
								disabled={locked}
								onChange={(event) => updateDraft({ title: event.target.value })}
								aria-invalid={Boolean(invalidTitle)}
								placeholder="留空时根据正文生成标题"
							/>
						</label>
					</div>
				)}
				{invalidTitle && (
					<p className="inline-error" role="alert">
						{invalidTitle}
					</p>
				)}
				<label className="field analysis-editor-source">
					Markdown 正文
					<textarea
						rows={16}
						value={draft.sourceMd}
						readOnly={locked}
						onChange={(event) => updateDraft({ sourceMd: event.target.value })}
						aria-invalid={Boolean(invalidSource && draft.sourceMd)}
						spellCheck={false}
						placeholder="输入讲解或粘贴外部 Markdown，不要求二级标题。"
					/>
				</label>
				{invalidSource && draft.sourceMd && (
					<p className="inline-error" role="alert">
						{invalidSource}
					</p>
				)}
				{!base.segment.text_locked_at && (
					<p className="analysis-editor-note">
						首次保存讲解后，当前片段的目标原文将固定，不能再修改；附带资料仍可维护。
					</p>
				)}
				{base.analysis && (
					<p className="analysis-editor-note">
						保存会产生新版本；历史版本与引用保留。
					</p>
				)}
				{uncertain && (
					<div className="analysis-editor-notice" role="status">
						上次保存结果尚未确认，输入已暂时固定。请核实本次保存，避免重复创建。
					</div>
				)}
				{conflict && (
					<div className="analysis-editor-notice" role="alert">
						{failure === "stale_text"
							? "目标原文已变化。"
							: failure === "stale_revision"
								? "讲解已被其他操作更新。"
								: failure === "not_found"
									? "片段或讲解已不可用。"
									: "本次保存身份对应的内容不一致。"}
						草稿已保留；可复制需要的内容，取消后重新打开当前资料。
					</div>
				)}
				<InlineError error={localError ?? save.error} />
				<div className="actions">
					<button
						type="submit"
						className="button primary"
						disabled={save.isPending || !canSave}
					>
						{save.isPending
							? uncertain
								? "正在核实…"
								: "正在保存…"
							: uncertain
								? "核实本次保存"
								: "保存讲解"}
					</button>
					<button
						type="button"
						className="button secondary"
						disabled={save.isPending}
						data-dialog-cancel
						onClick={dismiss}
					>
						取消
					</button>
				</div>
			</form>
			{(confirmDiscard || blocker.state === "blocked") && (
				<ConfirmDialog titleId={`${titleId}-discard`} onClose={continueEditing}>
					<h2 id={`${titleId}-discard`}>放弃本次编辑？</h2>
					<p>
						{save.isPending
							? "正在保存或核实，请稍候。"
							: uncertain
								? "保存结果尚未确认，离开后讲解仍可能已经保存。可先继续核实；关闭页面后不保留本次草稿与核实请求。"
								: "当前讲解草稿尚未保存。"}
					</p>
					<div className="actions">
						<button
							type="button"
							className="button secondary"
							disabled={save.isPending}
							data-dialog-cancel
							onClick={continueEditing}
						>
							继续编辑
						</button>
						<button
							type="button"
							className="button primary"
							disabled={save.isPending}
							onClick={discard}
						>
							放弃并离开
						</button>
					</div>
				</ConfirmDialog>
			)}
		</ConfirmDialog>
	);
}
