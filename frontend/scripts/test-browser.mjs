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
				name: "count-chat-markdown-renders",
				enforce: "pre",
				transform(source, id) {
					if (!id.endsWith("/src/analysis/Markdown.tsx")) return;
					return source.replace(
						"\treturn (",
						`globalThis.__chatMarkdownRenders ??= {}; globalThis.__chatMarkdownRenders[text] = (globalThis.__chatMarkdownRenders[text] ?? 0) + 1;\n\treturn (`,
					);
				},
			},
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
	for (const [width, height, query] of [
		[1280, 900, "?suite=route-loading"],
		[390, 900, "?suite=route-loading"],
		[1280, 900, "?suite=route-loading&direction=vertical-rl"],
		[1280, 900, "?suite=reader-session"],
		[390, 900, "?suite=reader-session"],
		[1280, 900, "?suite=reader-session&direction=vertical-rl"],
		[600, 900, ""],
		[1280, 900, "?suite=workbench"],
		[390, 900, "?suite=workbench"],
		[1280, 900, "?suite=workbench-history"],
		[1280, 900, "?suite=workbench-render"],
		[390, 900, "?suite=workbench-render"],
		[1280, 900, "?suite=segment-materials"],
		[1280, 900, "?suite=analysis-reading"],
		[1280, 900, "?suite=analysis-rename"],
		[390, 900, "?suite=analysis-rename"],
		[320, 900, "?suite=analysis-reading"],
		[320, 900, "?suite=segment-materials"],
		[1280, 900, "?suite=reader-bookmarks"],
		[1280, 900, "?suite=inline-records"],
		[1280, 900, "?suite=inline-records&performance"],
		[1280, 900, "?suite=inline-records&performance&reduced-motion"],
		[390, 900, "?suite=inline-records"],
		[1280, 900, "?suite=inline-records&direction=vertical-rl"],
		[1280, 900, "?suite=chapter-records"],
		[1280, 900, "?suite=chapter-records&theme=dark"],
		[1280, 900, "?suite=chapter-records&direction=vertical-rl"],
		[1280, 900, "?suite=chapter-records&direction=vertical-rl&theme=dark"],
		[320, 900, "?suite=chapter-records"],
		[320, 900, "?suite=chapter-records&theme=dark"],
		[320, 900, "?suite=chapter-records&direction=vertical-rl"],
		[320, 900, "?suite=chapter-records&direction=vertical-rl&theme=dark"],
		[1280, 900, "?suite=chapter-records&detached"],
		[1280, 900, "?suite=chapter-records&detached&evicted"],
		[
			320,
			900,
			"?suite=chapter-records&direction=vertical-rl&theme=dark&detached",
		],
		[1280, 900, "?suite=record-saving"],
		[390, 900, "?suite=record-saving"],
		[1280, 900, "?suite=record-saving&direction=vertical-rl&theme=dark"],
		[1280, 900, "?suite=navigation-feedback"],
		[1280, 900, "?suite=navigation-feedback&theme=dark"],
		[390, 900, "?suite=navigation-feedback"],
		[1280, 900, "?suite=navigation-feedback&direction=vertical-rl"],
		[1280, 900, "?suite=navigation-feedback&reduced-motion"],
		[1280, 900, "?suite=translation"],
		[390, 900, "?suite=translation"],
		[1280, 900, "?suite=reading-aids"],
		[1280, 900, "?suite=segment-share"],
		[390, 900, "?suite=segment-share"],
		[320, 320, "?suite=segment-share"],
		[640, 360, "?suite=segment-share"],
		[390, 900, "?suite=reading-aids"],
		[320, 900, "?suite=reading-aids"],
		[320, 320, "?suite=reading-aids&scenario=short"],
		[640, 360, "?suite=reading-aids&scenario=short"],
		[1280, 900, "?suite=theme&system=light"],
		[1280, 900, "?suite=theme&system=dark"],
		[320, 900, "?suite=theme&system=light"],
		[320, 900, "?suite=theme&system=dark"],
	].filter(
		([, , query]) =>
			!process.env.BROWSER_TEST_SUITE ||
			new URLSearchParams(query).get("suite") ===
				process.env.BROWSER_TEST_SUITE,
	)) {
		if (
			process.env.BROWSER_TEST_QUERY &&
			query !== process.env.BROWSER_TEST_QUERY
		)
			continue;
		const testQuery = process.env.BROWSER_TEST_BASELINE
			? `${query}&baseline`
			: query;
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
				`--window-size=${width},${height}`,
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
				if (
					message.method === "Runtime.bindingCalled" &&
					message.params.name === "__dispatchBrowserPointer"
				) {
					const { id, events } = JSON.parse(message.params.payload);
					void (async () => {
						for (const event of events) {
							await command(
								"Input.dispatchMouseEvent",
								event,
								message.sessionId,
							);
							await command(
								"Runtime.evaluate",
								{
									expression:
										"new Promise(resolve => requestAnimationFrame(() => resolve()))",
									awaitPromise: true,
								},
								message.sessionId,
							);
						}
						await command(
							"Runtime.evaluate",
							{ expression: `window.__pointerResolvers.get(${id})()` },
							message.sessionId,
						);
					})();
				}
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
			await command("Page.bringToFront", {}, sessionId);
			await command("Runtime.enable", {}, sessionId);
			await command(
				"Runtime.addBinding",
				{ name: "__dispatchBrowserPointer" },
				sessionId,
			);
			await command(
				"Page.addScriptToEvaluateOnNewDocument",
				{
					source: `window.__pointerResolvers = new Map(); window.browserPointer = (events) => new Promise((resolve) => { const id = window.__pointerResolvers.size + 1; window.__pointerResolvers.set(id, resolve); window.__dispatchBrowserPointer(JSON.stringify({id,events})); });`,
				},
				sessionId,
			);
			if (new URLSearchParams(query).get("suite") === "theme") {
				await command(
					"Emulation.setEmulatedMedia",
					{
						features: [
							{
								name: "prefers-color-scheme",
								value: new URLSearchParams(query).get("system") ?? "light",
							},
						],
					},
					sessionId,
				);
			}
			if (new URLSearchParams(query).has("reduced-motion")) {
				await command(
					"Emulation.setEmulatedMedia",
					{ features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
					sessionId,
				);
			}
			await command(
				"Emulation.setDeviceMetricsOverride",
				{
					width,
					height,
					deviceScaleFactor: 1,
					mobile: false,
				},
				sessionId,
			);
			await command("Page.navigate", { url: `${url}${testQuery}` }, sessionId);
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
