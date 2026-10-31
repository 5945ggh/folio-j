import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NativeSelect } from "../NativeSelect";
import { dateLabel, InlineError } from "../Shared";
import {
	getRun,
	getRuns,
	type Model,
	type Provider,
	type Run,
	settingsKeys,
} from "./api";
import { historyFilters } from "./provider-presentation";
import "./provider-settings.css";

const labels: Record<string, string> = {
	queued: "排队中",
	running: "执行中",
	succeeded: "成功",
	failed: "失败",
	interrupted: "已中断",
};
const PAGE_SIZE = 10;

export function RunHistory({
	providerId,
	providers = [],
	models,
}: {
	providerId?: string;
	providers?: Provider[];
	models?: Model[];
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const [page, setPage] = useState(0);
	const [selectedProvider, setSelectedProvider] = useState("");
	const [selectedModel, setSelectedModel] = useState("");
	const [selectedStatus, setSelectedStatus] = useState<Run["status"] | "">("");
	const filters = historyFilters(
		providerId,
		selectedProvider,
		selectedModel,
		selectedStatus,
	);
	const modelOptions = (
		models ?? providers.flatMap((provider) => provider.models)
	).filter(
		(model) =>
			!filters.provider_id || model.provider_id === filters.provider_id,
	);
	const headingId = `runs-heading-${providerId ?? "all"}`;
	function changeFilter(update: () => void) {
		update();
		setPage(0);
		setSelected(null);
	}
	const runs = useQuery({
		queryKey: settingsKeys.runsPage(page, filters),
		queryFn: () => getRuns(PAGE_SIZE + 1, page * PAGE_SIZE, filters),
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
		<section
			className="settings-section provider-run-history"
			aria-labelledby={headingId}
		>
			<div className="provider-section-heading">
				<h2 id={headingId}>验证记录</h2>
				<button
					className="settings-button secondary"
					type="button"
					onClick={() => void runs.refetch()}
				>
					刷新记录
				</button>
			</div>
			<p className="settings-hint">
				验证由本地后台执行，离开页面后仍可回来查看。已删除服务和模型的历史记录会保留。
			</p>
			<div className="provider-run-filters">
				{!providerId && (
					<label className="settings-field">
						<span>服务</span>
						<NativeSelect
							value={selectedProvider}
							onChange={(event) =>
								changeFilter(() => {
									setSelectedProvider(event.target.value);
									setSelectedModel("");
								})
							}
						>
							<option value="">全部服务（含已删除）</option>
							{providers.map((provider) => (
								<option key={provider.id} value={provider.id}>
									{provider.name}
								</option>
							))}
							{selectedProvider &&
								!providers.some(
									(provider) => provider.id === selectedProvider,
								) && <option value={selectedProvider}>已删除服务</option>}
						</NativeSelect>
					</label>
				)}
				<label className="settings-field">
					<span>模型</span>
					<NativeSelect
						value={selectedModel}
						onChange={(event) =>
							changeFilter(() => setSelectedModel(event.target.value))
						}
					>
						<option value="">全部模型（含已删除）</option>
						{modelOptions.map((model) => (
							<option key={model.id} value={model.id}>
								{!filters.provider_id
									? `${providers.find((provider) => provider.id === model.provider_id)?.name ?? "服务"} / `
									: ""}
								{model.model_id}
							</option>
						))}
						{selectedModel &&
							!modelOptions.some((model) => model.id === selectedModel) && (
								<option value={selectedModel}>已删除模型登记</option>
							)}
					</NativeSelect>
				</label>
				<label className="settings-field">
					<span>状态</span>
					<NativeSelect
						value={selectedStatus}
						onChange={(event) =>
							changeFilter(() =>
								setSelectedStatus(event.target.value as Run["status"] | ""),
							)
						}
					>
						<option value="">全部状态</option>
						{Object.entries(labels).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</NativeSelect>
				</label>
			</div>
			{runs.isPending ? (
				<p className="loading">正在加载验证记录…</p>
			) : runs.isError ? (
				<>
					<InlineError error={runs.error} />
					<button
						className="settings-button secondary"
						type="button"
						onClick={() => void runs.refetch()}
					>
						重试
					</button>
					{page > 0 && (
						<button
							className="settings-button secondary"
							type="button"
							onClick={() => changePage(page - 1)}
						>
							返回上一页
						</button>
					)}
				</>
			) : visibleRuns.length === 0 ? (
				<div className="empty-state">
					<p>
						{Object.keys(filters).length > 0
							? "没有符合筛选条件的验证记录。"
							: "还没有验证记录。"}
					</p>
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
						className="settings-button secondary"
						type="button"
						disabled={page === 0}
						onClick={() => changePage(page - 1)}
					>
						上一页
					</button>
					<span aria-live="polite">第 {page + 1} 页</span>
					<button
						className="settings-button secondary"
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
					className="settings-button secondary"
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
					<h4>{item.status === "interrupted" ? "中断原因" : "失败原因"}</h4>
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
