import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { RequestError } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type AnalysisDetail,
	type AnalysisItem,
	type AnalysisRename,
	analysisKeys,
	getAnalysis,
	renameAnalysis,
} from "./api";
import { titleError } from "./editor";

export function AnalysisRenameDialog({
	analysis,
	onClose,
}: {
	analysis: Pick<AnalysisItem, "id" | "segment_id" | "title">;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const titleId = useId();
	const input = useRef<HTMLInputElement>(null);
	const submitting = useRef(false);
	const [draft, setDraft] = useState(analysis.title);
	const [expectedTitle, setExpectedTitle] = useState(analysis.title);
	const [reloaded, setReloaded] = useState(false);
	const title = draft.normalize("NFC").trim();
	const invalid = !title ? "名称不能为空白。" : titleError(draft);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	function refreshNames(item: AnalysisItem) {
		client.setQueriesData<AnalysisDetail>(
			{ queryKey: ["analysis", analysis.id] },
			(cached) =>
				cached && Date.parse(cached.updated_at) <= Date.parse(item.updated_at)
					? { ...cached, title: item.title, updated_at: item.updated_at }
					: cached,
		);
		for (const queryKey of [
			["analysis", analysis.id],
			analysisKeys.list(analysis.segment_id),
			analysisKeys.impact(analysis.id),
			["catalog"],
			["material-chapter-segments"],
		])
			void client.invalidateQueries({ queryKey });
	}
	const save = useMutation({
		mutationFn: (data: AnalysisRename) => renameAnalysis(analysis.id, data),
		onSuccess: (result) => {
			refreshNames(result);
			onClose();
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const reload = useMutation({
		mutationFn: () => getAnalysis(analysis.id),
		onSuccess: (result) => {
			setExpectedTitle(result.title);
			setReloaded(true);
			save.reset();
			refreshNames(result);
		},
	});
	const conflict =
		save.error instanceof RequestError && save.error.status === 409;
	const locked = save.isPending || reload.isPending;
	function dismiss() {
		if (!submitting.current && !locked) onClose();
	}
	return (
		<ConfirmDialog
			titleId={titleId}
			className="analysis-rename-dialog"
			onClose={dismiss}
		>
			<h2 id={titleId}>重命名讲解</h2>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (submitting.current || locked || invalid || conflict) return;
					submitting.current = true;
					save.mutate({ title, expected_title: expectedTitle });
				}}
			>
				<label className="field">
					名称
					<input
						ref={input}
						value={draft}
						disabled={locked}
						aria-invalid={Boolean(invalid)}
						onChange={(event) => {
							if (!submitting.current && !locked) setDraft(event.target.value);
						}}
					/>
				</label>
				{invalid && (
					<p className="inline-error" role="alert">
						{invalid}
					</p>
				)}
				{conflict && (
					<p role="alert">
						名称已被其他操作修改，草稿已保留。请读取最新名称，核对后再保存。
					</p>
				)}
				{reloaded && <p>当前名称：{expectedTitle}</p>}
				<InlineError
					error={conflict ? reload.error : (save.error ?? reload.error)}
				/>
				<div className="actions">
					{conflict && (
						<button
							type="button"
							className="button secondary"
							disabled={locked}
							onClick={() => reload.mutate()}
						>
							{reload.isPending ? "读取中…" : "读取最新名称"}
						</button>
					)}
					<button
						type="submit"
						className="button primary"
						disabled={locked || Boolean(invalid) || conflict}
					>
						{save.isPending ? "保存中…" : "保存名称"}
					</button>
					<button
						type="button"
						className="button secondary"
						disabled={locked}
						onClick={dismiss}
					>
						取消
					</button>
				</div>
			</form>
		</ConfirmDialog>
	);
}
