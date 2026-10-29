import assert from "node:assert/strict";
import test from "node:test";
import {
	browserScreenshotName,
	selectBrowserScenarios,
} from "./browser-test-plan.mjs";

const scenes = [
	[1280, 900, "?suite=reader-session"],
	[390, 900, "?suite=reader-session"],
	[1280, 900, "?suite=reader-session&direction=vertical-rl"],
	[320, 900, "?suite=chapter-records&theme=dark&detached"],
];

test("suite and canonical query filters retain every matching viewport", () => {
	assert.deepEqual(selectBrowserScenarios(scenes), scenes);
	assert.deepEqual(
		selectBrowserScenarios(scenes, {
			BROWSER_TEST_SUITE: "reader-session",
			BROWSER_TEST_QUERY: "?suite=reader-session",
		}),
		scenes.slice(0, 2),
	);
	assert.deepEqual(
		selectBrowserScenarios(scenes, {
			BROWSER_TEST_QUERY: "?detached=&theme=dark&suite=chapter-records",
		}),
		scenes.slice(3),
	);
});

test("unknown suites, unmatched queries and conflicting filters fail instead of running zero tests", () => {
	for (const environment of [
		{ BROWSER_TEST_SUITE: "misspelled" },
		{ BROWSER_TEST_QUERY: "?suite=reader-session&strict" },
		{
			BROWSER_TEST_SUITE: "reader-session",
			BROWSER_TEST_QUERY: "?suite=chapter-records&theme=dark&detached",
		},
	])
		assert.throws(
			() => selectBrowserScenarios(scenes, environment),
			/No browser scenarios match/,
		);
});

test("historical baseline stays scoped to reader measurements", () => {
	assert.equal(
		selectBrowserScenarios(scenes, {
			BROWSER_TEST_SUITE: "reader-session",
			BROWSER_TEST_BASELINE: "1",
		}).length,
		3,
	);
	assert.throws(
		() => selectBrowserScenarios(scenes, { BROWSER_TEST_BASELINE: "1" }),
		/only for reader-session/,
	);
});

test("screenshot names distinguish every scene flag and both viewport dimensions", () => {
	const queries = [
		"",
		"?theme=dark",
		"?direction=vertical-rl",
		"?reduced-motion",
		"?strict",
		"?performance",
		"?path=/materials/a&panel=left",
	];
	const names = queries.flatMap((query) =>
		[
			[1280, 900],
			[1280, 600],
			[390, 900],
		].map(([width, height]) => browserScreenshotName(width, height, query)),
	);
	assert.equal(new Set(names).size, names.length);
	assert.ok(names.every((name) => !name.includes("/")));
	assert.equal(
		browserScreenshotName(390, 900, "?theme=dark&suite=reader&capture"),
		browserScreenshotName(390, 900, "?suite=reader&theme=dark"),
	);
});
