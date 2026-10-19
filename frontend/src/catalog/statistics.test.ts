import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../api/schema";
import {
	analysisConfigurationLabel,
	bookStatisticsKey,
	coverageGeometry,
	coveragePlot,
	matchesStatistics,
	statisticCount,
	statisticPercent,
} from "./statistics.ts";

const response: components["schemas"]["MaterialStatisticsResponse"] = {
	material_id: "book-a",
	version_id: "version-a",
	generation_id: "generation-a",
	scope: "unique_resources",
	text: {
		rule_version: "text-statistics-v1",
		unicode_version: "16.0.0",
		resource_count: 1,
		character_count: 0,
		unique_kanji_count: 0,
		singleton_kanji_count: 0,
	},
	lexical: null,
	analysis_configuration: null,
};

test("statistics query and response identity isolate books, versions and requested generations", () => {
	assert.deepEqual(bookStatisticsKey("book-a", "version-a"), [
		"book-statistics",
		"book-a",
		"version-a",
		"current",
	]);
	assert.notDeepEqual(
		bookStatisticsKey("book-a", "version-a"),
		bookStatisticsKey("book-b", "version-a"),
	);
	assert.notDeepEqual(
		bookStatisticsKey("book-a", "version-a"),
		bookStatisticsKey("book-a", "version-b"),
	);
	assert.notDeepEqual(
		bookStatisticsKey("book-a", "version-a"),
		bookStatisticsKey("book-a", "version-a", "generation-a"),
	);
	assert.equal(matchesStatistics(response, "book-a", "version-a"), true);
	assert.equal(matchesStatistics(response, "book-b", "version-a"), false);
	assert.equal(matchesStatistics(response, "book-a", "version-b"), false);
	assert.equal(
		matchesStatistics(response, "book-a", "version-a", "generation-a"),
		true,
	);
	assert.equal(
		matchesStatistics(response, "book-a", "version-a", "generation-b"),
		false,
	);
	assert.equal(
		matchesStatistics(
			{ ...response, generation_id: null },
			"book-a",
			"version-a",
		),
		true,
	);
	assert.equal(
		matchesStatistics(
			{ ...response, generation_id: null },
			"book-a",
			"version-a",
			"generation-a",
		),
		false,
	);
});

test("coverage positions use actual vocabulary sizes rather than sampled point indices", () => {
	const plot = coverageGeometry(
		[
			{ vocabulary_size: 0, coverage: 0 },
			{ vocabulary_size: 80, coverage: 0.9 },
			{ vocabulary_size: 100, coverage: 1 },
		],
		100,
	);
	assert.ok(plot);
	const { left, right, top, bottom } = coveragePlot;
	assert.equal(
		plot.line,
		`M${left},${bottom} L${left + (right - left) * 0.8},${bottom - (bottom - top) * 0.9} L${right},${top}`,
	);
	assert.equal(
		plot.area,
		`${plot.line} L${right},${bottom} L${left},${bottom} Z`,
	);
	assert.deepEqual(plot.xTicks, [0, 50, 100]);
});

test("empty coverage has no curve and a single word has distinct axis ticks", () => {
	assert.equal(coverageGeometry([], 0), null);
	assert.equal(
		coverageGeometry([{ vocabulary_size: 0, coverage: 0 }], 0),
		null,
	);
	assert.deepEqual(
		coverageGeometry([{ vocabulary_size: 1, coverage: 1 }], 1)?.xTicks,
		[0, 1],
	);
	assert.deepEqual(
		coverageGeometry([{ vocabulary_size: 1, coverage: 1 }], 1)?.end,
		{ x: coveragePlot.right, y: coveragePlot.top },
	);
	assert.equal(statisticCount(null), "—");
	assert.equal(statisticCount(undefined), "—");
	assert.equal(statisticCount(0), "0");
	assert.equal(statisticPercent(null), "—");
	assert.equal(statisticPercent(0), "0%");
	assert.equal(statisticPercent(0.125), "12.5%");
});

test("rule summary displays selected analyzer versions without raw configuration JSON", () => {
	assert.equal(
		analysisConfigurationLabel(
			JSON.stringify({
				analyzer: "SudachiPy",
				mode: "A",
				analyzer_version: "0.6.11",
				dictionary_version: "20260723",
				internal: "hidden",
			}),
		),
		"Sudachi A · 分析器 0.6.11 · 词典 20260723",
	);
	for (const value of [
		null,
		"invalid",
		"null",
		"[]",
		"{}",
		'{"analyzer":"unknown"}',
	]) {
		assert.equal(analysisConfigurationLabel(value), "分词版本信息不可用");
	}
});
