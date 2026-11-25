import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api } from "../api/client";
import {
	errorMessage,
	getSegmentDeleteImpact,
	queries,
	type Segment,
} from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import { refreshAfterSegmentDeletion } from "./deletion";

export function SegmentDeleteDialog({
	segment,
	close,
	onDeleted,
	restoreFocusId,
}: {
	segment: Segment;
	close: () => void;
	onDeleted?: () => void;
	restoreFocusId?: string;
}) {
	const client = useQueryClient();
	const submitting = useRef(false);
	const impact = useQuery({
		queryKey: queries.segmentImpact(segment.id),
		queryFn: () => getSegmentDeleteImpact(segment.id),
		staleTime: 0,
		retry: false,
	});
	const shownImpact = impact.data;
	const remove = useMutation({
		mutationFn: async () => {
			if (!shownImpact || shownImpact.segment_id !== segment.id)
				throw new Error("未能确认要删除的片段，请刷新后重试。");
			const { error, response } = await api.DELETE(
				"/api/segments/{segment_id}",
				{ params: { path: { segment_id: segment.id } } },
			);
			if (error || !response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: async () => {
			await refreshAfterSegmentDeletion(client, segment);
			close();
			onDeleted?.();
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const guardedClose = () => {
		if (!submitting.current) close();
	};
	return (
		<ConfirmDialog
			titleId="delete-segment-title"
			restoreFocusId={restoreFocusId}
			onClose={guardedClose}
		>
			<p className="eyebrow">删除确认</p>
			<h2 id="delete-segment-title">删除这个片段？</h2>
			<blockquote lang="ja">
				{segment.text.slice(0, 140)}
				{segment.text.length > 140 ? "…" : ""}
			</blockquote>
			{shownImpact ? (
				<p>
					将一并删除 {shownImpact.analysis_count} 份讲解（含历史版本）、
					{shownImpact.thread_count} 段对话和 {shownImpact.message_count} 条消息
					{shownImpact.active_job_count > 0
						? `，并停止 ${shownImpact.active_job_count} 个对话任务`
						: ""}
					。所属来源、原书及其他片段不受影响。此操作无法撤销。
				</p>
			) : impact.isPending ? (
				<p role="status">正在统计关联内容…</p>
			) : null}
			{impact.isError && (
				<>
					<InlineError error={impact.error} />
					<button
						type="button"
						disabled={remove.isPending}
						onClick={() => void impact.refetch()}
					>
						重试
					</button>
				</>
			)}
			<InlineError error={remove.error} />
			<div className="actions">
				<button
					className="button danger"
					type="button"
					disabled={!impact.isSuccess || impact.isFetching || remove.isPending}
					onClick={() => {
						if (submitting.current) return;
						submitting.current = true;
						remove.mutate();
					}}
				>
					{remove.isPending ? "删除中…" : "确认删除"}
				</button>
				<button
					className="button secondary"
					type="button"
					data-dialog-cancel
					disabled={remove.isPending}
					onClick={guardedClose}
				>
					取消
				</button>
			</div>
		</ConfirmDialog>
	);
}
