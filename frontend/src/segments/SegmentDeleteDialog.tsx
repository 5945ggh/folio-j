import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api/client";
import {
	errorMessage,
	getSegmentDeleteImpact,
	queries,
	type Segment,
} from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	refreshAfterSegmentDeletion,
	type SegmentDeleteImpact,
	sameSegmentDeleteImpact,
} from "./deletion";

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
	const [confirmed, setConfirmed] = useState<SegmentDeleteImpact | null>(null);
	const impact = useQuery({
		queryKey: queries.segmentImpact(segment.id),
		queryFn: () => getSegmentDeleteImpact(segment.id),
		staleTime: 0,
		retry: false,
	});
	// Keep the displayed scope stable while the pre-submit check refreshes the cache.
	const shownImpact = confirmed ?? impact.data;
	const remove = useMutation({
		mutationFn: async () => {
			if (!shownImpact || shownImpact.segment_id !== segment.id)
				throw new Error("无法核对目标片段，请重新读取删除影响范围。");
			setConfirmed(shownImpact);
			const fresh = await impact.refetch();
			if (fresh.isError || !fresh.data)
				throw fresh.error ?? new Error("无法核对删除范围，请重试。");
			setConfirmed(fresh.data);
			if (!sameSegmentDeleteImpact(shownImpact, fresh.data))
				throw new Error("删除范围刚刚变化，请核对最新影响后再次确认。");
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
					这会一并删除 {shownImpact.analysis_count} 份讲解（包含全部修订）、{" "}
					{shownImpact.thread_count} 条讨论和 {shownImpact.message_count}{" "}
					条消息。
					{shownImpact.active_job_count > 0 &&
						`其中 ${shownImpact.active_job_count} 个进行中的任务会被中断。`}
					来源、原材料及其他片段保留。删除后无法从页面恢复。
				</p>
			) : impact.isPending ? (
				<p role="status">正在读取当前影响范围…</p>
			) : null}
			{impact.isError && (
				<>
					<InlineError error={impact.error} />
					<button
						type="button"
						disabled={remove.isPending}
						onClick={() => void impact.refetch()}
					>
						重试读取影响范围
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
