import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { deleteMaterial, getMaterialDeleteImpact } from "../materials/api";
import { ConfirmDialog, InlineError } from "../Shared";
import type { Book } from "./api";
import { refreshAfterBookDeletion } from "./book-deletion";
import "./book-delete-dialog.css";

export function BookDeleteDialog({
	book,
	close,
	restoreFocusId,
}: {
	book: Book;
	close: () => void;
	restoreFocusId: string;
}) {
	const titleId = useId();
	const client = useQueryClient();
	const submitting = useRef(false);
	const [deleteLearningContent, setDeleteLearningContent] = useState(false);
	const impact = useQuery({
		queryKey: ["material-delete-impact", book.id, deleteLearningContent],
		queryFn: ({ signal }) =>
			getMaterialDeleteImpact(book.id, deleteLearningContent, signal),
		staleTime: 0,
	});
	const deletion = useMutation({
		mutationFn: async () => {
			if (!impact.data || impact.data.material_id !== book.id)
				throw new Error("无法确认要删除的书籍，请刷新后重试。");
			const result = await deleteMaterial(book.id, deleteLearningContent);
			if (deleteLearningContent && result?.material_id !== book.id)
				throw new Error("删除结果异常，请刷新页面确认。");
			await refreshAfterBookDeletion(
				client,
				book.id,
				book.source_id,
				result?.deleted_segment_ids,
			);
		},
		onSuccess: close,
		onSettled: () => {
			submitting.current = false;
		},
	});
	function cancel() {
		if (!submitting.current) close();
	}
	const counts = impact.data
		? (
				[
					[impact.data.segment_count, "个片段"],
					[impact.data.analysis_count, "份讲解"],
					[impact.data.thread_count, "段对话"],
					[impact.data.message_count, "条消息"],
				] as const
			)
				.filter(([count]) => count > 0)
				.map(([count, label]) => `${count} ${label}`)
				.join("、")
		: "";
	const stoppedTasks = impact.data
		? (
				[
					[
						deleteLearningContent ? impact.data.active_job_count : 0,
						"个对话任务",
					],
					[impact.data.active_task_count, "个翻译任务"],
				] as const
			)
				.filter(([count]) => count > 0)
				.map(([count, label]) => `${count} ${label}`)
				.join("、")
		: "";
	return (
		<ConfirmDialog
			className="book-delete-dialog"
			titleId={titleId}
			onClose={cancel}
			restoreFocusId={restoreFocusId}
		>
			<h2 id={titleId}>删除《{book.title}》？</h2>
			<p className="book-delete-intro">
				将移除应用内的电子书副本和阅读记录，此操作无法撤销。
			</p>
			{impact.isPending && <p role="status">正在统计关联内容…</p>}
			<InlineError error={impact.error} />
			{impact.isError && (
				<button type="button" onClick={() => void impact.refetch()}>
					重试
				</button>
			)}
			{impact.data && (
				<div className="book-delete-impact">
					<p className="book-delete-summary">
						{counts ? (
							<>
								<strong>{deleteLearningContent ? "将删除" : "将保留"}</strong>{" "}
								{counts}
							</>
						) : (
							"本书暂无关联的片段。"
						)}
					</p>
					{deleteLearningContent && counts && (
						<p>包括从本书摘录的片段、保存的讲解（含历史版本）和对话。</p>
					)}
					{(impact.data.hidden_result_count > 0 ||
						impact.data.retained_result_count > 0) && (
						<p>
							{[
								impact.data.hidden_result_count > 0 &&
									`${impact.data.hidden_result_count} 份译文将无法继续查看`,
								impact.data.retained_result_count > 0 &&
									`${impact.data.retained_result_count} 份仍可在保留的片段中查看`,
							]
								.filter(Boolean)
								.join("，")}
							。
						</p>
					)}
					{!deleteLearningContent && impact.data.active_job_count > 0 && (
						<p>将保留 {impact.data.active_job_count} 个对话任务。</p>
					)}
					{stoppedTasks && <p>将停止 {stoppedTasks}。</p>}
				</div>
			)}
			<div className="book-delete-notes">
				<p>所属来源、其他书籍及手动录入的片段不受影响。</p>
				<p>
					本书的书签和备注会一并清除，重新导入后不会恢复。本地 EPUB
					文件不受影响。
				</p>
			</div>
			<InlineError error={deletion.error} />
			<div className="book-delete-option">
				<label>
					<input
						type="checkbox"
						checked={deleteLearningContent}
						disabled={deletion.isPending}
						onChange={(event) => {
							if (submitting.current) return;
							setDeleteLearningContent(event.target.checked);
							deletion.reset();
						}}
					/>
					同时删除本书关联的片段、讲解和对话
				</label>
			</div>
			<div className="actions book-delete-actions">
				<button
					type="button"
					className="button secondary"
					data-dialog-cancel
					disabled={deletion.isPending}
					onClick={cancel}
				>
					取消
				</button>
				<button
					type="button"
					className="button danger"
					disabled={
						deletion.isPending ||
						!impact.data ||
						impact.isFetching ||
						impact.isError
					}
					onClick={() => {
						if (submitting.current) return;
						submitting.current = true;
						deletion.mutate();
					}}
				>
					{deletion.isPending ? "删除中…" : "删除书籍"}
				</button>
			</div>
		</ConfirmDialog>
	);
}
