import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { chatKeys, type Job, stopJob } from "../chat/api";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	analysisKeys,
	deleteAnalysis,
	getAnalysis,
	getAnalysisImpact,
	listAnalyses,
} from "./api";
import { Markdown } from "./Markdown";
import { generationResult } from "./state";

const pageSize = 100;

export function AnalysisPanel({
	segmentId,
	selectedId,
	revisionId,
	onSelect,
	onGenerate,
	job,
}: {
	segmentId: string;
	selectedId: string | null;
	revisionId: string | null;
	onSelect: (analysisId: string, revisionId: string | null) => void;
	onGenerate: () => void;
	job?: Job;
}) {
	const client = useQueryClient();
	const [deleting, setDeleting] = useState(false);
	const [listOpen, setListOpen] = useState(false);
	const analyses = useInfiniteQuery({
		queryKey: analysisKeys.list(segmentId),
		initialPageParam: 0,
		queryFn: ({ pageParam }) => listAnalyses(segmentId, pageParam),
		getNextPageParam: (last, all) =>
			last.length === pageSize ? all.length * pageSize : undefined,
	});
	const items = analyses.data?.pages.flat() ?? [];
	const effectiveId = selectedId ?? items[0]?.id ?? null;
	const detail = useQuery({
		queryKey: analysisKeys.detail(effectiveId ?? "", revisionId),
		queryFn: () => getAnalysis(effectiveId ?? "", revisionId),
		enabled: Boolean(effectiveId),
	});
	const impact = useQuery({
		queryKey: analysisKeys.impact(effectiveId ?? ""),
		queryFn: () => getAnalysisImpact(effectiveId ?? ""),
		enabled: deleting && Boolean(effectiveId),
		staleTime: 0,
	});
	const remove = useMutation({
		mutationFn: async () => {
			if (!effectiveId) return;
			const fresh = await impact.refetch();
			if (fresh.isError || !fresh.data)
				throw fresh.error ?? new Error("无法核对删除影响，请重试。");
			if (
				fresh.data.revision_count !== impact.data?.revision_count ||
				fresh.data.section_count !== impact.data?.section_count ||
				fresh.data.occurrence_count !== impact.data?.occurrence_count
			)
				throw new Error("删除影响刚刚变化，请核对后再确认。");
			await deleteAnalysis(effectiveId);
		},
		onSuccess: () => {
			setDeleting(false);
			onSelect("", null);
			void client.invalidateQueries({ queryKey: analysisKeys.list(segmentId) });
		},
	});
	const stop = useMutation({
		mutationFn: (jobId: string) => stopJob(jobId),
		onSuccess: (updated) =>
			client.setQueryData(chatKeys.job(updated.id), updated),
	});
	useEffect(() => {
		if (!selectedId || analyses.isPending) return;
		if (items.some((item) => item.id === selectedId)) return;
		if (analyses.hasNextPage) return;
		onSelect("", null);
	}, [selectedId, analyses.isPending, analyses.hasNextPage, items, onSelect]);

	return (
		<div className="analysis-panel">
			<div className="analysis-toolbar">
				<div className="analysis-picker-wrap">
					<label htmlFor="analysis-picker">讲解</label>
					<select
						id="analysis-picker"
						value={effectiveId ?? ""}
						onChange={(event) => onSelect(event.target.value, null)}
					>
						{items.length === 0 && <option value="">还没有讲解</option>}
						{items.map((item) => (
							<option key={item.id} value={item.id}>
								{item.title}
							</option>
						))}
					</select>
					{items.length > 0 && (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={() => setListOpen(!listOpen)}
						>
							{listOpen ? "收起讲解列表" : "查看讲解列表"}
						</button>
					)}
				</div>
				<div className="analysis-toolbar-actions">
					{effectiveId && (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={() => setDeleting(true)}
						>
							删除讲解
						</button>
					)}
					<button
						type="button"
						className="button primary"
						disabled={Boolean(
							job &&
								!["succeeded", "failed", "interrupted"].includes(job.status),
						)}
						onClick={onGenerate}
					>
						生成总体讲解
					</button>
				</div>
			</div>
			{listOpen && items.length > 0 && (
				<section className="analysis-list" aria-label="讲解列表">
					{items.map((item) => (
						<button
							key={item.id}
							type="button"
							aria-current={item.id === effectiveId ? "true" : undefined}
							onClick={() => {
								onSelect(item.id, null);
								setListOpen(false);
							}}
						>
							<strong>{item.title}</strong>
							<small>
								正文摘录：{item.excerpt.slice(0, 90)}
								{item.excerpt.length > 90 ? "…" : ""}
							</small>
						</button>
					))}
				</section>
			)}
			{analyses.isPending && <p className="loading">正在加载讲解…</p>}
			{analyses.isError && <InlineError error={analyses.error} />}
			{analyses.hasNextPage && (
				<button
					type="button"
					className="analysis-quiet-button"
					disabled={analyses.isFetchingNextPage}
					onClick={() => void analyses.fetchNextPage()}
				>
					{analyses.isFetchingNextPage ? "加载中…" : "加载更多讲解"}
				</button>
			)}
			{job && !["succeeded", "failed", "interrupted"].includes(job.status) && (
				<section className="analysis-draft" aria-label="尚未保存的讲解">
					<div className="analysis-draft-header">
						<span>
							{job.status === "stopping" ? "正在停止" : "生成中"} · 尚未保存
						</span>
						<button
							type="button"
							className="analysis-quiet-button"
							disabled={stop.isPending || job.status === "stopping"}
							onClick={() => stop.mutate(job.id)}
						>
							停止
						</button>
					</div>
					<InlineError error={stop.error} />
					{job.assistant_message.content && (
						<pre>{job.assistant_message.content}</pre>
					)}
					{!job.assistant_message.content && (
						<p>正在准备讲解内容，完成后会自动保存并打开。</p>
					)}
				</section>
			)}
			{job && generationResult(job) === "saved_with_unfinished_reply" && (
				<div className="analysis-generation-result" role="status">
					讲解已保存，后续回答未完成。
					{job.artifacts?.map((artifact) => (
						<button
							key={`${artifact.analysis_id}-${artifact.revision_id}`}
							type="button"
							className="analysis-quiet-button"
							title={`讲解 ${artifact.analysis_id} · 修订 ${artifact.revision_id}`}
							onClick={() =>
								onSelect(artifact.analysis_id, artifact.revision_id)
							}
						>
							打开已保存讲解 · 修订 {artifact.revision_id.slice(-6)}
						</button>
					))}
				</div>
			)}
			{job && generationResult(job) === "not_saved" && (
				<p className="analysis-generation-result" role="status">
					{job.status === "failed" ? "讲解生成失败" : "讲解生成已停止"}
					；尚未保存新讲解。{job.error || "可重新发起。"}
				</p>
			)}
			{!effectiveId && analyses.isSuccess && !job && (
				<div className="analysis-empty">
					<h2>从这段原文开始</h2>
					<p>生成一份可独立阅读的总体讲解，也可以在对话中提出专题问题。</p>
				</div>
			)}
			{detail.isPending && effectiveId && (
				<p className="loading">正在打开讲解…</p>
			)}
			{detail.isError && <InlineError error={detail.error} />}
			{detail.data && (
				<article className="analysis-document">
					<div className="analysis-document-meta">
						<span>已保存讲解</span>
						<span title={detail.data.revision_id}>
							修订 {detail.data.revision_id.slice(-6)}
							{detail.data.revision_id !== detail.data.current_revision_id &&
								" · 历史版本"}
						</span>
					</div>
					{detail.data.revision_id !== detail.data.current_revision_id && (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={() => onSelect(detail.data.id, null)}
						>
							查看当前版本
						</button>
					)}
					{!/^\s*#\s+\S/m.test(
						detail.data.source_md.split("\n", 2)[0] ?? "",
					) && <h2>{detail.data.title}</h2>}
					{detail.data.warnings.length > 0 && (
						<details className="analysis-warnings">
							<summary>格式提醒（{detail.data.warnings.length}）</summary>
							<ul>
								{detail.data.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</details>
					)}
					{detail.data.sections.length > 0 && (
						<nav className="analysis-toc" aria-label="讲解目录">
							{detail.data.sections
								.filter((section) => section.kind === "section")
								.map((section) => (
									<a key={section.id} href={`#analysis-section-${section.id}`}>
										{section.display_no && `${section.display_no} · `}
										{section.title ?? "未命名段落"}
									</a>
								))}
						</nav>
					)}
					{detail.data.sections.map((section) => (
						<section
							key={section.id}
							id={`analysis-section-${section.id}`}
							className="analysis-section"
						>
							<Markdown text={section.raw} />
						</section>
					))}
					{detail.data.sections.length === 0 && (
						<Markdown text={detail.data.source_md} />
					)}
				</article>
			)}
			{deleting && effectiveId && (
				<ConfirmDialog
					titleId="delete-analysis-title"
					onClose={() => setDeleting(false)}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id="delete-analysis-title">删除这份讲解？</h2>
					{impact.isPending ? (
						<p>正在核对关联范围…</p>
					) : impact.isError ? (
						<InlineError error={impact.error} />
					) : (
						<p>
							“{impact.data.title}”的 {impact.data.revision_count} 个修订、
							{impact.data.section_count} 个讲解块及{" "}
							{impact.data.occurrence_count}{" "}
							个关联学习条目会受到影响。片段和对话保留。删除后无法从页面恢复。
						</p>
					)}
					<InlineError error={remove.error} />
					<div className="actions">
						<button
							type="button"
							className="button danger"
							disabled={!impact.isSuccess || remove.isPending}
							onClick={() => remove.mutate()}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							type="button"
							className="button secondary"
							disabled={remove.isPending}
							onClick={() => setDeleting(false)}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
		</div>
	);
}
