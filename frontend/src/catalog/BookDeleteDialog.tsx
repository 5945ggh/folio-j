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
				throw new Error("无法核对目标书籍，请重新读取删除影响。");
			const result = await deleteMaterial(book.id, deleteLearningContent);
			if (deleteLearningContent && result?.material_id !== book.id)
				throw new Error("删除回执与目标书籍不一致，请重试核实。");
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
					[impact.data.segment_count, "个学习片段"],
					[impact.data.analysis_count, "份讲解"],
					[impact.data.thread_count, "个讨论"],
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
						"个讨论任务",
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
			<h2 id={titleId}>删除书籍「{book.title}」？</h2>
			<p className="book-delete-intro">
				将删除应用内的原书和阅读数据，此操作无法撤销。
			</p>
			{impact.isPending && <p role="status">正在读取删除影响…</p>}
			<InlineError error={impact.error} />
			{impact.isError && (
				<button type="button" onClick={() => void impact.refetch()}>
					重试读取删除影响
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
							"本书暂无关联的学习片段。"
						)}
					</p>
					{deleteLearningContent && counts && (
						<p>包括从本书保存的片段、人工讲解、全部修订和后续讨论。</p>
					)}
					{(impact.data.hidden_result_count > 0 ||
						impact.data.retained_result_count > 0) && (
						<p>
							{[
								impact.data.hidden_result_count > 0 &&
									`${impact.data.hidden_result_count} 份译文随本书隐藏`,
								impact.data.retained_result_count > 0 &&
									`${impact.data.retained_result_count} 份仍可从保留的片段查看`,
							]
								.filter(Boolean)
								.join("，")}
							。
						</p>
					)}
					{!deleteLearningContent && impact.data.active_job_count > 0 && (
						<p>{impact.data.active_job_count} 个讨论任务继续运行。</p>
					)}
					{stoppedTasks && <p>将停止 {stoppedTasks}。</p>}
				</div>
			)}
			<div className="book-delete-notes">
				<p>来源、其他书籍及手动录入的片段保留。</p>
				<p>书签和备注随书籍隐藏，重导后不自动关联。本地 EPUB 文件保留。</p>
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
					同时删除学习积累
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
					{deletion.isPending ? "正在删除…" : "删除书籍"}
				</button>
			</div>
		</ConfirmDialog>
	);
}
