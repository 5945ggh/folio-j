import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef } from "react";
import { deleteMaterial } from "../materials/api";
import { ConfirmDialog, InlineError } from "../Shared";
import { getTranslationDeleteImpact } from "../translation/api";
import type { Book } from "./api";
import { refreshAfterBookDeletion } from "./book-deletion";

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
	const impact = useQuery({
		queryKey: ["translation-delete-impact", book.id],
		queryFn: () => getTranslationDeleteImpact(book.id),
		staleTime: 0,
	});
	const deletion = useMutation({
		mutationFn: async () => {
			const fresh = await impact.refetch();
			if (!fresh.data || fresh.isError)
				throw fresh.error ?? new Error("无法核对翻译删除影响。");
			if (JSON.stringify(fresh.data) !== JSON.stringify(impact.data))
				throw new Error("翻译记录刚刚变化，请核对当前影响后重新确认删除。");
			await deleteMaterial(book.id);
			await refreshAfterBookDeletion(client, book.id, book.source_id);
		},
		onSuccess: close,
		onSettled: () => {
			submitting.current = false;
		},
	});
	function cancel() {
		if (!submitting.current) close();
	}
	return (
		<ConfirmDialog
			titleId={titleId}
			onClose={cancel}
			restoreFocusId={restoreFocusId}
		>
			<h2 id={titleId}>删除书籍「{book.title}」？</h2>
			<p>将清除应用保存的原书和阅读数据，无法再打开阅读。此操作无法撤销。</p>
			<p>
				已保存的片段、讲解、讨论等学习积累会保留。所属来源和同来源的其他材料不受影响。
			</p>
			<p>书签及备注会保留并随本书隐藏，重新导入后不会自动关联。</p>
			<p>你导入时选择的本地 EPUB 文件不会被删除。</p>
			{impact.isPending && <p role="status">正在核对翻译记录…</p>}
			<InlineError error={impact.error} />
			{impact.isError && (
				<button type="button" onClick={() => void impact.refetch()}>
					重试核对翻译
				</button>
			)}
			{impact.data && (
				<p>
					将隐藏 {impact.data.hidden_result_count} 份未关联学习片段的译文，保留{" "}
					{impact.data.retained_result_count} 份已关联译文快照；停止{" "}
					{impact.data.active_task_count} 个进行中的翻译任务。
				</p>
			)}
			<InlineError error={deletion.error} />
			<div className="actions">
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
					disabled={deletion.isPending || !impact.data || impact.isFetching}
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
