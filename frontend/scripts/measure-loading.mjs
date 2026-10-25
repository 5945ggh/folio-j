import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Compare built applications, alternating builds in fresh browser contexts.
// The static server matches uncompressed local hosting; API data stays offline.
const frontend = fileURLToPath(new URL("..", import.meta.url));
const directories = process.argv.slice(2);
if (!directories.length) directories.push(path.join(frontend, "dist"));
const runs = Number(process.env.LOADING_MEASUREMENT_RUNS ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 20)
	throw new Error("LOADING_MEASUREMENT_RUNS must be 1..20");
const chrome =
	process.env.CHROME_BIN ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chrome);
const profile = await mkdtemp(path.join(tmpdir(), "folio-j-loading-"));
const settings = {
	profile: {
		native_language: "中文",
		explain_language: "中文",
		level_note: "离线加载测量",
	},
	defaults: {
		analysis_model_id: null,
		chat_model_id: null,
		extraction_model_id: null,
		style_id: null,
		permission_mode: "review",
	},
	styles: [],
};
const fixtures = {
	"/api/sources": [],
	"/api/materials": { items: [], page: 1, page_size: 50, total: 0 },
	"/api/settings": settings,
	"/api/settings/segment-context": {
		enabled: true,
		before_sentences: 3,
		after_sentences: 3,
		before_characters: 200,
		after_characters: 200,
		revision: 0,
	},
};
const unexpected = [];
const servers = [];
let browser;
try {
	for (const directory of directories) {
		const root = path.resolve(directory);
		await access(path.join(root, "index.html"));
		const server = createServer(async (request, response) => {
			try {
				const pathname = new URL(request.url, "http://local").pathname;
				response.setHeader("Cache-Control", "no-store");
				if (pathname.startsWith("/api/")) {
					if (request.method !== "GET" || !(pathname in fixtures))
						throw new Error(`Unmocked ${request.method} ${pathname}`);
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify(fixtures[pathname]));
					return;
				}
				const filename = path.resolve(root, `.${pathname}`);
				if (!filename.startsWith(`${root}${path.sep}`))
					throw new Error(`Invalid path ${pathname}`);
				const extension = path.extname(filename);
				const data = await readFile(
					extension ? filename : path.join(root, "index.html"),
				);
				response.setHeader(
					"Content-Type",
					{
						".js": "text/javascript",
						".css": "text/css",
						".svg": "image/svg+xml",
					}[extension] ?? "text/html",
				);
				response.end(data);
			} catch (error) {
				unexpected.push(String(error));
				response.writeHead(500).end(String(error));
			}
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		servers.push({
			server,
			root,
			origin: `http://127.0.0.1:${server.address().port}`,
		});
	}
	browser = spawn(
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
			"--remote-debugging-pipe",
			"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
			`--user-data-dir=${profile}`,
		],
		{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
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
	const rejectPending = (error) => {
		for (const waiter of pending.values()) waiter.reject(error);
	};
	browser.once("error", rejectPending);
	browser.once("exit", () => rejectPending(new Error("Chrome exited")));
	const samples = [];
	for (let run = 0; run < runs; run++) {
		for (const { root, origin } of run % 2 ? [...servers].reverse() : servers) {
			for (const [route, selector] of [
				["/materials", "#library-empty-import"],
				["/settings?section=learning", "#learning-settings-form input"],
			]) {
				const { browserContextId } = await command(
					"Target.createBrowserContext",
				);
				const timer = setTimeout(() => {
					rejectPending(new Error("Loading measurement timed out"));
					browser.kill();
				}, 20000);
				try {
					const { targetId } = await command("Target.createTarget", {
						url: "about:blank",
						browserContextId,
					});
					const { sessionId } = await command("Target.attachToTarget", {
						targetId,
						flatten: true,
					});
					await command("Page.enable", {}, sessionId);
					await command("Page.bringToFront", {}, sessionId);
					await command("Network.enable", {}, sessionId);
					await command(
						"Network.setCacheDisabled",
						{ cacheDisabled: true },
						sessionId,
					);
					await command(
						"Emulation.setDeviceMetricsOverride",
						{
							width: 1280,
							height: 900,
							deviceScaleFactor: 1,
							mobile: false,
						},
						sessionId,
					);
					await command(
						"Page.addScriptToEvaluateOnNewDocument",
						{
							source: `new MutationObserver(() => { if (!window.__readyMs && document.querySelector(${JSON.stringify(selector)})) window.__readyMs = performance.now(); }).observe(document, {childList:true,subtree:true});`,
						},
						sessionId,
					);
					await command(
						"Page.navigate",
						{ url: `${origin}${route}` },
						sessionId,
					);
					const evaluated = await command(
						"Runtime.evaluate",
						{
							expression: `new Promise(resolve => { const timer = setInterval(() => { if (window.__readyMs) { clearInterval(timer); requestAnimationFrame(() => requestAnimationFrame(() => resolve({readyMs: window.__readyMs, fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, resources: performance.getEntriesByType('resource').filter(r => /\\.(js|css)$/.test(new URL(r.name).pathname)).map(r => ({path: new URL(r.name).pathname, bytes: r.encodedBodySize}))}))); } }, 10); })`,
							awaitPromise: true,
							returnByValue: true,
						},
						sessionId,
					);
					if (evaluated.exceptionDetails)
						throw new Error(JSON.stringify(evaluated.exceptionDetails));
					const result = evaluated.result.value;
					let jsBytes = 0;
					let cssBytes = 0;
					let gzipJsBytes = 0;
					for (const resource of result.resources) {
						if (resource.path.endsWith(".js")) {
							jsBytes += resource.bytes;
							gzipJsBytes += gzipSync(
								await readFile(path.join(root, resource.path)),
							).length;
						} else cssBytes += resource.bytes;
					}
					samples.push({
						build: root,
						route,
						run: run + 1,
						...result,
						jsBytes,
						cssBytes,
						gzipJsBytes,
					});
				} finally {
					clearTimeout(timer);
					await command("Target.disposeBrowserContext", { browserContextId });
				}
			}
		}
	}
	if (unexpected.length) throw new Error(unexpected.join("\n"));
	console.log(
		JSON.stringify(
			{
				conditions:
					"1280x900, cold browser context, no HTTP compression, loopback offline API, alternating builds, DOM ready (not model/backend latency)",
				samples,
			},
			null,
			2,
		),
	);
} finally {
	if (browser && browser.exitCode === null) {
		browser.kill();
		await new Promise((resolve) => browser.once("close", resolve));
	}
	await Promise.all(
		servers.map(
			({ server }) => new Promise((resolve) => server.close(resolve)),
		),
	);
	await rm(profile, { recursive: true, force: true });
}
