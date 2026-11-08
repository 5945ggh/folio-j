import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { historicalReaderBaseline } from "./reader-baseline.mjs";

const script = fileURLToPath(new URL("./measure-reader.mjs", import.meta.url));

test("measurement runs the browser module from an unrelated working directory", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "reader-entry-test-"));
	try {
		const result = spawnSync(process.execPath, [script], {
			cwd: directory,
			env: {
				...process.env,
				CHROME_BIN: path.join(directory, "missing-chrome"),
				READER_MEASUREMENT_RUNS: "1",
				BROWSER_TEST_QUERY: "?suite=reader-session",
				// The current mode must override an inherited historical setting.
				BROWSER_TEST_BASELINE: "1",
			},
			encoding: "utf8",
			timeout: 10000,
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Chrome\/Edge unavailable/);
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
		assert.doesNotMatch(result.stdout, /Historical reader baseline/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("measurement preserves exact scenario filtering before browser launch", () => {
	const result = spawnSync(process.execPath, [script], {
		env: {
			...process.env,
			READER_MEASUREMENT_RUNS: "1",
			BROWSER_TEST_QUERY: "?suite=reader-session&unknown-scenario",
		},
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		/No browser scenarios match suite=reader-session/,
	);
});

test("invalid repeat counts fail before starting the runner", () => {
	const result = spawnSync(process.execPath, [script], {
		env: { ...process.env, READER_MEASUREMENT_RUNS: "0" },
		encoding: "utf8",
		timeout: 10000,
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /READER_MEASUREMENT_RUNS must be 1\.\.10/);
});

test("a checkout without historical Git objects reports the baseline prerequisite", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "reader-baseline-test-"));
	try {
		assert.throws(
			() => historicalReaderBaseline(directory),
			/Historical reader baseline unavailable: requires Git object ae44fc8925ab5733e0f8162e6b3981cff1088975:frontend\/src\/materials\/MaterialReader.tsx/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
