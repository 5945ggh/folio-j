import { StrictMode } from "react";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];
const timestamp = "2026-10-27T00:00:00Z";
const hash = "a".repeat(64);
const canvas = document.createElement("canvas");
canvas.width = 600;
canvas.height = 800;
const context = canvas.getContext("2d");
if (!context) throw new Error("Missing image fixture canvas");
context.fillStyle = "#e9ddca";
context.fillRect(0, 0, 600, 800);
context.fillStyle = "#527d9b";
context.fillRect(60, 90, 480, 620);
const image = canvas.toDataURL("image/png");
const text = "春の風。".repeat(200);
const chapter: Schema["MaterialChapterResponse"] = {
	id: "chapter",
	material_id: "image-book",
	version_id: "v1",
	title: "第一章",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
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
			end: text.length,
			leaf_start: 0,
			leaf_end: 1,
			html: `<p><span data-locator-leaf="0">${text}</span></p><img data-epub-image="45" src="${image}" alt="原文插图">`,
		},
	],
};
export async function readerImages(h: BrowserHarness) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const check: BrowserHarness["check"] = h.check;
	const { container, until, mount, mock } = h;
	const measurement =
		new URLSearchParams(location.search).get("suite") ===
		"reader-image-performance";
	const vertical =
		new URLSearchParams(location.search).get("direction") === "vertical-rl";
	const settings: Schema["ReadingSettings"] = {
		font_size: 22,
		line_height: 2,
		writing_mode: vertical ? "vertical-rl" : "horizontal-tb",
	};
	const book: Schema["MaterialResponse"] = {
		id: "image-book",
		source_id: "source",
		title: "图片测试",
		version_id: "v1",
		contract_version: "1",
		product_sha256: hash,
		source_sha256: hash,
		created_at: timestamp,
		warnings: [],
		chapters: [{ id: "chapter", title: "第一章", level: 0, part_count: 1 }],
		reading_position: {
			chapter_id: "chapter",
			resource_id: "r",
			version_id: "v1",
			part_index: 0,
			kind: "text",
			offset: 0,
			at_chapter_end: false,
			progress: 0,
			revision: 0,
			updated_at: timestamp,
			settings,
		},
	};
	const usage: Schema["MaterialUsageResponse"] = {
		material_id: book.id,
		status: "in_progress",
		revision: 1,
		last_opened_at: timestamp,
		updated_at: timestamp,
	};
	const items = Array.from({ length: 50 }, (_, ordinal) => ({
		ordinal,
		chapter_id: "chapter",
		chapter_title: "第一章",
		part_index: 0,
		spine_index: 0,
		resource_id: "r",
		image_id: ordinal,
		alt: `图片 ${ordinal}`,
		content_url: `/browser-tests/reader-image-fixture.png?image=${ordinal}`,
	}));
	let opened = false;
	let holdLookup = !measurement;
	let failLookup = false;
	let illustrationRequests = 0;
	let imageRequests = 0;
	const imageRequestCounts = new Map<string, number>();
	let releaseLookup: (() => void) | undefined;
	mock(async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === `/api/materials/${book.id}`) return Response.json(book);
		if (path.endsWith("/opened")) opened = true;
		if (path.endsWith("/opened") || path.endsWith("/usage"))
			return Response.json(usage);
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "Source",
				description: "",
				note: "",
				segment_count: 0,
				created_at: timestamp,
				updated_at: timestamp,
			});
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "g",
				token_count: 0,
			});
		if (path.endsWith("/readings"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "g",
				resources: [],
			});
		if (path.endsWith("/translations"))
			return Response.json(
				path.includes("/chapters/")
					? { items: [], next_cursor: null, unavailable_count: 0 }
					: { results: [], tasks: [], next_offset: null },
			);
		if (path.endsWith("/segments"))
			return Response.json({ items: [], next_cursor: null });
		if (path.endsWith("/chapters/chapter")) return Response.json(chapter);
		if (
			path.endsWith("/illustrations") ||
			path.endsWith("/illustrations/locate")
		) {
			illustrationRequests++;
			if (measurement) await new Promise((resolve) => setTimeout(resolve, 150));
			if (holdLookup)
				await new Promise<void>((resolve) => {
					releaseLookup = resolve;
				});
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const limit = Number(url.searchParams.get("limit") ?? 40);
			if (path.endsWith("/locate")) {
				if (failLookup) return new Response(null, { status: 500 });
				const found = items.find(
					(item) =>
						item.chapter_id === url.searchParams.get("chapter_id") &&
						item.part_index === Number(url.searchParams.get("part_index")) &&
						item.image_id === Number(url.searchParams.get("image_id")),
				);
				if (!found) return new Response(null, { status: 404 });
				return Response.json({
					material_id: book.id,
					version_id: "v1",
					total: items.length,
					offset: found.ordinal,
					limit: 1,
					items: [found],
				});
			}
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				total: items.length,
				offset,
				limit,
				items: items.slice(offset, offset + limit),
			});
		}
		if (path.endsWith("/reader-image-fixture.png")) {
			imageRequests++;
			const identity = url.searchParams.get("image") ?? "";
			imageRequestCounts.set(
				identity,
				(imageRequestCounts.get(identity) ?? 0) + 1,
			);
			return new Response(
				Uint8Array.from(atob(image.split(",")[1] ?? ""), (x) =>
					x.charCodeAt(0),
				),
				{ headers: { "Content-Type": "image/png" } },
			);
		}
		if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			return Response.json({
				...update,
				progress: 0,
				revision: update.expected_revision + 1,
				updated_at: timestamp,
			});
		}
		throw new Error(`Unmocked ${request.method} ${path}`);
	});
	localStorage.clear();
	const dispose = await mount(
		new URLSearchParams(location.search).has("strict") ? (
			<StrictMode>
				<MaterialReader />
			</StrictMode>
		) : (
			<MaterialReader />
		),
		"/materials/:id",
		`/materials/${book.id}`,
	);
	const clipboardDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		"clipboard",
	);
	const originalAnchorClick = HTMLAnchorElement.prototype.click;
	const find = <T extends Element>(selector: string): T => {
		const node = container.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const button = (label: string) => {
		const node = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(b) =>
				b.textContent?.trim() === label ||
				b.getAttribute("aria-label") === label,
		);
		check(node, `Missing button ${label}`);
		return node;
	};
	const viewer = () =>
		container.querySelector<HTMLElement>(
			".reader-image-overlay:not([data-exiting='true'])",
		);
	try {
		await until(
			() =>
				opened &&
				!!container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector("img[data-epub-image]"),
			"Reader must be ready",
		);
		const frame = find<HTMLIFrameElement>("iframe.material-part");
		const viewport = find<HTMLElement>(".reader-viewport");
		const position = [viewport.scrollLeft, viewport.scrollTop];
		const open = () =>
			frame.contentDocument
				?.querySelector<HTMLImageElement>("img[data-epub-image]")
				?.click();
		if (measurement) {
			const rendered = () => {
				const img = viewer()?.querySelector<HTMLImageElement>(
					".reader-image-stage img",
				);
				return (
					!!img &&
					img.complete &&
					img.naturalWidth > 0 &&
					img.getClientRects().length > 0
				);
			};
			const measure = async (action: () => void, ready: () => boolean) => {
				const start = performance.now();
				const requests = illustrationRequests;
				const bytes = imageRequests;
				action();
				await until(ready, "Image must become visible");
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				return {
					ms: Math.round(performance.now() - start),
					requests: illustrationRequests - requests,
					imageRequests: imageRequests - bytes,
				};
			};
			const first = await measure(open, rendered);
			await until(
				() => !!viewer()?.textContent?.includes("插图 46 / 50"),
				"First lookup must finish before warm measurement",
			);
			viewer()
				?.querySelector<HTMLButtonElement>(".reader-panel-close")
				?.click();
			await until(() => !viewer(), "Close first view");
			const repeat = await measure(open, rendered);
			viewer()
				?.querySelector<HTMLButtonElement>(".reader-panel-close")
				?.click();
			await until(() => !viewer(), "Close repeated view");
			button("插图库").click();
			await until(
				() => !!container.querySelector('[data-illustration-ordinal="0"]'),
				"Gallery must load",
			);
			find<HTMLElement>(
				'[data-illustration-ordinal="0"] .reader-gallery-open',
			).click();
			await until(rendered, "Gallery image must load");
			const switching = await measure(
				() =>
					viewer()
						?.querySelector<HTMLButtonElement>('[aria-label="下一张插图"]')
						?.click(),
				() => {
					const img = viewer()?.querySelector<HTMLImageElement>(
						".reader-image-stage img",
					);
					return (
						!!img &&
						img.alt === "图片 1" &&
						img.complete &&
						img.naturalWidth > 0
					);
				},
			);
			const back = await measure(
				() =>
					viewer()
						?.querySelector<HTMLButtonElement>('[aria-label="上一张插图"]')
						?.click(),
				() => {
					const img = viewer()?.querySelector<HTMLImageElement>(
						".reader-image-stage img",
					);
					return (
						!!img &&
						img.alt === "图片 0" &&
						img.complete &&
						img.naturalWidth > 0
					);
				},
			);
			return `reader image performance (offline fixture, 150ms per illustration response, visible image plus 2 frames): ${JSON.stringify({ first, repeat, switching, back })}`;
		}
		if (!new URLSearchParams(location.search).has("preview")) {
			open();
			await until(
				() => !!viewer() && !!releaseLookup,
				"Lookup must be pending",
			);
			check(
				!!viewer()?.querySelector(".reader-image-stage img"),
				"Body image must render while lookup is pending",
			);
			button("关闭查看插图").click();
			await until(() => !viewer(), "Pending viewer must close immediately");
			holdLookup = false;
			releaseLookup?.();
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(!viewer(), "A late lookup must not reopen the viewer");
			failLookup = true;
			open();
			await until(
				() => !!viewer()?.textContent?.includes("无法定位该插图"),
				"Lookup error must be visible",
			);
			check(
				!!viewer()?.querySelector(".reader-image-stage img"),
				"Lookup failure must retain the already loaded image",
			);
			button("关闭查看插图").click();
			await until(() => !viewer(), "Close viewer after lookup failure");
			failLookup = false;
		} else holdLookup = false;
		open();
		await until(
			() => !!viewer()?.textContent?.includes("插图 46 / 50"),
			"Body image must open direct viewer",
		);
		if (new URLSearchParams(location.search).has("preview"))
			await new Promise<void>(() => {});
		check(
			!container.querySelector(".reader-gallery-grid"),
			"Body must not open gallery",
		);
		await until(
			() => !button("复制图片").disabled,
			"Image must load before copying",
		);
		let copied: Blob | undefined;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				write: async (values: ClipboardItem[]) => {
					copied = await values[0]?.getType("image/png");
				},
			},
		});
		button("复制图片").click();
		await until(
			() => viewer()?.textContent?.includes("图片已复制") === true,
			"Copy must report success",
		);
		check(
			copied?.type === "image/png",
			"Clipboard must receive PNG image data",
		);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				write: async () => {
					throw new Error("denied");
				},
			},
		});
		button("复制图片").click();
		await until(
			() => viewer()?.textContent?.includes("复制失败") === true,
			"Copy failure must be visible",
		);
		let downloaded = "";
		HTMLAnchorElement.prototype.click = function () {
			downloaded = this.download;
		};
		button("下载").click();
		await until(
			() => downloaded === "插图-46.png",
			"Download must use the original MIME extension",
		);
		button("放大").click();
		await until(
			() => viewer()?.textContent?.includes("125%") === true,
			"Zoom must update",
		);
		button("适合窗口").click();
		await until(
			() => viewer()?.textContent?.includes("100%") === true,
			"Fit must reset zoom",
		);
		button("关闭插图 46 / 50").click();
		await until(() => !viewer(), "One close returns to reading");
		check(
			!container.querySelector(".reader-gallery-grid"),
			"Direct close must not reveal gallery",
		);
		check(
			viewport.scrollLeft === position[0] && viewport.scrollTop === position[1],
			"Viewing must preserve reader position",
		);
		open();
		await until(
			() => !!viewer()?.textContent?.includes("插图 46 / 50"),
			"Body image must reopen",
		);
		button("上一张插图").click();
		await until(
			() => !!viewer()?.textContent?.includes("插图 45 / 50"),
			"Viewer must switch image",
		);
		button("在图库中查看").click();
		await until(
			() =>
				!!container.querySelector(
					'[data-illustration-ordinal="44"][data-selected="true"]',
				),
			"Gallery must highlight current occurrence on its page",
		);
		check(!viewer(), "Gallery transition closes direct viewer");
		await until(
			() => !!container.querySelector('[data-illustration-ordinal="45"] img'),
			"Previously read image must appear in the gallery",
		);
		check(
			!imageRequestCounts.get("45"),
			"Previously read image must reuse the trusted chapter source in the gallery",
		);
		const card = find<HTMLElement>('[data-illustration-ordinal="44"]');
		card.querySelector<HTMLButtonElement>(".reader-gallery-open")?.click();
		await until(
			() => !!viewer()?.textContent?.includes("插图 45 / 50"),
			"Gallery opens shared viewer",
		);
		button("关闭插图 45 / 50").click();
		await until(() => !viewer(), "Gallery viewer closes");
		check(
			!!container.querySelector('[data-illustration-ordinal="44"]'),
			"Gallery page remains after closing viewer",
		);
		button("上一页").click();
		await until(
			() => !!container.querySelector('[data-illustration-ordinal="0"]'),
			"Gallery must change page",
		);
		open();
		await until(
			() => !!viewer()?.textContent?.includes("插图 46 / 50"),
			"Body must open above an existing gallery",
		);
		viewer()
			?.querySelector<HTMLButtonElement>('[aria-label="上一张插图"]')
			?.click();
		await until(
			() =>
				!!viewer()?.textContent?.includes("插图 45 / 50") &&
				!![
					...(viewer()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
				].find((node) => node.textContent === "在图库中查看" && !node.disabled),
			"Switched image must load",
		);
		[...(viewer()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
			.find((node) => node.textContent === "在图库中查看")
			?.click();
		await until(
			() =>
				!!container.querySelector(
					'[data-illustration-ordinal="44"][data-selected="true"]',
				),
			"Repeated gallery location must return to the requested occurrence",
		);
		button("关闭插图库").click();
		await until(
			() => !container.querySelector(".reader-gallery-grid"),
			"Gallery closes",
		);
		open();
		await until(() => !!viewer(), "Body opens after gallery close");
		viewer()
			?.querySelector<HTMLButtonElement>(".reader-panel-close")
			?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		await until(() => !viewer(), "Escape closes body viewer");
		const originalImage =
			frame.contentDocument?.querySelector<HTMLImageElement>(
				"img[data-epub-image]",
			);
		check(originalImage, "Original image must remain in the chapter");
		originalImage.setAttribute("src", "data:image/png;base64,aGVsbG8=");
		originalImage.setAttribute("data-epub-image", "0");
		originalImage.click();
		await until(
			() =>
				!!viewer()?.querySelector<HTMLImageElement>(".reader-image-stage img"),
			"Original image should open after DOM mutation",
		);
		check(
			viewer()
				?.querySelector<HTMLImageElement>(".reader-image-stage img")
				?.getAttribute("src") === image,
			"Viewer must use the trusted chapter source, not mutated DOM attributes",
		);
		return "reader images: direct close and Escape, unchanged reading position, zoom, current occurrence in gallery, gallery return";
	} finally {
		HTMLAnchorElement.prototype.click = originalAnchorClick;
		if (clipboardDescriptor)
			Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else Reflect.deleteProperty(navigator, "clipboard");
		dispose();
	}
}
