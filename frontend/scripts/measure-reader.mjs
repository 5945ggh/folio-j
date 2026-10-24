import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Use the normal offline browser runner and its real-time Chrome DOM clock.
// --baseline restores only these modules in Vite's memory, leaving disk untouched.
const frontend = fileURLToPath(new URL("..", import.meta.url));
const baseline = process.argv.includes("--baseline");
const baselineRevision = "ae44fc8";
let source = await readFile(
	new URL("./test-browser.mjs", import.meta.url),
	"utf8",
);
source = source.replace(
	'const frontend = fileURLToPath(new URL("..", import.meta.url));',
	`const frontend = ${JSON.stringify(frontend)};`,
);
source = source.replace(
	"root: frontend,",
	'root: frontend, cacheDir: path.join(profile, "vite-cache"),',
);
if (baseline) {
	const modules = [
		"MaterialReader.tsx",
		"reader-frames.ts",
		"study-marks-query.ts",
		"chapter-translations-query.ts",
	];
	const originals = Object.fromEntries(
		modules.map((name) => [
			`${frontend}src/materials/${name}`,
			execFileSync(
				"git",
				["show", `${baselineRevision}:frontend/src/materials/${name}`],
				{
					cwd: frontend,
					encoding: "utf8",
				},
			),
		]),
	);
	source = source.replace(
		"plugins: [",
		`plugins: [{name: "historical-reader-baseline", enforce: "pre", transform(source, id) {return ${JSON.stringify(originals)}[id.split("?")[0]];}},`,
	);
	console.log(
		`Historical reader baseline: ${baselineRevision}; production files remain untouched`,
	);
}
const count = Number(process.env.READER_MEASUREMENT_RUNS ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 10)
	throw new Error("READER_MEASUREMENT_RUNS must be 1..10");
for (let run = 0; run < count; run++) {
	if (count > 1) console.log(`Reader measurement ${run + 1}/${count}`);
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-"], {
			cwd: frontend,
			env: {
				...process.env,
				BROWSER_TEST_SUITE: "reader-session",
				BROWSER_TEST_QUERY:
					process.env.BROWSER_TEST_QUERY ?? "?suite=reader-session",
				BROWSER_TEST_BASELINE: baseline ? "1" : "",
			},
			stdio: ["pipe", "inherit", "inherit"],
		});
		child.stdin.end(source);
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`Reader measurement exited with ${code}`)),
		);
	});
}
