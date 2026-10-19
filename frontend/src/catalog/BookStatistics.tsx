import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { InlineError } from "../Shared";
import { type BookStatisticsData, getBookStatistics } from "./api";
import {
	analysisConfigurationLabel,
	bookStatisticsKey,
	coverageGeometry,
	coveragePlot,
	statisticCount,
	statisticPercent,
} from "./statistics";
import "./statistics.css";

function CoverageChart({ data }: { data: BookStatisticsData }) {
	const chartId = useId();
	const lexical = data.lexical;
	const geometry = lexical
		? coverageGeometry(lexical.coverage, lexical.distinct_word_count)
		: null;
	const { width, height, left, right, top, bottom } = coveragePlot;
	return (
		<figure className="book-statistics-chart">
			<figcaption>高频词累计覆盖</figcaption>
			{geometry && lexical ? (
				<>
					<p className="book-statistics-note">词次覆盖率</p>
					<svg
						viewBox={`0 0 ${width} ${height}`}
						role="img"
						aria-labelledby={`${chartId}-title ${chartId}-description`}
					>
						<title id={`${chartId}-title`}>本书高频词的词次覆盖曲线</title>
						<desc id={`${chartId}-description`}>
							横轴为本书最高频的前 k 种词，纵轴为其累计词次占比。全部
							{statisticCount(lexical.distinct_word_count)} 种词计入
							{statisticCount(lexical.counted_token_count)} 个词次。
						</desc>
						{[0, 0.5, 1].map((coverage) => {
							const y = bottom - coverage * (bottom - top);
							return (
								<g key={coverage}>
									<line
										x1={left}
										x2={right}
										y1={y}
										y2={y}
										className="statistics-chart-grid"
									/>
									<text
										x={left - 10}
										y={y + 4}
										textAnchor="end"
										className="statistics-chart-axis"
									>
										{statisticPercent(coverage)}
									</text>
								</g>
							);
						})}
						<path d={geometry.area} className="statistics-chart-area" />
						<path d={geometry.line} className="statistics-chart-line" />
						<circle
							cx={geometry.end.x}
							cy={geometry.end.y}
							r={3}
							fill="#4778ad"
						/>
						{geometry.xTicks.map((count) => (
							<text
								key={count}
								x={
									left + (count / lexical.distinct_word_count) * (right - left)
								}
								y={bottom + 22}
								textAnchor={
									count === 0
										? "start"
										: count === lexical.distinct_word_count
											? "end"
											: "middle"
								}
								className="statistics-chart-axis"
							>
								{statisticCount(count)}
							</text>
						))}
					</svg>
					<p className="book-statistics-axis-label">本书最高频的前 k 种词</p>
				</>
			) : (
				<p className="book-statistics-state">
					{lexical
						? "没有可计入的词次，暂无覆盖曲线。"
						: "词法统计尚未准备，暂无覆盖曲线。"}
				</p>
			)}
			<dl className="book-statistics-thresholds">
				{[0.8, 0.9, 0.95].map((target) => {
					const count = lexical?.thresholds.find(
						(item) => item.target === target,
					)?.vocabulary_size;
					return (
						<div key={target}>
							<dt>覆盖 {statisticPercent(target)}</dt>
							<dd>
								{statisticCount(count)}
								{count !== null && count !== undefined ? " 种词" : ""}
							</dd>
						</div>
					);
				})}
			</dl>
		</figure>
	);
}

function StatisticsContent({ data }: { data: BookStatisticsData }) {
	const lexical = data.lexical;
	const metrics = [
		["词次（按词典形统计）", statisticCount(lexical?.counted_token_count)],
		["词种", statisticCount(lexical?.distinct_word_count)],
		["单次词种", statisticCount(lexical?.singleton_word_count)],
		["单次词种比例", statisticPercent(lexical?.singleton_word_ratio)],
		["字符数", statisticCount(data.text.character_count)],
		["不同汉字数", statisticCount(data.text.unique_kanji_count)],
		["单次汉字数", statisticCount(data.text.singleton_kanji_count)],
	];
	return (
		<>
			<dl className="book-statistics-metrics">
				{metrics.map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			{!lexical && (
				<p className="book-statistics-state" role="status">
					正文统计可用；词法统计尚未准备。
				</p>
			)}
			<CoverageChart data={data} />
			<details className="book-statistics-rules">
				<summary>统计范围与计算口径</summary>
				<p>
					范围为当前材料版本的全部可提取正文，包括目录、后记，共{" "}
					{statisticCount(data.text.resource_count)}{" "}
					份正文资源。同一资源在阅读顺序中重复出现只计一次；不同资源即使文字相同也分别计入。
				</p>
				<p>
					词次保留助词、助动词、数字及未登录词，排除空白、标点和零跨度记录。词种按词典形归并，缺失时回退表层；单次词种只出现一次，H/V
					表示其占全部词种的比例。
				</p>
				<p>
					覆盖率是本书高频词的累计词次占比，不表示理解率或掌握率。曲线采用简化显示，阈值按完整词频计算。
				</p>
				<p>
					字符数为 NFC 正文的 Unicode
					码点数，含空白和标点，不含注音文字。汉字统计采用 Unicode
					统一及兼容汉字，保留兼容字形差异，不计入々、〇。单次汉字表示在范围内只出现一次。
				</p>
				{lexical && (
					<p>{analysisConfigurationLabel(data.analysis_configuration)}</p>
				)}
				<p>
					正文规则 {data.text.rule_version.replace("text-statistics-", "")} ·
					Unicode {data.text.unicode_version}
					{lexical
						? ` · 词法规则 ${lexical.rule_version.replace("lexical-statistics-", "")}`
						: ""}
					。结果对应本次读取的材料版本与分词结果；重新进入详情或刷新统计可读取当前结果。
				</p>
			</details>
		</>
	);
}

export function BookStatistics({
	materialId,
	versionId,
	generationId,
}: {
	materialId: string;
	versionId: string;
	generationId?: string;
}) {
	const statistics = useQuery({
		queryKey: bookStatisticsKey(materialId, versionId, generationId),
		queryFn: ({ signal }) =>
			getBookStatistics(materialId, versionId, generationId, signal),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
	});
	return (
		<section
			className="book-statistics"
			aria-label="正文统计"
			aria-busy={statistics.isFetching}
		>
			<div className="book-statistics-heading">
				<div>
					<h2>正文统计</h2>
					<p>全部可提取正文 · 按资源去重</p>
				</div>
				<button
					type="button"
					className="book-details-action"
					disabled={statistics.isFetching}
					onClick={() => void statistics.refetch()}
				>
					{statistics.isFetching ? "读取中…" : "刷新统计"}
				</button>
			</div>
			{statistics.isPending ? (
				<p className="book-statistics-state" role="status">
					正在读取正文统计…
				</p>
			) : statistics.isError ? (
				<div className="book-statistics-error">
					<InlineError error={statistics.error} />
					<button
						type="button"
						className="book-details-action"
						disabled={statistics.isFetching}
						onClick={() => void statistics.refetch()}
					>
						重试统计
					</button>
				</div>
			) : (
				<StatisticsContent data={statistics.data} />
			)}
		</section>
	);
}
