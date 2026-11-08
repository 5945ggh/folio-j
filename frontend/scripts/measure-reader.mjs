import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run the normal offline browser entry as a file, preserving relative imports.
const frontend = fileURLToPath(new URL("..", import.meta.url));
const runner = fileURLToPath(new URL("./test-browser.mjs", import.meta.url));
const baseline = process.argv.includes("--baseline");
const count = Number(process.env.READER_MEASUREMENT_RUNS ?? 1);
if (!Number.isInteger(count) || count < 1 || count > 10)
	throw new Error("READER_MEASUREMENT_RUNS must be 1..10");
for (let run = 0; run < count; run++) {
	if (count > 1) console.log(`Reader measurement ${run + 1}/${count}`);
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [runner], {
			cwd: frontend,
			env: {
				...process.env,
				BROWSER_TEST_SUITE: "reader-session",
				BROWSER_TEST_QUERY:
					process.env.BROWSER_TEST_QUERY ?? "?suite=reader-session",
				BROWSER_TEST_BASELINE: baseline ? "1" : "",
			},
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) =>
			code === 0
				? resolve()
				: reject(new Error(`Reader measurement exited with ${code ?? signal}`)),
		);
	});
}
