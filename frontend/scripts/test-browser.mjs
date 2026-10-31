import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const { selectBrowserScenarios, browserScreenshotName } = await import(
	path.join(frontend, "scripts/browser-test-plan.mjs")
);
const scenarios = selectBrowserScenarios(
	[
		[1280, 900, "?suite=app-theme&system=light"],
		[1280, 900, "?suite=app-theme&system=dark"],
		[390, 900, "?suite=app-theme&system=light"],
		[390, 900, "?suite=app-theme&system=dark"],
		[1280, 900, "?suite=settings-models"],
		[390, 900, "?suite=settings-models"],
		[1280, 900, "?suite=route-loading"],
		[390, 900, "?suite=route-loading"],
		[1280, 900, "?suite=route-loading&direction=vertical-rl"],
		[1280, 900, "?suite=catalog-overview"],
		[390, 900, "?suite=catalog-overview"],
		[320, 900, "?suite=catalog-overview"],
		[1280, 900, "?suite=catalog-reuse"],
		[390, 900, "?suite=catalog-reuse"],
		[320, 900, "?suite=catalog-reuse"],
		[1280, 900, "?suite=catalog-toolbar"],
		[390, 900, "?suite=catalog-toolbar"],
		[320, 900, "?suite=catalog-toolbar"],
		[1280, 900, "?suite=segment-catalog"],
		[390, 900, "?suite=segment-catalog"],
		[320, 900, "?suite=segment-catalog"],
		[1280, 900, "?suite=material-import"],
		[390, 900, "?suite=material-import"],
		[1280, 900, "?suite=material-import&reduced-motion"],
		[1280, 900, "?suite=material-vocabulary"],
		[390, 900, "?suite=material-vocabulary"],
		[320, 900, "?suite=material-vocabulary"],
		[1280, 900, "?suite=material-vocabulary&mode=dark"],
		[390, 900, "?suite=material-vocabulary&mode=dark"],
		[1280, 900, "?suite=route-motion"],
		[390, 900, "?suite=route-motion"],
		[1280, 900, "?suite=route-motion&reduced-motion"],
		[1280, 900, "?suite=reader-session"],
		[1280, 900, "?suite=reader-layout-switch"],
		[390, 900, "?suite=reader-layout-switch"],
		[1280, 900, "?suite=reader-layout-switch&direction=vertical-rl"],
		[390, 900, "?suite=reader-layout-switch&direction=vertical-rl"],
		[1280, 900, "?suite=reader-images"],
		[1280, 900, "?suite=reader-images&strict"],
		[1280, 900, "?suite=reader-image-performance"],
		[390, 900, "?suite=reader-images"],
		[1280, 900, "?suite=reader-images&direction=vertical-rl"],
		[1280, 900, "?suite=reader-images&reduced-motion"],
		[390, 900, "?suite=reader-session"],
		[1280, 900, "?suite=reader-session&direction=vertical-rl"],
		[1280, 900, "?suite=reader-clipboard"],
		[1280, 900, "?suite=reader-settings"],
		[1280, 900, "?suite=reader-settings&theme=dark"],
		[390, 900, "?suite=reader-settings&theme=dark"],
		[390, 900, "?suite=reader-settings&direction=vertical-rl"],
		[320, 900, "?suite=reader-settings"],
		[320, 900, "?suite=reader-settings&direction=vertical-rl"],
		[1280, 900, "?suite=reader-context-copy"],
		[1280, 900, "?suite=reader-context-copy&direction=vertical-rl"],
		[320, 900, "?suite=reader-context-copy"],
		[320, 900, "?suite=reader-context-copy&direction=vertical-rl"],
		[600, 900, ""],
		[1280, 900, "?suite=explanation"],
		[390, 900, "?suite=explanation"],
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
		[1280, 900, "?suite=position-bookmarks"],
		[390, 900, "?suite=position-bookmarks"],
		[1280, 900, "?suite=position-bookmarks&direction=vertical-rl"],
		[390, 900, "?suite=position-bookmarks&direction=vertical-rl"],
		[1280, 900, "?suite=position-bookmarks&theme=light"],
		[390, 900, "?suite=position-bookmarks&direction=vertical-rl&theme=light"],
		[320, 900, "?suite=position-bookmarks&theme=light"],
		[1280, 900, "?suite=position-bookmarks&compact"],
		[1280, 900, "?suite=position-bookmarks&theme=light&compact"],
		[1280, 900, "?suite=inline-records"],
		[1280, 900, "?suite=inline-records&performance"],
		[1280, 900, "?suite=inline-records&performance&reduced-motion"],
		[390, 900, "?suite=inline-records"],
		[1280, 900, "?suite=inline-records&direction=vertical-rl"],
		[1280, 900, "?suite=translation-removal"],
		[390, 900, "?suite=translation-removal"],
		[1280, 900, "?suite=translation-removal&direction=vertical-rl"],
		[390, 900, "?suite=translation-removal&direction=vertical-rl"],
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
	],
	process.env,
);
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
		cacheDir: path.join(profile, "vite-cache"),
		// The test-only virtual import must be prebundled before the page mounts.
		optimizeDeps: { include: ["react-markdown"] },
		configFile: path.join(frontend, "vite.config.ts"),
		server: {
			host: "127.0.0.1",
			port: 0,
			strictPort: false,
			proxy: {},
			hmr: false,
			watch: null,
		},
		plugins: [
			{
				name: "block-unmocked-browser-test-api",
				configureServer(testServer) {
					// Runs before Vite's proxy middleware, including proxies merged from the app config.
					testServer.middlewares.use((request, response, next) => {
						const pathname = new URL(request.url ?? "/", "http://offline.test")
							.pathname;
						if (pathname !== "/api" && !pathname.startsWith("/api/"))
							return next();
						const detail = `Offline browser test blocked unmocked API request: ${request.method} ${pathname}`;
						console.error(detail);
						response.statusCode = 500;
						response.setHeader("Content-Type", "application/json");
						response.end(JSON.stringify({ detail }));
					});
				},
			},
			{
				name: "count-chat-markdown-parses",
				enforce: "pre",
				resolveId(source, importer) {
					if (
						source === "react-markdown" &&
						importer?.split("?")[0].endsWith("/src/analysis/Markdown.tsx")
					)
						return "\0browser-test-markdown";
				},
				load(id) {
					if (id !== "\0browser-test-markdown") return;
					// Observe actual Markdown processing through its plugin interface.
					return `import ReactMarkdown from "react-markdown";
import { createElement } from "react";
function countParse() {
  return (_tree, file) => {
    const text = String(file.value);
    globalThis.__chatMarkdownParses ??= {};
    globalThis.__chatMarkdownParses[text] = (globalThis.__chatMarkdownParses[text] ?? 0) + 1;
  };
}
export default function ObservedMarkdown(props) {
  return createElement(ReactMarkdown, {...props, remarkPlugins: [countParse, ...(props.remarkPlugins ?? [])]});
}`;
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
	let completed = 0;
	for (const [width, height, query] of scenarios) {
		let testQuery = process.env.BROWSER_TEST_BASELINE
			? `${query}&baseline`
			: query;
		if (process.env.BROWSER_TEST_PREVIEW) {
			const preview = new URLSearchParams(testQuery);
			preview.set("preview", "");
			preview.set("path", process.env.BROWSER_TEST_PREVIEW);
			if (process.env.BROWSER_TEST_PANEL)
				preview.set("panel", process.env.BROWSER_TEST_PANEL);
			if (process.env.BROWSER_TEST_THEME)
				preview.set("mode", process.env.BROWSER_TEST_THEME);
			testQuery = `?${preview}`;
		} else if (process.env.BROWSER_TEST_SCREENSHOT_DIR) {
			testQuery += "&capture";
		}
		const scene = `${width}x${height}${testQuery}`;
		console.log(
			`Browser scenario ${completed + 1}/${scenarios.length}: ${scene}`,
		);
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
		let stderr = "";
		let lastMethod = "launch";
		let lastPageState;
		let stoppedError;
		const exceptions = [];
		const pending = new Map();
		const rejectPending = (error) => {
			stoppedError = error;
			for (const waiter of pending.values()) waiter.reject(error);
			pending.clear();
		};
		const closed = new Promise((resolve) => browser.once("close", resolve));
		browser.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		const command = (method, params = {}, sessionId) =>
			new Promise((resolve, reject) => {
				if (stoppedError) return reject(stoppedError);
				lastMethod = method;
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
				if (message.method === "Runtime.exceptionThrown") {
					exceptions.push(message.params.exceptionDetails);
					if (exceptions.length > 3) exceptions.shift();
				}
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
				if (
					message.method === "Runtime.bindingCalled" &&
					message.params.name === "__dispatchBrowserKey"
				) {
					const { id, key } = JSON.parse(message.params.payload);
					void (async () => {
						await command(
							"Input.dispatchKeyEvent",
							{
								type: "keyDown",
								key,
								code: key,
								windowsVirtualKeyCode: key === "Escape" ? 27 : 9,
							},
							message.sessionId,
						);
						await command(
							"Input.dispatchKeyEvent",
							{
								type: "keyUp",
								key,
								code: key,
								windowsVirtualKeyCode: key === "Escape" ? 27 : 9,
							},
							message.sessionId,
						);
						await command(
							"Runtime.evaluate",
							{ expression: `window.__keyResolvers.get(${id})()` },
							message.sessionId,
						);
					})();
				}
				if (
					message.method === "Runtime.bindingCalled" &&
					message.params.name === "__dispatchBrowserTheme"
				) {
					const { id, mode } = JSON.parse(message.params.payload);
					void (async () => {
						await command(
							"Emulation.setEmulatedMedia",
							{ features: [{ name: "prefers-color-scheme", value: mode }] },
							message.sessionId,
						);
						await command(
							"Runtime.evaluate",
							{ expression: `window.__themeResolvers.get(${id})()` },
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
		browser.on("error", rejectPending);
		browser.stdio[3].on("error", rejectPending);
		browser.on("exit", (code, signal) =>
			rejectPending(
				new Error(`Chrome exited (${code ?? signal}) in ${scene}: ${stderr}`),
			),
		);
		const timeout = setTimeout(() => {
			rejectPending(
				new Error(
					`Browser regression timed out in ${scene}; last command ${lastMethod}; page ${JSON.stringify(lastPageState)}; exceptions ${JSON.stringify(exceptions)}\n${stderr}`,
				),
			);
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
				{ name: "__dispatchBrowserKey" },
				sessionId,
			);
			await command(
				"Page.addScriptToEvaluateOnNewDocument",
				{
					source: `window.__keyResolvers = new Map(); window.browserKey = (key) => new Promise((resolve) => { const id = window.__keyResolvers.size + 1; window.__keyResolvers.set(id, resolve); window.__dispatchBrowserKey(JSON.stringify({id,key})); });`,
				},
				sessionId,
			);
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
			await command(
				"Runtime.addBinding",
				{ name: "__dispatchBrowserTheme" },
				sessionId,
			);
			await command(
				"Page.addScriptToEvaluateOnNewDocument",
				{
					source: `window.__themeResolvers = new Map(); window.browserTheme = (mode) => new Promise((resolve) => { const id = window.__themeResolvers.size + 1; window.__themeResolvers.set(id, resolve); window.__dispatchBrowserTheme(JSON.stringify({id,mode})); });`,
				},
				sessionId,
			);
			if (
				["theme", "app-theme"].includes(new URLSearchParams(query).get("suite"))
			) {
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
			const destination = `${url}${testQuery}`;
			await command("Page.navigate", { url: destination }, sessionId);
			// Use actual rendering and scroll/ResizeObserver delivery, not virtual time.
			// Probe from Node so waiting cannot remain bound to a discarded document.
			let result;
			while (!result) {
				const evaluated = await command(
					"Runtime.evaluate",
					{
						expression: `({href: location.href, ready: document.readyState, status: document.querySelector('#result')?.dataset.status, text: document.querySelector('#result')?.textContent})`,
						returnByValue: true,
					},
					sessionId,
				);
				if (evaluated.exceptionDetails)
					throw new Error(JSON.stringify(evaluated.exceptionDetails));
				lastPageState = evaluated.result.value;
				if (lastPageState?.href === destination && lastPageState.status)
					result = lastPageState;
				else await new Promise((resolve) => setTimeout(resolve, 20));
			}
			if (result.status !== "passed") throw new Error(result.text);
			if (process.env.BROWSER_TEST_SCREENSHOT_DIR) {
				await command(
					"Runtime.evaluate",
					{ expression: "document.querySelector('#result').hidden = true" },
					sessionId,
				);
				const directory = path.resolve(process.env.BROWSER_TEST_SCREENSHOT_DIR);
				await mkdir(directory, { recursive: true });
				const filename = browserScreenshotName(width, height, testQuery);
				const captured = await command(
					"Page.captureScreenshot",
					{ format: "png", captureBeyondViewport: false },
					sessionId,
				);
				const destination = path.join(directory, filename);
				await writeFile(destination, Buffer.from(captured.data, "base64"));
				console.log(`Screenshot: ${destination}`);
			}
			console.log(result.text);
			completed++;
		} finally {
			clearTimeout(timeout);
			browser.kill();
			await closed;
		}
	}
	console.log(`Browser scenarios passed: ${completed}/${scenarios.length}`);
} finally {
	await server?.close();
	await rm(profile, { recursive: true, force: true });
}
