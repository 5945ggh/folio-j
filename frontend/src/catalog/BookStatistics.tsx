import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Link, useLocation } from "react-router";
import { returnDestination, returnState } from "../navigation";
import { InlineError } from "../Shared";
import type { BookStatisticsData } from "./api";
import {
	analysisConfigurationLabel,
	coverageGeometry,
	coveragePlot,
	statisticCount,
	statisticPercent,
} from "./statistics";
import { materialStatisticsOptions } from "./statistics-query";
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
						<title id={`${chartId}-title`}>本书高频词累计覆盖曲线</title>
						<desc id={`${chartId}-description`}>
							横轴为本书高频词数量，纵轴为其累计出现占比。共{" "}
							{statisticCount(lexical.distinct_word_count)} 种词，合计{" "}
							{statisticCount(lexical.counted_token_count)} 词次。
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
					<p className="book-statistics-axis-label">
						高频词数量（按词频从高到低）
					</p>
				</>
			) : (
				<p className="book-statistics-state">
					{lexical
						? "本书暂无可统计的词汇，无法生成覆盖曲线。"
						: "词汇统计尚未就绪，暂无法显示覆盖曲线。"}
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
		["总词数", statisticCount(lexical?.counted_token_count)],
		["词汇量（按词典形）", statisticCount(lexical?.distinct_word_count)],
		["仅出现一次的词", statisticCount(lexical?.singleton_word_count)],
		["单次词占比", statisticPercent(lexical?.singleton_word_ratio)],
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
					词汇统计尚未就绪，打开阅读后将自动分析。
				</p>
			)}
			<CoverageChart data={data} />
			<details className="book-statistics-rules">
				<summary>统计说明</summary>
				<p>
					统计范围涵盖本书全部正文（含目录与后记，共{" "}
					{statisticCount(data.text.resource_count)} 个正文文件），不含注音。
				</p>
				<p>
					词汇按词典形合并统计（无词典形时按原文计），包含助词、助动词与数字，排除空白和标点。覆盖率反映高频词在全书总词数中的占比。
				</p>
				<p>字符数包含空白与标点；汉字统计不含叠字号「々」与「〇」。</p>
			</details>
			{lexical && (
				<details className="book-statistics-rules">
					<summary>技术信息</summary>
					<p>
						分词引擎：{analysisConfigurationLabel(data.analysis_configuration)}
					</p>
				</details>
			)}
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
	const location = useLocation();
	const statistics = useQuery(
		materialStatisticsOptions(materialId, versionId, generationId),
	);
	const back = returnDestination(location.state, {
		to: "/materials",
		label: "素材库",
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
				</div>
				<Link
					className="book-details-action"
					to={`/materials/${materialId}/vocabulary`}
					state={returnState(
						{ to: location.pathname, label: "书籍详情" },
						back,
					)}
				>
					查看词汇 <span aria-hidden="true">→</span>
				</Link>
			</div>
			{statistics.isPending ? (
				<p className="book-statistics-state" role="status">
					正在加载正文统计…
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
						重新加载
					</button>
				</div>
			) : (
				<StatisticsContent data={statistics.data} />
			)}
		</section>
	);
}
