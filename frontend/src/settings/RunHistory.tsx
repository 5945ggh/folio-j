import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { dateLabel, InlineError } from "../Shared";
import { getRun, getRuns, settingsKeys } from "./api";

const labels: Record<string, string> = {
	queued: "排队中",
	running: "执行中",
	succeeded: "成功",
	failed: "失败",
	interrupted: "已中断",
};
const PAGE_SIZE = 10;

export function RunHistory() {
	const [selected, setSelected] = useState<string | null>(null);
	const [page, setPage] = useState(0);
	const runs = useQuery({
		queryKey: settingsKeys.runsPage(page),
		queryFn: () => getRuns(PAGE_SIZE + 1, page * PAGE_SIZE),
		refetchInterval: (query) =>
			query.state.data?.some(
				(run) => run.status === "queued" || run.status === "running",
			)
				? 1500
				: false,
	});
	const visibleRuns = runs.data?.slice(0, PAGE_SIZE) ?? [];
	const hasNextPage = (runs.data?.length ?? 0) > PAGE_SIZE;
	const changePage = (nextPage: number) => {
		setSelected(null);
		setPage(nextPage);
	};
	return (
		<section className="settings-section" aria-labelledby="runs-heading">
			<div className="section-heading">
				<h2 id="runs-heading">最近验证</h2>
				<button
					className="button secondary"
					type="button"
					onClick={() => void runs.refetch()}
				>
					刷新记录
				</button>
			</div>
			<p className="settings-hint">
				验证由本地后台执行。离开页面或刷新后，可以在这里继续查看状态和结果。
			</p>
			{runs.isPending ? (
				<p className="loading">正在加载验证记录…</p>
			) : runs.isError ? (
				<>
					<InlineError error={runs.error} />
					<button
						className="button secondary"
						type="button"
						onClick={() => void runs.refetch()}
					>
						重试
					</button>
					{page > 0 && (
						<button
							className="button secondary"
							type="button"
							onClick={() => changePage(page - 1)}
						>
							返回上一页
						</button>
					)}
				</>
			) : visibleRuns.length === 0 ? (
				<div className="empty-state">
					<p>还没有验证记录。</p>
				</div>
			) : (
				<div className="settings-list">
					{visibleRuns.map((run) => (
						<div className="run-entry" key={run.id}>
							<button
								className="run-summary"
								type="button"
								aria-expanded={selected === run.id}
								onClick={() => setSelected(selected === run.id ? null : run.id)}
							>
								<span>
									<strong>
										{run.provider_name} / {run.model_id}
									</strong>
									<small>
										{run.stream ? "流式文本" : "普通文本"} ·{" "}
										{dateLabel(run.created_at)}
									</small>
								</span>
								<span className={`run-status ${run.status}`}>
									{labels[run.status] ?? run.status}
								</span>
							</button>
							{selected === run.id && <RunDetail id={run.id} />}
						</div>
					))}
				</div>
			)}
			{runs.isSuccess && (page > 0 || hasNextPage) && (
				<nav className="run-pagination" aria-label="验证记录分页">
					<button
						className="button secondary"
						type="button"
						disabled={page === 0}
						onClick={() => changePage(page - 1)}
					>
						上一页
					</button>
					<span aria-live="polite">第 {page + 1} 页</span>
					<button
						className="button secondary"
						type="button"
						disabled={!hasNextPage}
						onClick={() => changePage(page + 1)}
					>
						下一页
					</button>
				</nav>
			)}
		</section>
	);
}

export function RunDetail({ id }: { id: string }) {
	const run = useQuery({
		queryKey: settingsKeys.run(id),
		queryFn: () => getRun(id),
		refetchInterval: (query) =>
			query.state.data?.status === "queued" ||
			query.state.data?.status === "running"
				? 1000
				: false,
	});
	if (run.isPending) return <p className="loading">正在读取详情…</p>;
	if (run.isError)
		return (
			<div className="run-detail">
				<InlineError error={run.error} />
				<button
					className="button secondary"
					type="button"
					onClick={() => void run.refetch()}
				>
					重试
				</button>
			</div>
		);
	const item = run.data;
	return (
		<div className="run-detail">
			<p>
				{item.stream ? "流式文本" : "普通文本"} · 协议：{item.protocol} · Prompt
				版本：{item.prompt_version} · 状态：
				{labels[item.status] ?? item.status}
			</p>
			{item.output_text && (
				<div>
					<h4>正文输出</h4>
					<pre>{item.output_text}</pre>
				</div>
			)}
			{item.error && (
				<div>
					<h4>失败原因</h4>
					<p role="alert">{item.error}</p>
				</div>
			)}
			{item.usage && (
				<p>
					用量：输入 {item.usage.input_tokens ?? "未知"}、输出{" "}
					{item.usage.output_tokens ?? "未知"}、合计{" "}
					{item.usage.total_tokens ?? "未知"} token
				</p>
			)}
			{!item.output_text && !item.error && (
				<p>尚无正文输出；任务状态会自动更新。</p>
			)}
		</div>
	);
}
