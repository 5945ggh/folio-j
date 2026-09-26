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

export function RunHistory() {
	const [selected, setSelected] = useState<string | null>(null);
	const runs = useQuery({
		queryKey: settingsKeys.runs,
		queryFn: getRuns,
		refetchInterval: (query) =>
			query.state.data?.some(
				(run) => run.status === "queued" || run.status === "running",
			)
				? 1500
				: false,
	});
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
				</>
			) : runs.data.length === 0 ? (
				<div className="empty-state">
					<p>还没有验证记录。</p>
				</div>
			) : (
				<div className="settings-list">
					{runs.data.map((run) => (
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
		</section>
	);
}

function RunDetail({ id }: { id: string }) {
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
				协议：{item.protocol} · Prompt 版本：{item.prompt_version} · 状态：
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
