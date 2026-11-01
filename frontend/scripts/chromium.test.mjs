import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findChromium } from "./chromium.mjs";

test("browser override preserves paths containing spaces and Unicode", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "folio-browser-"));
	try {
		const executable = path.join(directory, "测试 Chrome.exe");
		await writeFile(executable, "fixture");
		assert.equal(await findChromium({ CHROME_BIN: executable }), executable);
		await assert.rejects(
			findChromium({ CHROME_BIN: path.join(directory, "missing.exe") }),
			/set CHROME_BIN/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
