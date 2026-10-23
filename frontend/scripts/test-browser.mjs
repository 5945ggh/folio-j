import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
	for (const [width, query] of [
		[600, ""],
		[1280, "?suite=reader-bookmarks"],
	]) {
		const browser = spawn(
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
				"--remote-debugging-pipe",
				"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
				`--user-data-dir=${profile}`,
				`--window-size=${width},900`,
			],
			{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
		);
		let serial = 0;
		let incoming = "";
		const pending = new Map();
		const command = (method, params = {}, sessionId) =>
			new Promise((resolve, reject) => {
				const id = ++serial;
				pending.set(id, { resolve, reject });
				browser.stdio[3].write(
					`${JSON.stringify({ id, method, params, sessionId })}\0`,
				);
			});
		browser.stdio[4].on("data", (chunk) => {
			incoming += chunk.toString();
			let boundary = incoming.indexOf("\0");
			while (boundary !== -1) {
				const message = JSON.parse(incoming.slice(0, boundary));
				incoming = incoming.slice(boundary + 1);
				const waiter = pending.get(message.id);
				if (waiter) {
					pending.delete(message.id);
					if (message.error)
						waiter.reject(new Error(JSON.stringify(message.error)));
					else waiter.resolve(message.result);
				}
				boundary = incoming.indexOf("\0");
			}
		});
		browser.on("error", (error) => {
			for (const waiter of pending.values()) waiter.reject(error);
		});
		const timeout = setTimeout(() => {
			for (const waiter of pending.values())
				waiter.reject(new Error("Browser regression timed out"));
			browser.kill();
		}, 60000);
		try {
			const { targetId } = await command("Target.createTarget", {
				url: "about:blank",
			});
			const { sessionId } = await command("Target.attachToTarget", {
				targetId,
				flatten: true,
			});
			await command("Page.enable", {}, sessionId);
			await command("Page.navigate", { url: `${url}${query}` }, sessionId);
			// Use actual rendering and scroll/ResizeObserver delivery, not virtual time.
			const evaluated = await command(
				"Runtime.evaluate",
				{
					expression: `new Promise((resolve) => { const timer = setInterval(() => { const result = document.querySelector('#result'); if (result?.dataset.status) { clearInterval(timer); resolve({ status: result.dataset.status, text: result.textContent }); } }, 20); })`,
					awaitPromise: true,
					returnByValue: true,
				},
				sessionId,
			);
			if (evaluated.exceptionDetails)
				throw new Error(JSON.stringify(evaluated.exceptionDetails));
			const result = evaluated.result.value;
			if (result.status !== "passed") throw new Error(result.text);
			console.log(result.text);
		} finally {
			clearTimeout(timeout);
			browser.kill();
			await new Promise((resolve) => browser.once("close", resolve));
		}
	}
} finally {
	await server?.close();
	await rm(profile, { recursive: true, force: true });
}
