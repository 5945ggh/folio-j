import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { AnalysisDetail } from "../src/analysis/api";
import type { components } from "../src/api/schema";
import { READER_UI_KEY } from "../src/materials/preferences";
import { startAppTheme } from "../src/theme/browser";
import { THEME_STORAGE_KEY, type ThemeMode } from "../src/theme/preference";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeThread, provider, settings } from "./workbench";

type Schema = components["schemas"];
type Color = [number, number, number, number];
const timestamp = materialSegment.created_at;
const source = {
	id: "source",
	title: "日本文学",
	description: "日语原版阅读与学习",
	note: "阅读笔记",
	segment_count: 1,
	created_at: timestamp,
	updated_at: timestamp,
};
const book: Schema["MaterialCatalogItem"] = {
	id: "book",
	title: "春の庭と日本語",
	source_id: source.id,
	source_title: source.title,
	version_id: "version",
	contract_version: "1",
	type: "book",
	cover_url: null,
	created_at: timestamp,
	last_opened_at: null,
	status: "in_progress",
	usage_revision: 0,
	product_sha256: "a".repeat(64),
	source_sha256: "b".repeat(64),
	warnings: [],
};
const segment: Schema["SegmentResponse"] = {
	...materialSegment,
	material_provenance: null,
};
const analysis: AnalysisDetail = {
	id: "analysis",
	segment_id: segment.id,
	title: "言葉と文脈",
	excerpt: "结合语境理解原文。",
	current_revision_id: "revision",
	revision_id: "revision",
	parent_revision_id: null,
	origin: "manual",
	run_id: null,
	normalizer_version: 1,
	created_at: timestamp,
	updated_at: timestamp,
	source_md:
		"# 言葉と文脈\n\n结合上下文理解目标原文。\n\n## 表达\n\n这是已经保存的独立讲解。",
	warnings: [],
	sections: [
		{
			id: "section",
			uid: "section-uid",
			handle: "context",
			kind: "section",
			title: "言葉と文脈",
			display_no: "1",
			start_line: 1,
			end_line: 3,
			raw: "# 言葉と文脈\n\n结合上下文理解目标原文。",
		},
	],
};
const chapter: Schema["MaterialChapterResponse"] = {
	id: "chapter",
	material_id: book.id,
	version_id: book.version_id,
	title: "春の庭",
	level: 0,
	resources: [
		{
			id: "r",
			text: "春の庭。",
			text_sha256: "b".repeat(64),
			href: "chapter.xhtml",
			css: "",
			html_attributes: {},
			body_attributes: {},
		},
	],
	parts: [
		{
			resource_id: "r",
			spine_index: 0,
			start: 0,
			end: 4,
			leaf_start: 0,
			leaf_end: 1,
			html: '<p><span data-locator-leaf="0">春の庭。</span></p>',
		},
	],
};
function color(value: string): Color {
	const context = document
		.createElement("canvas")
		.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("Missing canvas color parser");
	context.fillStyle = value;
	context.fillRect(0, 0, 1, 1);
	const data = context.getImageData(0, 0, 1, 1).data;
	return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
}
function over(front: Color, back: Color): Color {
	const alpha = front[3] + back[3] * (1 - front[3]);
	if (!alpha) return [0, 0, 0, 0];
	return [0, 1, 2]
		.map(
			(i) =>
				((front[i] ?? 0) * front[3] +
					(back[i] ?? 0) * back[3] * (1 - front[3])) /
				alpha,
		)
		.concat(alpha) as Color;
}
function background(node: Element | null): Color {
	if (!node) return [255, 255, 255, 1];
	return over(
		color(getComputedStyle(node).backgroundColor),
		background(node.parentElement),
	);
}
function luminance(value: Color) {
	const linear = value.slice(0, 3).map((n) => {
		const v = n / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return (
		(linear[0] ?? 0) * 0.2126 +
		(linear[1] ?? 0) * 0.7152 +
		(linear[2] ?? 0) * 0.0722
	);
}

/** Real App routes, offline data, real storage events and CDP media changes. */
export async function appTheme(h: BrowserHarness, preview = false) {
	const { App, appRoutes } = await import("../src/App");
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search);
	const completed: string[] = [];
	const failures: string[] = [];
	const verify = (condition: unknown, message: string) => {
		if (!condition) failures.push(message);
	};
	let minimum = Infinity;
	let requests = 0;
	h.mock(async (request) => {
		requests++;
		const path = new URL(request.url).pathname;
		const page = (items: unknown[]) =>
			Response.json({ items, total: items.length, page: 1, page_size: 50 });
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/runs") return Response.json([]);
		if (path === "/api/sources") return Response.json([source]);
		if (path === "/api/catalog/sources") return page([source]);
		if (path === "/api/sources/source") return Response.json(source);
		if (path === "/api/materials") return page([book]);
		if (path.endsWith("/catalog/segments")) return page([segment]);
		if (path.endsWith("/catalog/analyses")) return page([analysis]);
		if (path === "/api/materials/book/details")
			return Response.json({
				...book,
				chapter_count: 1,
				metadata_revision: 0,
				original_title: book.title,
				custom_cover: false,
			} satisfies Schema["MaterialDetailsResponse"]);
		if (path.endsWith("/statistics"))
			return Response.json(
				{ detail: "离线统计读取失败，请重试。" },
				{ status: 503 },
			);
		if (path === "/api/segments/segment") return Response.json(segment);
		if (path === "/api/segments/segment/analyses")
			return Response.json([analysis]);
		if (path === "/api/analyses/analysis") return Response.json(analysis);
		if (path === "/api/segments/segment/translation-results")
			return Response.json([]);
		if (path === "/api/segments/segment/threads")
			return Response.json({ items: [makeThread()], next_cursor: null });
		if (path === "/api/threads/thread") return Response.json(makeThread());
		if (path === "/api/threads/thread/messages")
			return Response.json({
				items: [
					{
						id: "assistant",
						thread_id: "thread",
						job_id: null,
						ordinal: 1,
						role: "assistant",
						status: "complete",
						content: "结合上下文，这里的表达强调场景。",
						created_at: timestamp,
						updated_at: timestamp,
					},
				],
				next_cursor: null,
			});
		if (path === "/api/materials/book" && request.method === "GET")
			return Response.json({
				...book,
				chapters: [
					{ id: chapter.id, title: chapter.title, level: 0, part_count: 1 },
				],
				reading_position: null,
			});
		if (path.endsWith("/opened") || path.endsWith("/usage"))
			return Response.json({
				material_id: book.id,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			});
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: book.id,
				version_id: book.version_id,
				generation_id: "generation",
				token_count: 0,
			});
		if (path.endsWith("/readings"))
			return Response.json({
				material_id: book.id,
				version_id: book.version_id,
				generation_id: "generation",
				resources: [],
			});
		if (path.endsWith("/chapters/chapter")) return Response.json(chapter);
		if (
			path.endsWith("/chapters/chapter/segments") ||
			path.endsWith("/chapters/chapter/translations")
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/translations"))
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (path.endsWith("/reading-position") && request.method === "PUT") {
			const body: Schema["ReadingPositionUpdate"] = await request.json();
			return Response.json({
				...body,
				progress: 0,
				revision: body.expected_revision + 1,
				updated_at: timestamp,
			});
		}
		throw new Error(`Unmocked app theme ${request.method} ${path}`);
	});
	const find = <T extends Element = HTMLElement>(selector: string): T => {
		const node = h.container.querySelector<T>(selector);
		check(node, `Missing theme sample ${selector}`);
		return node;
	};
	function contrast(selector: string, label: string, threshold = 4.5) {
		const node = find(selector);
		const bg = background(node);
		const fg = over(color(getComputedStyle(node).color), bg);
		const a = luminance(fg),
			b = luminance(bg);
		const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
		minimum = Math.min(minimum, ratio);
		verify(
			ratio >= threshold,
			`${label}: text contrast ${ratio.toFixed(2)} < ${threshold}, ${getComputedStyle(node).color} on ${getComputedStyle(node).backgroundColor}`,
		);
	}
	function layout(selector: string) {
		const node = find<HTMLElement>(selector);
		const box = node.getBoundingClientRect();
		verify(
			box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1,
			`${selector} outside ${innerWidth}px viewport: ${box.left}..${box.right}`,
		);
		verify(
			node.scrollWidth <= node.clientWidth + 1,
			`${selector} horizontal overflow ${node.scrollWidth}/${node.clientWidth}: ${JSON.stringify([...node.querySelectorAll("*")].filter((child) => child.getBoundingClientRect().right > box.right + 1).map((child) => ({ tag: child.tagName, cls: child.className, right: child.getBoundingClientRect().right, width: child.getBoundingClientRect().width })))}`,
		);
		verify(
			document.documentElement.scrollWidth <= innerWidth + 1,
			"App document horizontal overflow",
		);
	}
	let navigate: ReturnType<typeof useNavigate> | undefined;
	function RealApp() {
		const nav = useNavigate();
		useEffect(() => {
			navigate = nav;
		}, [nav]);
		return <App />;
	}
	localStorage.clear();
	sessionStorage.clear();
	const controller = startAppTheme();
	const initialSystem = matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
	check(
		controller.getSnapshot().preference === "system" &&
			localStorage.getItem(THEME_STORAGE_KEY) === null,
		"Missing preference must default to system without writing storage",
	);
	const defaultPath = "/settings?section=appearance";
	const entry = preview ? params.get("path") || defaultPath : defaultPath;
	if (preview)
		controller.select(params.get("mode") === "light" ? "light" : "dark");
	localStorage.setItem(
		READER_UI_KEY,
		JSON.stringify({ theme: "white", focus: false }),
	);
	const readerPreference = localStorage.getItem(READER_UI_KEY);
	const dispose = await h.mount(<RealApp />, "/", entry, appRoutes);
	let peer: HTMLIFrameElement | undefined;
	async function go(path: string, selector: string) {
		check(navigate, "App navigator unavailable");
		await navigate(path);
		await h.until(
			() => !!h.container.querySelector(selector),
			`${path} must load`,
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
	}
	async function mode(
		value: "light" | "dark" | "system",
		expected: ThemeMode = value === "system" ? initialSystem : value,
	) {
		const select = find<HTMLSelectElement>('select[aria-label="应用颜色模式"]');
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() =>
				controller.getSnapshot().preference === value &&
				document.documentElement.dataset.theme === expected,
			`Settings must apply ${value}/${expected}`,
		);
	}
	try {
		await h.until(
			() =>
				!!navigate &&
				!!h.container.querySelector(
					entry === defaultPath
						? 'select[aria-label="应用颜色模式"]'
						: ".app-shell,.reader-r1",
				),
			"Real App must mount selected route",
		);
		if (preview) {
			const ready = entry.startsWith("/segments/")
				? ".segment-original-focus"
				: entry.includes("/details")
					? ".book-details-content h1"
					: entry.startsWith("/materials/")
						? ".reader-r1 iframe"
						: entry.startsWith("/sources/")
							? ".s2-source-heading h1"
							: entry.startsWith("/sources")
								? ".s2-directory"
								: entry.startsWith("/materials")
									? ".book-title"
									: entry.includes("providers")
										? ".provider-service-main strong"
										: "select[aria-label='应用颜色模式']";
			await h.until(
				() => !!h.container.querySelector(ready),
				"Preview page must finish loading",
			);
			if (params.get("panel") === "import") {
				find<HTMLButtonElement>('button[aria-label="添加书籍"]').click();
				await h.until(
					() => !!h.container.querySelector(".import-dialog[open]"),
					"Preview import dialog must open",
				);
			}
			if (params.get("panel") === "provider") {
				find<HTMLButtonElement>("#provider-open-provider").click();
				await h.until(
					() => !!h.container.querySelector(".provider-detail-dialog[open]"),
					"Preview provider dialog must open",
				);
			}
			if (params.get("panel") === "book-info") {
				find<HTMLButtonElement>('button[aria-label="书籍信息"]').click();
				await h.until(
					() => !!h.container.querySelector('select[aria-label="阅读状态"]'),
					"Preview book information must open",
				);
				const panel = find<HTMLElement>(
					'[role="dialog"][aria-label="书籍信息"]',
				);
				await h.until(
					() =>
						getComputedStyle(panel).opacity === "1" &&
						[panel, find(".reader-r1")].every((node) =>
							node
								.getAnimations()
								.every((animation) => animation.playState === "finished"),
						),
					"Preview must wait for Reader and information panel entrance motion",
				);
			}
			return `app theme preview ${entry}, ${controller.getSnapshot().mode}, ${innerWidth}px`;
		}
		check(
			requests === 0,
			"Appearance settings must work without backend configuration requests",
		);
		check(
			document.documentElement.dataset.theme === initialSystem,
			"Default system preference must match real emulated media",
		);
		for (const value of ["dark", "light"] as const) {
			await mode(value);
			check(
				localStorage.getItem(THEME_STORAGE_KEY) === value,
				"Explicit selection must persist",
			);
			contrast(".settings-row-copy strong", `appearance ${value}`);
			contrast(".settings-control", `appearance form ${value}`);
			contrast(".settings-hint", `appearance note ${value}`);
			layout(".settings-group");
			layout(".settings-control");
		}
		peer = document.createElement("iframe");
		peer.hidden = true;
		document.body.append(peer);
		const peerDoc = peer.contentDocument;
		check(peerDoc, "Same-origin peer unavailable");
		const script = peerDoc.createElement("script");
		script.type = "module";
		script.textContent = `import {startAppTheme} from '${location.origin}/src/theme/browser.ts'; const theme=startAppTheme(); window.peerTheme=theme; document.documentElement.dataset.ready='true';`;
		peerDoc.body.append(script);
		await h.until(
			() => peerDoc.documentElement.dataset.ready === "true",
			"Independent tab theme must initialize from saved light preference",
		);
		check(
			peerDoc.documentElement.dataset.theme === "light",
			"New tab must restore persisted preference",
		);
		await mode("dark");
		await h.until(
			() => peerDoc.documentElement.dataset.theme === "dark",
			"Actual storage event must update another tab",
		);
		peer.contentWindow?.localStorage.setItem(THEME_STORAGE_KEY, "light");
		await h.until(
			() =>
				controller.getSnapshot().preference === "light" &&
				find<HTMLSelectElement>(".settings-control").value === "light",
			"Actual remote tab storage must update app and settings control",
		);
		const system = (
			window as unknown as {
				browserTheme?: (value: ThemeMode) => Promise<void>;
			}
		).browserTheme;
		check(system, "Runner must install real system-media CDP binding");
		await mode("system");
		for (const next of ["dark", "light"] as const) {
			await system(next);
			await h.until(
				() =>
					matchMedia("(prefers-color-scheme: dark)").matches ===
						(next === "dark") && controller.getSnapshot().mode === next,
				`System change must apply ${next}`,
			);
		}
		await mode("dark");
		await system("light");
		check(
			controller.getSnapshot().mode === "dark",
			"Explicit mode must ignore subsequent system changes",
		);
		completed.push(
			"settings persistence, independent tab restoration/storage sync, real media changes and explicit override",
		);
		for (const theme of ["light", "dark"] as const) {
			controller.select(theme);
			await go("/materials", ".book-title");
			contrast(".book-title", `catalog title ${theme}`);
			contrast(".app-navigation a", `navigation ${theme}`);
			if (innerWidth <= 720) {
				find<HTMLButtonElement>('button[aria-label="打开主导航"]').click();
				await h.until(
					() => !!h.container.querySelector(".navigation-drawer[open]"),
					"Mobile navigation must open",
				);
				contrast(
					".navigation-drawer .app-navigation a",
					`mobile navigation ${theme}`,
				);
				layout(".navigation-drawer");
				find<HTMLButtonElement>(
					".navigation-drawer [data-dialog-cancel]",
				).click();
			}

			layout(".library-toolbar");
			find<HTMLButtonElement>('button[aria-label="添加书籍"]').click();
			await h.until(
				() => !!h.container.querySelector(".import-dialog[open]"),
				"Real catalog import dialog must open",
			);
			contrast(".import-dialog h2", `dialog ${theme}`);
			contrast(".import-dialog .field", `dialog form ${theme}`);
			layout(".import-dialog");
			find<HTMLButtonElement>(
				'.import-dialog button[type="button"].secondary',
			).click();
			await go("/sources/source", ".s2-source-heading h1");
			contrast(".s2-source-heading h1", `source ${theme}`);
			layout(".source-detail-content");
			await go("/materials/book/details", ".book-details-content h1");
			await h.until(
				() =>
					!!h.container.querySelector(".book-statistics-error .inline-error"),
				"Statistics error must settle",
			);
			contrast(".book-details-content h1", `book detail ${theme}`);
			contrast(".book-details-action.primary", `filled action ${theme}`);
			contrast(".book-statistics-error .inline-error", `error ${theme}`);
			layout(".book-details");
			await go("/settings?section=providers", ".provider-service-main strong");
			contrast(".provider-service-main strong", `provider ${theme}`);
			layout(".provider-service-list");
			find<HTMLButtonElement>("#provider-open-provider").click();
			await h.until(
				() => !!h.container.querySelector(".provider-detail-dialog[open]"),
				"Provider detail must open",
			);
			contrast(".provider-detail-dialog h2", `provider dialog ${theme}`);
			layout(".provider-detail-dialog");
			find<HTMLButtonElement>('button[aria-label="关闭服务详情"]').click();
			await go("/segments/segment?analysis=analysis", ".analysis-document");
			contrast(".segment-original-focus", `original ${theme}`);
			contrast(
				".analysis-document-title h1,.analysis-document-title h2",
				`analysis ${theme}`,
			);
			layout(".segment-workspace");
			await go(
				"/segments/segment?analysis=analysis&thread=thread&chat=1",
				".chat-composer textarea",
			);
			contrast(".chat-composer textarea", `discussion form ${theme}`);
			layout(".chat-composer");
			completed.push(
				`${theme} catalog, source, details/error, provider/dialog, segment/analysis/discussion contrast and layout`,
			);
		}
		await go("/materials/book", ".reader-r1");
		await h.until(
			() =>
				!!h.container
					.querySelector<HTMLIFrameElement>(".reader-r1 iframe")
					?.contentDocument?.querySelector("[data-locator-leaf]"),
			"Real Reader frame must load",
		);
		for (const appMode of ["dark", "light"] as const) {
			controller.select(appMode);
			check(
				find(".reader-r1").getAttribute("data-theme") === "white",
				"App selection must not override explicit Reader paper theme",
			);
			check(
				localStorage.getItem(READER_UI_KEY) === readerPreference,
				"App selection must not write Reader preference",
			);
		}
		completed.push(
			"real Reader retains explicit white paper and independent persisted preference",
		);
		if (params.has("capture")) {
			controller.select(initialSystem);
			await go(defaultPath, 'select[aria-label="应用颜色模式"]');
		}
		check(failures.length === 0, failures.join("\n"));
		return `app theme ${innerWidth}px / initial system ${initialSystem}: ${completed.join("; ")}; minimum sampled text contrast ${minimum.toFixed(2)}:1`;
	} catch (error) {
		throw new Error(
			failures.length && !String(error).includes(failures[0] ?? "")
				? `${String(error)}\n${failures.join("\n")}`
				: String(error),
		);
	} finally {
		peer?.remove();
		if (!preview && !params.has("capture")) dispose();
	}
}
