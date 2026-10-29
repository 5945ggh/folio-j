import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];
const timestamp = "2026-10-25T00:00:00Z";
const hash = "a".repeat(64);
const text = "春の風が、静かな庭を通り抜ける。";
const catalogEntry = "/materials?type=book&q=garden&sort=title&order=asc";
const book: Schema["MaterialCatalogItem"] = {
	id: "route-motion",
	version_id: "v1",
	contract_version: "1",
	type: "book",
	title: "春の庭",
	source_id: "source",
	source_title: "回归书架",
	cover_url: null,
	created_at: timestamp,
	last_opened_at: null,
	status: "not_started",
	usage_revision: 0,
	product_sha256: hash,
	source_sha256: hash,
	warnings: [],
};
const material: Schema["MaterialResponse"] = {
	...book,
	chapters: [{ id: "chapter", title: "第一章", level: 0, part_count: 1 }],
	reading_position: null,
};
const chapter: Schema["MaterialChapterResponse"] = {
	id: "chapter",
	material_id: book.id,
	version_id: book.version_id,
	title: "第一章",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
			href: "chapter.xhtml",
			css: "",
			html_attributes: { lang: "ja" },
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
			html: `<p><span data-locator-leaf="0">${text}</span></p>`,
		},
	],
};

/** Shared production data routes and real pages; only API data is a fixture. */
export async function routeMotion(h: BrowserHarness, preview = false) {
	const check: BrowserHarness["check"] = h.check;
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
		originalWarn(...args);
	};
	const { App, appRoutes } = await import("../src/App");
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	let releaseMaterial: (() => void) | undefined;
	let materialGate = Promise.resolve();
	let releaseChapter: (() => void) | undefined;
	let chapterGate = Promise.resolve();
	let materialFailure = false;
	let chapterFailure = false;
	const gateMaterial = () => {
		materialGate = new Promise<void>((resolve) => {
			releaseMaterial = resolve;
		});
	};
	const base = `/api/materials/${book.id}`;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/api/sources")
			return Response.json([]);
		if (request.method === "GET" && path === "/api/materials")
			return Response.json({
				items: [book, { ...book, id: "other", title: "隣の本" }],
				page: 1,
				page_size: 50,
				total: 2,
			});
		if (request.method === "GET" && path === base) {
			await materialGate;
			return materialFailure
				? Response.json({ detail: "书籍打开失败" }, { status: 500 })
				: Response.json(material);
		}
		if (request.method === "GET" && path === `${base}/details`)
			return Response.json({
				...book,
				chapter_count: 1,
				custom_cover: false,
				metadata_revision: 0,
				original_title: book.title,
			} satisfies Schema["MaterialDetailsResponse"]);
		if (request.method === "GET" && path === `${base}/statistics`)
			return Response.json({
				material_id: book.id,
				version_id: book.version_id,
				generation_id: null,
				analysis_configuration: null,
				scope: "unique_resources",
				lexical: null,
				text: {
					character_count: text.length,
					resource_count: 1,
					unique_kanji_count: 6,
					singleton_kanji_count: 6,
					rule_version: "text-statistics-v1",
					unicode_version: "16.0",
				},
			} satisfies Schema["MaterialStatisticsResponse"]);
		if (request.method === "GET" && path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: book.source_title,
				description: "",
				note: "",
				segment_count: 0,
				created_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["SourceResponse"]);
		if (request.method === "POST" && path === `${base}/readings/prepare`)
			return Response.json({
				material_id: book.id,
				version_id: book.version_id,
				generation_id: "generation",
				token_count: 0,
			} satisfies Schema["MaterialReadingsSummary"]);
		if (request.method === "GET" && path === `${base}/readings`)
			return Response.json({
				material_id: book.id,
				version_id: book.version_id,
				generation_id: "generation",
				resources: [{ resource_id: "r", text_sha256: hash, tokens: [] }],
			} satisfies Schema["MaterialReadingsResponse"]);
		if (request.method === "GET" && path === `${base}/chapters/chapter`) {
			await chapterGate;
			return chapterFailure
				? Response.json({ detail: "章节打开失败" }, { status: 500 })
				: Response.json(chapter);
		}
		if (
			(request.method === "GET" && path === `${base}/usage`) ||
			(request.method === "POST" && path === `${base}/opened`)
		)
			return Response.json({
				material_id: book.id,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["MaterialUsageResponse"]);
		if (request.method === "PUT" && path === `${base}/reading-position`) {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			return Response.json({
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: timestamp,
			} satisfies Schema["ReadingPositionResponse"]);
		}
		if (
			request.method === "GET" &&
			(path === `${base}/chapters/chapter/segments` ||
				path === `${base}/chapters/chapter/translations`)
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (request.method === "GET" && path === `${base}/translations`)
			return Response.json({ results: [], tasks: [], next_offset: null });
		throw new Error(`Unmocked route motion request ${request.method} ${path}`);
	});
	let dispose = await h.mount(<App />, "/", catalogEntry, appRoutes);
	const link = (selector: string) => {
		const found = h.container.querySelector<HTMLAnchorElement>(selector);
		check(found, `Missing route entry ${selector}`);
		return found;
	};
	const card = () => link(`.book-main-link[href="/materials/${book.id}"]`);
	const frame = () =>
		h.container.querySelector<HTMLIFrameElement>("iframe.material-part");
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const tick = () =>
		new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	const pending = () =>
		h.container.querySelector<HTMLElement>(
			".reader-loading.reader-pending-message, .reader-loading .reader-pending-message",
		);
	const delayedMessage = async (message: HTMLElement, label: string) => {
		check(
			message.getAttribute("role") === "status",
			`${label} must announce status`,
		);
		const animation = message
			.getAnimations()
			.find((item) =>
				(item.effect as KeyframeEffect | null)
					?.getKeyframes()
					.some((frame) => "visibility" in frame),
			);
		check(animation, `${label} must delay its loading text reveal`);
		const timing = animation.effect?.getComputedTiming();
		check(
			timing && Number(timing.delay) > 0 && Number(timing.endTime) <= 500,
			`${label} must briefly defer loading text without a long wait`,
		);
		// Seek the production effect so a busy machine cannot miss its hidden state.
		animation.pause();
		animation.currentTime = 0;
		check(
			getComputedStyle(message).visibility === "hidden",
			`${label} must initially remain hidden`,
		);
		animation.currentTime = Number(timing.endTime);
		check(
			getComputedStyle(message).visibility === "visible",
			`${label} must reveal while its request is still held`,
		);
		animation.finish();
	};
	const readerReady = async () => {
		await h.until(
			() =>
				!!h.container.querySelector('main.reader-r1[data-presented="true"]') &&
				!!frame()?.contentDocument?.body?.textContent?.includes(text),
			"Real reader must present its iframe and resolved location",
		);
	};
	const entryMotion = async (label: string) => {
		const main = h.container.querySelector<HTMLElement>(
			'main.reader-r1[data-presented="true"]',
		);
		const heading = main?.querySelector<HTMLElement>(".reader-heading");
		const viewport = main?.querySelector<HTMLElement>(".reader-viewport");
		const iframe = frame();
		const source = iframe?.contentDocument?.querySelector<HTMLElement>(
			"[data-locator-leaf]",
		);
		check(
			main && heading && viewport && iframe && source,
			`${label} needs actual presented source geometry`,
		);
		check(
			!pending(),
			`${label} must remove loading as soon as content is ready`,
		);
		if (reduced) {
			check(
				main.getAnimations().length === 0 &&
					heading.getAnimations().length === 0,
				"Reduced motion must suppress page and title entry",
			);
			return;
		}
		const animation = (element: HTMLElement, property: string) => {
			const found = element
				.getAnimations()
				.find((item) =>
					(item.effect as KeyframeEffect | null)
						?.getKeyframes()
						.some((frame) => property in frame),
				);
			check(found, `${label} must animate ${property} on its presented DOM`);
			const timing = found.effect?.getComputedTiming();
			check(
				timing &&
					timing.delay === 0 &&
					Number(timing.endTime) > 0 &&
					Number(timing.endTime) <= 1000,
				`${label} entry must start immediately and finish promptly`,
			);
			found.pause();
			return { effect: found, end: Number(timing.endTime) };
		};
		const page = animation(main, "opacity");
		const title = animation(heading, "transform");
		const rectangles = () =>
			[main, viewport, iframe, source].map((element) => {
				const rect = element.getBoundingClientRect();
				return [rect.x, rect.y, rect.width, rect.height];
			});
		page.effect.currentTime = 0;
		title.effect.currentTime = 0;
		const before = rectangles();
		const viewportTransform = getComputedStyle(viewport).transform;
		const initialPageOpacity = Number(getComputedStyle(main).opacity);
		const initialTitleOpacity = Number(getComputedStyle(heading).opacity);
		const initialTitleY = new DOMMatrixReadOnly(
			getComputedStyle(heading).transform,
		).m42;
		check(
			initialPageOpacity >= 0.5 &&
				initialPageOpacity < 1 &&
				initialTitleOpacity >= 0.5 &&
				initialTitleOpacity < 1,
			"Page and title must begin with a light visible fade",
		);
		check(
			initialTitleY > 0 && initialTitleY <= 24,
			"Title must begin a small distance below its layout position",
		);
		for (const progress of [0.5, 1]) {
			page.effect.currentTime = page.end * progress;
			title.effect.currentTime = title.end * progress;
			await tick();
			if (progress < 1) {
				const opacity = Number(getComputedStyle(main).opacity);
				const titleOpacity = Number(getComputedStyle(heading).opacity);
				const titleY = new DOMMatrixReadOnly(
					getComputedStyle(heading).transform,
				).m42;
				check(
					opacity > initialPageOpacity &&
						opacity < 1 &&
						titleOpacity > initialTitleOpacity &&
						titleOpacity < 1 &&
						titleY > 0 &&
						titleY < initialTitleY,
					"Seeking entry must expose an actual intermediate fade and title movement",
				);
			}
			check(
				rectangles().every((rect, index) =>
					rect.every(
						(value, axis) =>
							Math.abs(value - (before[index]?.[axis] ?? Number.NaN)) <= 0.1,
					),
				),
				"Page, reading viewport, iframe and source rects must stay fixed throughout entry",
			);
			check(
				getComputedStyle(main).transform === "none" &&
					getComputedStyle(viewport).transform === viewportTransform,
				"Entry must leave the source root and existing viewport centering transform unchanged",
			);
		}
		check(
			getComputedStyle(main).opacity === "1" &&
				getComputedStyle(heading).opacity === "1",
			"Entry must finish fully opaque",
		);
		check(
			getComputedStyle(heading).transform === "none" ||
				new DOMMatrixReadOnly(getComputedStyle(heading).transform).m42 === 0,
			"Title must finish at its layout position",
		);
		page.effect.finish();
		title.effect.finish();
	};
	const plainReturn = async (selector: string, destination: string) => {
		const back = link(selector);
		check(
			back.getAttribute("href") === destination,
			`Return must preserve ${destination}`,
		);
		back.click();
		await h.until(
			() => !back.isConnected,
			"Return must unmount its outgoing page",
		);
	};
	const freshCatalog = async () => {
		dispose();
		materialGate = Promise.resolve();
		chapterGate = Promise.resolve();
		dispose = await h.mount(<App />, "/", catalogEntry, appRoutes);
		await h.until(
			() => !!h.container.querySelector(".book-card"),
			"Fresh catalog must mount",
		);
	};
	const instantError = async (label: string) => {
		await h.until(
			() => !!h.container.querySelector('.reader-loading [role="alert"]'),
			`${label} must appear without completing an entry animation`,
		);
		const error = h.container.querySelector<HTMLElement>(
			'.reader-loading [role="alert"]',
		);
		check(
			error &&
				getComputedStyle(error).visibility === "visible" &&
				!error.closest(".reader-pending-message"),
			`${label} must be immediately visible outside delayed loading text`,
		);
		check(
			error.getAnimations().length === 0,
			`${label} must not inherit the loading delay`,
		);
	};
	// Capture entry at its first rendered frame so a busy machine cannot consume
	// a short animation before readerReady observes the presented DOM.
	const holdEntry = (event: AnimationEvent) => {
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			target.matches('main.reader-r1[data-presented="true"], .reader-heading')
		)
			for (const effect of target.getAnimations()) effect.pause();
	};
	if (!preview) h.container.addEventListener("animationstart", holdEntry);
	try {
		await h.until(
			() => !!h.container.querySelector(".book-card"),
			"Catalog must mount",
		);
		if (preview)
			return "route motion preview: real book card/details → reader; local API fixtures, presented DOM entry and brief loading text delay";
		// A slow book request and then a slow chapter exercise both real loading surfaces.
		gateMaterial();
		chapterGate = new Promise<void>((resolve) => {
			releaseChapter = resolve;
		});
		card().click();
		await h.until(
			() => !!pending(),
			"Book opening must expose delayed status text",
		);
		await delayedMessage(pending() as HTMLElement, "Book loading");
		check(!frame(), "Held material request must not create source prematurely");
		releaseMaterial?.();
		await h.until(
			() => !!pending()?.matches("div"),
			"Chapter request must expose its delayed status",
		);
		await delayedMessage(pending() as HTMLElement, "Chapter loading");
		const loadingMain = h.container.querySelector("main.reader-r1");
		check(
			loadingMain?.getAttribute("data-presented") === "false",
			"Entry must wait for completed iframe/location presentation",
		);
		check(
			!loadingMain?.getAnimations().length,
			"Pending source must not consume the entry animation",
		);
		releaseChapter?.();
		await readerReady();
		await entryMotion("Book card");
		await plainReturn('.reader-r1 a[aria-label="返回素材库"]', catalogEntry);
		await h.until(
			() => !!h.container.querySelector(".book-card"),
			"Catalog must return",
		);
		const trigger =
			h.container.querySelector<HTMLButtonElement>(".book-menu-trigger");
		check(trigger, "Card menu must exist");
		trigger.click();
		await h.until(
			() => !!h.container.querySelector(".book-menu:popover-open"),
			"Real card menu must open",
		);
		const details = [
			...h.container.querySelectorAll<HTMLButtonElement>(".book-menu button"),
		].find((item) => item.textContent?.trim() === "书籍详情");
		check(details, "Real card menu must expose book details");
		details.click();
		await h.until(
			() => !!h.container.querySelector(".book-details-cover"),
			"Real details must load",
		);
		// All data is cached: presentation remains available while its entry animates.
		link("a.book-details-action.primary").click();
		await readerReady();
		await entryMotion("Cached details reading link");
		await plainReturn(
			'.reader-r1 a[aria-label="返回书籍详情"]',
			`/materials/${book.id}/details`,
		);
		await h.until(
			() => !!h.container.querySelector(".book-details-back"),
			"Details must return",
		);
		await plainReturn(".book-details-back", catalogEntry);
		await freshCatalog();
		// Fresh immediate API responses also present while entry effects are available.
		card().click();
		await readerReady();
		await entryMotion("Fresh fast card");
		await freshCatalog();
		materialFailure = true;
		card().click();
		await instantError("Book opening error");
		materialFailure = false;
		await freshCatalog();
		chapterFailure = true;
		card().click();
		await instantError("Chapter opening error");
		check(
			warnings.length === 0,
			`Shared App routes must not emit warnings: ${warnings.join("\n")}`,
		);
		return `route motion ${innerWidth}px${reduced ? " reduced motion" : ""}: real card/details and fast/cached presentation, light page/title entry, fixed source geometry, both brief loading delays, immediate errors and nested returns/query preservation`;
	} finally {
		h.container.removeEventListener("animationstart", holdEntry);
		console.warn = originalWarn;
		releaseMaterial?.();
		releaseChapter?.();
		if (!preview) dispose();
	}
}
