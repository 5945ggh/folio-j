import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const chrome =
	process.env.CHROME_BIN ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chrome).catch(() => {
	throw new Error(
		`Chrome unavailable at ${chrome}; set CHROME_BIN to a Chrome executable`,
	);
});
const profile = await mkdtemp(path.join(tmpdir(), "folio-j-browser-tests-"));
let server;
try {
	server = await createServer({
		root: frontend,
		configFile: path.join(frontend, "vite.config.ts"),
		server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: {} },
		plugins: [
			{
				name: "block-unmocked-test-api",
				configureServer(vite) {
					vite.middlewares.use((request, response, next) => {
						if (!request.url?.startsWith("/api/")) return next();
						response.statusCode = 500;
						response.end("Browser tests must mock all API requests");
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string")
		throw new Error("Vite did not select a port");
	const url = `http://127.0.0.1:${address.port}/browser-tests/`;
	console.log(`Browser regression page: ${url}`);
	const { stdout } = await promisify(execFile)(
		chrome,
		[
			"--headless",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-extensions",
			"--disable-sync",
			"--disable-default-apps",
			"--disable-dev-shm-usage",
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
			`--user-data-dir=${profile}`,
			"--window-size=600,900",
			"--virtual-time-budget=10000",
			"--dump-dom",
			url,
		],
		{ timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
	);
	const result = stdout.match(
		/<pre[^>]*id="result"[^>]*>([\s\S]*?)<\/pre>/,
	)?.[1];
	if (!stdout.includes('data-status="passed"'))
		throw new Error(
			result ?? `Browser did not report a result:\n${stdout.slice(-2000)}`,
		);
	console.log(result);
} finally {
	await server?.close();
	await rm(profile, { recursive: true, force: true });
}
