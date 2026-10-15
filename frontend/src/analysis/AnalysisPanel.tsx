import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type Job, stopJob } from "../chat/api";
import { generationResult, isTerminalJob, mergeJob } from "../chat/discussion";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	analysisKeys,
	deleteAnalysis,
	getAnalysis,
	getAnalysisImpact,
	listAnalyses,
} from "./api";
import { Markdown } from "./Markdown";
import { readingAnalysis } from "./state";

const pageSize = 100;

export function AnalysisPanel({
	segmentId,
	selectedId,
	revisionId,
	onSelect,
	onGenerate,
	onDiscuss,
	job,
}: {
	segmentId: string;
	selectedId: string | null;
	revisionId: string | null;
	onSelect: (analysisId: string | null, revisionId: string | null) => void;
	onGenerate: () => void;
	onDiscuss?: () => void;
	job?: Job;
}) {
	const client = useQueryClient();
	const [deleting, setDeleting] = useState(false);
	const selectedRef = useRef(selectedId);
	useEffect(() => {
		selectedRef.current = selectedId;
	}, [selectedId]);

	const analyses = useInfiniteQuery({
		queryKey: analysisKeys.list(segmentId),
		initialPageParam: 0,
		queryFn: ({ pageParam }) => listAnalyses(segmentId, pageParam),
		getNextPageParam: (last, all) =>
			last.length === pageSize ? all.length * pageSize : undefined,
	});
	const items = analyses.data?.pages.flat() ?? [];
	const effectiveId = selectedId;
	const detail = useQuery({
		queryKey: analysisKeys.detail(effectiveId ?? "", revisionId),
		queryFn: () => getAnalysis(effectiveId ?? "", revisionId),
		enabled: Boolean(effectiveId),
	});
	const document = readingAnalysis(
		detail.data,
		segmentId,
		selectedId,
		detail.isError,
	);
	const impact = useQuery({
		queryKey: analysisKeys.impact(effectiveId ?? ""),
		queryFn: () => getAnalysisImpact(effectiveId ?? ""),
		enabled: deleting && Boolean(document),
		staleTime: 0,
	});
	const remove = useMutation({
		mutationFn: async () => {
			if (!document) throw new Error("请先打开当前片段的讲解。");
			const fresh = await impact.refetch();
			if (fresh.isError || !fresh.data)
				throw fresh.error ?? new Error("无法核对删除影响，请重试。");
			if (
				fresh.data.revision_count !== impact.data?.revision_count ||
				fresh.data.section_count !== impact.data?.section_count ||
				fresh.data.occurrence_count !== impact.data?.occurrence_count
			)
				throw new Error("删除影响刚刚变化，请核对后再确认。");
			await deleteAnalysis(document.id);
			return document.id;
		},
		onSuccess: (deletedId) => {
			setDeleting(false);
			client.removeQueries({ queryKey: ["analysis", deletedId] });
			client.removeQueries({ queryKey: analysisKeys.impact(deletedId) });
			if (selectedRef.current === deletedId) onSelect(null, null);
			void client.invalidateQueries({ queryKey: analysisKeys.list(segmentId) });
			void client.invalidateQueries({ queryKey: ["catalog"] });
		},
	});
	const stop = useMutation({
		mutationFn: (jobId: string) => stopJob(jobId),
		onSuccess: (updated) => mergeJob(client, updated),
	});

	return (
		<div className="analysis-panel">
			<div className="analysis-toolbar">
				<div className="analysis-picker-wrap">
					{effectiveId ? (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={() => {
								setDeleting(false);
								onSelect(null, null);
							}}
						>
							← 返回讲解列表
						</button>
					) : (
						<h2>讲解列表</h2>
					)}
				</div>
				<div className="analysis-toolbar-actions">
					{document && (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={() => {
								remove.reset();
								setDeleting(true);
							}}
						>
							删除讲解
						</button>
					)}
					{document && onDiscuss && (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={onDiscuss}
						>
							展开讨论
						</button>
					)}
					<button
						type="button"
						className="button primary"
						disabled={Boolean(job && !isTerminalJob(job))}
						onClick={onGenerate}
					>
						生成总体讲解
					</button>
				</div>
			</div>
			{!effectiveId && items.length > 0 && (
				<section className="analysis-list" aria-label="讲解列表">
					{items.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => {
								onSelect(item.id, null);
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
			{!effectiveId && analyses.isPending && (
				<p className="loading">正在加载讲解…</p>
			)}
			{!effectiveId && analyses.isError && (
				<>
					<InlineError error={analyses.error} />
					<button
						type="button"
						className="analysis-quiet-button"
						onClick={() => void analyses.refetch()}
					>
						重试加载讲解列表
					</button>
				</>
			)}
			{!effectiveId && analyses.hasNextPage && (
				<button
					type="button"
					className="analysis-quiet-button"
					disabled={analyses.isFetchingNextPage}
					onClick={() => void analyses.fetchNextPage()}
				>
					{analyses.isFetchingNextPage ? "加载中…" : "加载更多讲解"}
				</button>
			)}
			{job && !isTerminalJob(job) && (
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
			{!effectiveId && items.length === 0 && analyses.isSuccess && !job && (
				<div className="analysis-empty">
					<h2>从这段原文开始</h2>
					<p>生成一份可独立阅读的总体讲解，也可以在对话中提出专题问题。</p>
				</div>
			)}
			{detail.isPending && effectiveId && (
				<p className="loading">正在打开讲解…</p>
			)}
			{effectiveId && detail.isError && (
				<>
					<InlineError error={detail.error} />
					<button
						type="button"
						className="analysis-quiet-button"
						onClick={() => void detail.refetch()}
					>
						重试打开讲解
					</button>
				</>
			)}
			{effectiveId && detail.isSuccess && detail.data && !document && (
				<p className="inline-error" role="alert">
					这份讲解不属于当前片段，请返回讲解列表选择。
				</p>
			)}
			{document && (
				<article className="analysis-document">
					<div className="analysis-document-meta">
						<span>已保存讲解</span>
						<span title={document.revision_id}>
							{document.revision_id === document.current_revision_id
								? "当前版本"
								: "历史版本"}{" "}
							· 修订 {document.revision_id.slice(-6)}
						</span>
					</div>
					{document.revision_id !== document.current_revision_id && (
						<button
							type="button"
							className="analysis-quiet-button"
							onClick={() => onSelect(document.id, null)}
						>
							查看当前版本
						</button>
					)}
					{!/^\s*#\s+\S/m.test(document.source_md.split("\n", 2)[0] ?? "") && (
						<h2>{document.title}</h2>
					)}
					{document.warnings.length > 0 && (
						<details className="analysis-warnings">
							<summary>格式提醒（{document.warnings.length}）</summary>
							<ul>
								{document.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</details>
					)}
					{document.sections.length > 0 && (
						<nav className="analysis-toc" aria-label="讲解目录">
							{document.sections
								.filter((section) => section.kind === "section")
								.map((section) => (
									<a key={section.id} href={`#analysis-section-${section.id}`}>
										{section.display_no && `${section.display_no} · `}
										{section.title ?? "未命名段落"}
									</a>
								))}
						</nav>
					)}
					{document.sections.map((section) => (
						<section
							key={section.id}
							id={`analysis-section-${section.id}`}
							className="analysis-section"
						>
							<Markdown text={section.raw} />
						</section>
					))}
					{document.sections.length === 0 && (
						<Markdown text={document.source_md} />
					)}
				</article>
			)}
			{deleting && document && (
				<ConfirmDialog
					titleId="delete-analysis-title"
					onClose={() => setDeleting(false)}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id="delete-analysis-title">删除这份讲解？</h2>
					{impact.isPending ? (
						<p>正在核对关联范围…</p>
					) : impact.isError ? (
						<>
							<InlineError error={impact.error} />
							<button
								type="button"
								className="analysis-quiet-button"
								onClick={() => void impact.refetch()}
							>
								重新核对删除影响
							</button>
						</>
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
