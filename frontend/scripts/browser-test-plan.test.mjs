import assert from "node:assert/strict";
import test from "node:test";
import { runBrowserSuite } from "../browser-tests/harness.ts";
import {
	readerAnkiProbeResponse,
	readerBaseResponse,
} from "../browser-tests/reader-base-fixture.ts";
import {
	assertBrowserResult,
	browserScenarioUrl,
	browserScreenshotName,
	selectBrowserScenarios,
} from "./browser-test-plan.mjs";

const scenes = [
	[1280, 900, "?suite=reader-session"],
	[390, 900, "?suite=reader-session"],
	[1280, 900, "?suite=reader-session&direction=vertical-rl"],
	[320, 900, "?suite=chapter-records&theme=dark&detached"],
];

test("reader fixture rejects wrong methods, books and chapters instead of returning empty success", async () => {
	const book = { id: "book", version_id: "v1", source_id: "source" };
	const probe = readerAnkiProbeResponse("POST", "/api/anki/probe");
	assert.equal(probe.status, 502);
	assert.deepEqual(await probe.json(), { detail: "未连接 Anki" });
	for (const [method, path] of [
		["GET", "/api/anki/probe"],
		["POST", "/api/anki/export"],
		["POST", "/api/anki/probe/other"],
	]) {
		assert.equal(readerAnkiProbeResponse(method, path), undefined);
		assert.throws(
			() => readerBaseResponse(method, path, book, []),
			/Unmocked reader request/,
		);
	}
	const respond = (method, path) =>
		readerBaseResponse(method, `/api/materials/${path}`, book, [
			{ id: "chapter" },
		]);
	assert.equal(
		(await respond("POST", "book/readings/prepare").json()).material_id,
		"book",
	);
	for (const [method, path] of [
		["GET", "book/readings/prepare"],
		["POST", "other/readings/prepare"],
		["GET", "other/chapters/chapter/segments"],
		["GET", "book/chapters/missing/translations"],
		["POST", "book/chapters/chapter/segments"],
		["GET", "book/opened"],
		["POST", "book/usage"],
	])
		assert.throws(() => respond(method, path), /Unmocked reader request/);
});

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

test("default and named screenshots keep the test page path and scene parameters", () => {
	const base = "http://localhost/browser-tests/";
	for (const query of ["", "?suite=reader-session&strict"]) {
		const url = browserScenarioUrl(base, query, {
			BROWSER_TEST_SCREENSHOT_DIR: "screenshots",
		});
		assert.equal(url.pathname, "/browser-tests/");
		assert.deepEqual(
			[...url.searchParams],
			[...new URLSearchParams(query), ["capture", ""]],
		);
	}
});

test("only an absent suite runs the default checks, in order", async () => {
	const calls = [];
	const record = (name) => async () => {
		calls.push(name);
		return name;
	};
	const defaults = ["workbench", "cards", "context", "materials", "bookmarks"];
	const named = new Map([["theme", record("theme")]]);
	const run = (query) =>
		runBrowserSuite(
			new URLSearchParams(query).get("suite"),
			named,
			defaults.map(record),
		);
	assert.deepEqual(await run("?capture"), defaults);
	assert.deepEqual(await run("?suite=theme"), ["theme"]);
	await assert.rejects(run("?suite=typo"), /Unknown browser suite: "typo"/);
	await assert.rejects(run("?suite="), /Unknown browser suite: ""/);
	assert.deepEqual(calls, [...defaults, "theme"]);
});

test("uncaught page exceptions override PASS and retain their CDP details", () => {
	const passed = { status: "passed", text: "PASS\nchecks completed" };
	const details = {
		text: "Uncaught",
		exception: { description: "Error: before PASS" },
		stackTrace: {
			callFrames: [{ functionName: "throwBeforePass", lineNumber: 42 }],
		},
	};
	assert.throws(
		() => assertBrowserResult("600x900", passed, [details]),
		(error) => {
			assert.match(error.message, /Uncaught page exception\(s\) in 600x900/);
			assert.ok(error.message.includes(JSON.stringify([details], null, 2)));
			return true;
		},
	);
	assert.doesNotThrow(() => assertBrowserResult("600x900", passed, []));
});
