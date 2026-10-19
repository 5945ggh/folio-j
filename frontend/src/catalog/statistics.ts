import type { components } from "../api/schema";

type Statistics = components["schemas"]["MaterialStatisticsResponse"];
type CoveragePoint = components["schemas"]["CoveragePoint"];

export const bookStatisticsKey = (
	materialId: string,
	versionId: string,
	generationId?: string,
) =>
	[
		"book-statistics",
		materialId,
		versionId,
		generationId ?? "current",
	] as const;

export function matchesStatistics(
	value: Statistics,
	materialId: string,
	versionId: string,
	generationId?: string,
): boolean {
	return (
		value.material_id === materialId &&
		value.version_id === versionId &&
		(generationId === undefined || value.generation_id === generationId)
	);
}

export const coveragePlot = {
	width: 640,
	height: 228,
	left: 48,
	right: 620,
	top: 16,
	bottom: 178,
} as const;

export function coverageGeometry(
	points: readonly CoveragePoint[],
	vocabularySize: number,
) {
	if (points.length === 0 || vocabularySize <= 0) return null;
	const { left, right, top, bottom } = coveragePlot;
	const coordinates = points.map((point) => ({
		x: left + (point.vocabulary_size / vocabularySize) * (right - left),
		y: bottom - point.coverage * (bottom - top),
	}));
	const first = coordinates[0];
	const last = coordinates.at(-1);
	if (!first || !last) return null;
	const line = coordinates
		.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
		.join(" ");
	return {
		line,
		area: `${line} L${last.x},${bottom} L${first.x},${bottom} Z`,
		end: last,
		xTicks: [...new Set([0, Math.ceil(vocabularySize / 2), vocabularySize])],
	};
}

export function statisticCount(value: number | null | undefined): string {
	return value === null || value === undefined
		? "—"
		: value.toLocaleString("zh-CN");
}

export function statisticPercent(value: number | null | undefined): string {
	return value === null || value === undefined
		? "—"
		: value.toLocaleString("zh-CN", {
				style: "percent",
				maximumFractionDigits: 1,
			});
}

export function analysisConfigurationLabel(
	configuration: string | null,
): string {
	if (!configuration) return "分词版本信息不可用";
	try {
		const parsed: unknown = JSON.parse(configuration);
		if (!parsed || typeof parsed !== "object") return "分词版本信息不可用";
		const field = (name: string) => {
			const value = (parsed as Record<string, unknown>)[name];
			return typeof value === "string" && value.length <= 40 ? value : null;
		};
		const mode = field("mode");
		if (field("analyzer") !== "SudachiPy" || !mode || !/^[ABC]$/.test(mode))
			return "分词版本信息不可用";
		return [
			`Sudachi ${mode}`,
			field("analyzer_version") && `分析器 ${field("analyzer_version")}`,
			field("dictionary_version") && `词典 ${field("dictionary_version")}`,
		]
			.filter(Boolean)
			.join(" · ");
	} catch {
		return "分词版本信息不可用";
	}
}
