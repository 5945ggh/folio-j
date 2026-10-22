import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef } from "react";
import { deleteMaterial } from "../materials/api";
import { ConfirmDialog, InlineError } from "../Shared";
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
	const deletion = useMutation({
		mutationFn: async () => {
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
			<p>你导入时选择的本地 EPUB 文件不会被删除。</p>
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
					disabled={deletion.isPending}
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
