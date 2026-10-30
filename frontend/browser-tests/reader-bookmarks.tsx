import type { ReactNode } from "react";
import type { components } from "../src/api/schema";
import { FOCUS_TIMING } from "../src/materials/focus";

type Schema = components["schemas"];
type Harness = {
	container: HTMLElement;
	check: (condition: unknown, message: string) => asserts condition;
	until: (predicate: () => boolean, message: string) => Promise<void>;
	inputValue: (
		input: HTMLInputElement | HTMLTextAreaElement,
		value: string,
	) => void;
	mount: (
		content: ReactNode,
		path?: string,
		initialEntry?: string,
	) => Promise<() => void>;
	mock: (handler: (request: Request) => Promise<Response>) => void;
};
const timestamp = "2026-10-23T00:00:00Z";
const hash = "a".repeat(64);
const paragraphs = Array.from(
	{ length: 80 },
	(_, i) =>
		`第${String(i).padStart(2, "0")}段落。春の風が静かな庭を通り抜ける。`,
);
const text = paragraphs.join("");
const chapter = (
	id: string,
	tail: boolean,
): Schema["MaterialChapterResponse"] => ({
	id,
	material_id: "bookmark-book",
	version_id: "version",
	title: id,
	level: 0,
	resources: [
		{
			id: "resource",
			text,
			text_sha256: hash,
			href: "chapter.xhtml",
			css: tail ? "p { margin: 0; }" : "",
			html_attributes: {},
			body_attributes: {},
		},
	],
	parts: [
		{
			resource_id: "resource",
			spine_index: 0,
			start: 0,
			end: text.length,
			leaf_start: 0,
			leaf_end: paragraphs.length,
			html: paragraphs
				.map(
					(value, i) => `<p><span data-locator-leaf="${i}">${value}</span></p>`,
				)
				.join(""),
		},
	],
});
const marks: Schema["MaterialChapterSegment"][] = [
	["single-a", 1],
	["single-b", 4],
	["group-a", 7],
	["group-b", 7],
	["tail", 79],
].map(([id, index]) => {
	const paragraph = Number(index);
	const start = paragraphs.slice(0, paragraph).join("").length;
	const exact = paragraphs[paragraph] ?? "";
	return {
		segment_id: String(id),
		excerpt: exact,
		created_at: timestamp,
		material_provenance: {
			contract_version: "1",
			material_id: "bookmark-book",
			version_id: "version",
			ranges: [
				{
					resource_id: "resource",
					spine_index: 0,
					start,
					end: start + exact.length,
					exact,
					text_sha256: hash,
					prefix: "",
					suffix: "",
				},
			],
		},
	};
});

export async function readerBookmarks(harness: Harness, narrow = false) {
	// Import only after the entry point installs its strict offline fetch mock.
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const { container, until, mount, mock, inputValue } = harness;
	const check: Harness["check"] = harness.check;
	const find = <T extends Element>(selector: string): T => {
		const node = container.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const buttons = () => [
		...container.querySelectorAll<HTMLButtonElement>(".reader-study-margin"),
	];
	const preview = () => container.querySelector(".reader-study-preview");
	const click = (label: string) =>
		find<HTMLButtonElement>(`button[aria-label="${label}"]`).click();
	const results: string[] = [];
	const scenarios = narrow
		? [{ writing_mode: "horizontal-tb" as const, tail: false }]
		: (["horizontal-tb", "vertical-rl"] as const).flatMap((writing_mode) => [
				{ writing_mode, tail: false },
				{ writing_mode, tail: true },
			]);
	for (const { writing_mode, tail } of scenarios) {
		localStorage.clear();
		localStorage.setItem(
			"folio-reader-ui-v1",
			JSON.stringify({ focus: false }),
		);
		const settings: Schema["ReadingSettings"] = {
			font_size: 22,
			line_height: 2,
			writing_mode,
		};
		const book: Schema["MaterialResponse"] = {
			id: "bookmark-book",
			source_id: "source",
			title: "書籤回帰",
			version_id: "version",
			contract_version: "1",
			product_sha256: hash,
			source_sha256: hash,
			created_at: timestamp,
			warnings: [],
			chapters: ["chapter-one", "chapter-two"].map((id) => ({
				id,
				title: id,
				level: 0,
				part_count: 1,
			})),
			reading_position: {
				chapter_id: "chapter-one",
				resource_id: "resource",
				version_id: "version",
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
		let opened = false;
		let positionSaved = false;
		mock(async (request) => {
			const { pathname } = new URL(request.url);
			if (request.method === "GET" && pathname === `/api/materials/${book.id}`)
				return Response.json(book);
			if (
				request.method === "GET" &&
				pathname === `/api/materials/${book.id}/translations`
			)
				return Response.json({ results: [], tasks: [], next_offset: null });
			if (pathname === `/api/materials/${book.id}/opened`) opened = true;
			if (
				pathname === `/api/materials/${book.id}/usage` ||
				pathname === `/api/materials/${book.id}/opened`
			)
				return Response.json(usage);
			if (pathname === "/api/sources/source")
				return Response.json({
					id: "source",
					title: "Source",
					description: "",
					note: "",
					segment_count: 4,
					created_at: timestamp,
					updated_at: timestamp,
				} satisfies Schema["SourceResponse"]);
			if (pathname.endsWith("/readings/prepare"))
				return Response.json({
					material_id: book.id,
					version_id: "version",
					generation_id: "generation",
					token_count: 0,
				} satisfies Schema["MaterialReadingsSummary"]);
			if (pathname.endsWith("/readings"))
				return Response.json({
					material_id: book.id,
					version_id: "version",
					generation_id: "generation",
					resources: [],
				} satisfies Schema["MaterialReadingsResponse"]);
			for (const id of ["chapter-one", "chapter-two"]) {
				if (
					pathname === `/api/materials/${book.id}/chapters/${id}/translations`
				)
					return Response.json({
						items: [],
						next_cursor: null,
						unavailable_count: 0,
					});
				if (pathname === `/api/materials/${book.id}/chapters/${id}`)
					return Response.json(chapter(id, tail));
				if (pathname === `/api/materials/${book.id}/chapters/${id}/segments`)
					return Response.json({
						items:
							id === "chapter-one"
								? tail
									? marks.slice(-1)
									: marks.slice(0, -1)
								: [],
						next_cursor: null,
						unavailable_count: 0,
					} satisfies Schema["MaterialChapterSegmentsResponse"]);
			}
			if (pathname.endsWith("/reading-position") && request.method === "PUT") {
				positionSaved = true;
				const update: Schema["ReadingPositionUpdate"] = await request.json();
				return Response.json({
					...update,
					progress: 0,
					revision: update.expected_revision + 1,
					updated_at: timestamp,
				} satisfies Schema["ReadingPositionResponse"]);
			}
			const mark = marks.find(
				(item) => pathname === `/api/segments/${item.segment_id}`,
			);
			if (mark)
				return Response.json({
					id: mark.segment_id,
					source_id: "source",
					text: mark.excerpt,
					translation: "",
					transcription: "",
					context_before: "",
					context_after: "",
					note: "",
					source_ref: "",
					revision: 0,
					text_sha256: hash,
					text_locked_at: null,
					created_at: timestamp,
					updated_at: timestamp,
				} satisfies Schema["SegmentResponse"]);
			if (
				marks.some(
					(item) => pathname === `/api/segments/${item.segment_id}/analyses`,
				)
			)
				return Response.json([]);
			throw new Error(`Unmocked reader request ${request.method} ${pathname}`);
		});
		const dispose = await mount(
			<MaterialReader />,
			"/materials/:id",
			`/materials/${book.id}`,
		);
		try {
			if (narrow) {
				await until(() => opened, "Narrow reader must finish presenting");
				const frame = find<HTMLIFrameElement>("iframe.material-part");
				check(
					buttons().length === 0,
					"Narrow horizontal reader must hide margin bookmarks",
				);
				check(
					Math.abs(
						frame.getBoundingClientRect().width - (window.innerWidth - 36),
					) < 1,
					"Narrow reader must retain its full body width with 18px outer gutters",
				);
				results.push(
					"narrow horizontal: hidden bookmarks preserve full text width",
				);
				continue;
			}

			if (tail) {
				await until(
					() => opened && positionSaved && buttons().length === 1,
					`${writing_mode}: tail bookmark must load`,
				);
				const viewport = find<HTMLElement>(".reader-viewport");
				const extent = () =>
					writing_mode === "horizontal-tb"
						? viewport.scrollHeight
						: viewport.scrollWidth;
				const withBookmark = extent();
				click("阅读设置");
				await until(
					() =>
						!!container.querySelector(
							'input[aria-label="展示阅读记录页边入口"]',
						),
					"Margin preference must load",
				);
				find<HTMLInputElement>(
					'input[aria-label="展示阅读记录页边入口"]',
				).click();
				await until(
					() => buttons().length === 0,
					"Turning off margins must remove tail bookmark",
				);
				check(
					extent() === withBookmark,
					`${writing_mode}: tail bookmark must not enlarge chapter scroll extent (${withBookmark} with bookmark, ${extent()} without)`,
				);
				results.push(
					`${writing_mode}: final-paragraph bookmark preserves chapter scroll extent`,
				);
				continue;
			}

			await until(
				() => buttons().length >= 3 && opened && positionSaved,
				`${writing_mode}: bookmarks not rendered`,
			);
			let previousGeometry = "";
			let stableFrames = 0;
			await until(() => {
				const geometry = JSON.stringify([
					find<HTMLIFrameElement>("iframe.material-part")
						.getBoundingClientRect()
						.toJSON(),
					buttons().map((node) => node.style.cssText),
				]);
				stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0;
				previousGeometry = geometry;
				return stableFrames >= 4;
			}, "Initial chapter geometry must settle before interactions");

			const viewport = find<HTMLElement>(".reader-viewport");
			const singles = () =>
				buttons().filter(
					(node) => node.getAttribute("aria-label") === "查看此处 1 条记录",
				);
			const first = () => {
				const node = singles()[0];
				check(node, "Missing first bookmark");
				return node;
			};
			const second = () => {
				const node = singles()[1];
				check(node, "Missing second bookmark");
				return node;
			};
			check(
				singles().length === 2,
				`${writing_mode}: expected two separate bookmarks`,
			);
			check(
				viewport.contains(first()),
				"Bookmark must be a descendant of the reading viewport",
			);
			check(
				getComputedStyle(first()).position === "absolute",
				"Bookmark must use absolute content coordinates",
			);
			check(
				first().getAttribute("aria-expanded") === "false",
				"Closed bookmark must report aria-expanded=false",
			);
			first().click();
			await until(
				() => !!preview() && first().getAttribute("aria-expanded") === "true",
				`${writing_mode}: first bookmark must open its preview (connected=${first().isConnected}, buttons=${buttons()
					.map((node) => node.getAttribute("aria-expanded"))
					.join(",")})`,
			);
			await until(
				() =>
					!!container
						.querySelector(".reader-study-preview-original")
						?.textContent?.trim(),
				"Bookmark source details must load before measuring placement",
			);
			let previousPanelBounds = "";
			let stablePanelFrames = 0;
			await until(() => {
				const bounds = JSON.stringify(
					find<HTMLElement>(".reader-chapter-records")
						.getBoundingClientRect()
						.toJSON(),
				);
				stablePanelFrames =
					bounds === previousPanelBounds ? stablePanelFrames + 1 : 0;
				previousPanelBounds = bounds;
				return stablePanelFrames >= 4;
			}, "Bookmark detail placement must settle after content loading");
			const triggerBounds = first().getBoundingClientRect();
			const panelBounds = find<HTMLElement>(
				".reader-chapter-records",
			).getBoundingClientRect();
			if (writing_mode === "horizontal-tb") {
				const outwardRight = triggerBounds.left > frameCenter();
				const outwardFits = outwardRight
					? innerWidth - triggerBounds.right - 20 >= panelBounds.width
					: triggerBounds.left - 20 >= panelBounds.width;
				const expectRight = outwardFits ? outwardRight : !outwardRight;
				check(
					Math.abs(
						expectRight
							? panelBounds.left - triggerBounds.right - 8
							: triggerBounds.left - panelBounds.right - 8,
					) < 1,
					"Margin preview must use the real button edge, preferring the outside then the available inside",
				);
			} else {
				check(
					Math.abs(triggerBounds.top - panelBounds.bottom - 8) < 1,
					`Bottom-margin preview must sit above the real trigger when outside has no space: trigger=${JSON.stringify(triggerBounds.toJSON())}, panel=${JSON.stringify(panelBounds.toJSON())}`,
				);
			}
			first().click();
			await until(
				() => !preview() && first().getAttribute("aria-expanded") === "false",
				"Clicking the same bookmark must close its preview",
			);
			first().click();
			await until(() => !!preview(), "First bookmark must reopen");
			const firstOriginal = find<HTMLElement>(
				".reader-study-preview-original",
			).textContent;
			second().click();
			await until(
				() =>
					second().getAttribute("aria-expanded") === "true" &&
					first().getAttribute("aria-expanded") === "false" &&
					!!preview() &&
					container.querySelector(".reader-study-preview-original")
						?.textContent !== firstOriginal,
				"Another bookmark must switch the preview",
			);
			second().click();
			await until(() => !preview(), "Second bookmark must close");
			const group = () =>
				buttons().find(
					(node) => node.getAttribute("aria-label") === "查看此处 2 条记录",
				);
			check(group(), "Overlapping marks must share one group bookmark");
			group()?.click();
			await until(
				() =>
					group()?.getAttribute("aria-expanded") === "true" &&
					container.querySelectorAll(".reader-study-preview-candidates button")
						.length === 2,
				"Grouped bookmark must open its two candidates",
			);
			group()?.click();
			await until(
				() => !preview() && group()?.getAttribute("aria-expanded") === "false",
				"Grouped bookmark must toggle closed",
			);
			const frame = find<HTMLIFrameElement>("iframe.material-part");
			function frameCenter() {
				const bounds = find<HTMLIFrameElement>(
					"iframe.material-part",
				).getBoundingClientRect();
				return (bounds.left + bounds.right) / 2;
			}
			const doc = frame.contentDocument;
			check(doc, "Reader needs a real same-origin document");
			const native = doc.getSelection();
			const plainLeaf = doc.querySelector('[data-locator-leaf="0"]');
			check(native && plainLeaf, "Fixture needs unmarked selectable source");
			const nativeRange = doc.createRange();
			nativeRange.selectNodeContents(plainLeaf);
			const selectOriginal = async () => {
				native.removeAllRanges();
				native.addRange(nativeRange);
				doc.dispatchEvent(new Event("selectionchange"));
				await until(
					() => !!container.querySelector('[aria-label="选区操作"]'),
					"Native iframe selection must show its action toolbar",
				);
			};
			const point = viewport.getBoundingClientRect();
			const sendPointer = (
				target: Element,
				type: string,
				overrides: PointerEventInit = {},
			) =>
				target.dispatchEvent(
					new PointerEvent(type, {
						bubbles: true,
						cancelable: true,
						pointerId: 1,
						isPrimary: true,
						pointerType: "mouse",
						button: 0,
						clientX: point.left + 2,
						clientY: point.top + 2,
						...overrides,
					}),
				);
			const tap = (target: Element, options: PointerEventInit = {}) => {
				sendPointer(target, "pointerdown", options);
				sendPointer(target, "pointerup", options);
			};
			const settleTap = async () => {
				await new Promise((resolve) =>
					setTimeout(resolve, FOCUS_TIMING.clickDelay + 16),
				);
			};
			const tools = () => find<HTMLElement>(".reader-r1").dataset.toolsVisible;
			await selectOriginal();
			tap(first());
			check(
				native.toString() === paragraphs[0],
				"Record control pointer gestures must preserve their selected source target",
			);
			tap(viewport, { shiftKey: true });
			check(!native.isCollapsed, "Modified margin tap must preserve selection");
			sendPointer(viewport, "pointerdown");
			sendPointer(viewport, "pointermove", {
				clientX: point.left + 20,
				buttons: 1,
			});
			sendPointer(viewport, "pointerup", { clientX: point.left + 20 });
			check(!native.isCollapsed, "Margin drag must preserve native selection");
			sendPointer(viewport, "pointerdown");
			await new Promise((resolve) =>
				setTimeout(resolve, FOCUS_TIMING.longPress + 16),
			);
			sendPointer(viewport, "pointerup");
			check(
				!native.isCollapsed,
				"Margin long press must preserve native selection",
			);
			const visibleBeforeDismiss = tools();
			tap(viewport);
			await until(
				() =>
					native.isCollapsed &&
					!container.querySelector('[aria-label="选区操作"]'),
				"A plain outer-margin tap must clear iframe selection and its toolbar",
			);
			await settleTap();
			check(
				tools() === visibleBeforeDismiss,
				"Selection dismissal must consume the tap without toggling reader tools",
			);
			await selectOriginal();
			const originalBounds = nativeRange.getBoundingClientRect();
			const originalPoint = {
				clientX: (originalBounds.left + originalBounds.right) / 2,
				clientY: (originalBounds.top + originalBounds.bottom) / 2,
			};
			tap(plainLeaf, originalPoint);
			await until(
				() =>
					native.isCollapsed &&
					!container.querySelector('[aria-label="选区操作"]'),
				"A plain iframe-body tap must clear native selection and its toolbar",
			);
			first().click();
			await until(
				() => !!preview(),
				"Compact preview must open before a body tap",
			);
			const bodyTools = tools();
			tap(plainLeaf, originalPoint);
			await until(
				() => !preview(),
				"Plain iframe-body tap must close a compact preview",
			);
			await settleTap();
			check(
				tools() === bodyTools,
				"Body preview dismissal must consume the tap without toggling tools",
			);
			first().click();
			await until(
				() => !!preview(),
				"Compact preview must open before dismissing it",
			);
			const compactTools = tools();
			tap(viewport);
			await until(
				() => !preview(),
				"Plain margin tap must close a compact preview",
			);
			await settleTap();
			check(
				tools() === compactTools,
				"Compact preview dismissal must consume one tap",
			);
			first().click();
			await until(() => !!preview(), "Preview must open before expanding");
			const expand = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((node) => node.textContent === "展开");
			check(expand, "Record preview needs expand control");
			expand.click();
			await until(
				() => !!container.querySelector(".reader-chapter-records.expanded"),
				"Preview must expand",
			);
			tap(viewport);
			await settleTap();
			check(
				!!container.querySelector(".reader-chapter-records.expanded"),
				"Plain margin tap must retain an expanded record sidebar",
			);
			const expandedPanel = find<HTMLElement>(
				".reader-chapter-records.expanded",
			);
			check(
				expandedPanel.getBoundingClientRect().height > 520 &&
					expandedPanel.getBoundingClientRect().height > innerHeight * 0.6,
				"Anchored preview expansion must use full available sidebar height",
			);
			const expandedOriginal = find<HTMLElement>(
				".reader-study-preview-original",
			).textContent;
			const collapse = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((node) => node.textContent === "收起");
			check(collapse, "Expanded record needs its return-to-preview action");
			collapse.click();
			await until(
				() =>
					!!preview() &&
					!container.querySelector(".reader-chapter-records.expanded"),
				"Returning from an anchored sidebar must keep the preview open",
			);
			check(
				find<HTMLElement>(".reader-study-preview-original").textContent ===
					expandedOriginal && first().getAttribute("aria-expanded") === "true",
				"Anchored return must retain selected segment and bookmark state",
			);
			click("关闭阅读记录");
			await until(
				() => !preview(),
				"Close icon must dismiss the returned anchored preview",
			);
			click("本章记录");
			await until(() => !!preview(), "Fixed chapter record panel must open");
			tap(viewport);
			await settleTap();
			check(
				!!preview(),
				"Plain margin tap must retain the fixed chapter record panel",
			);
			click("关闭阅读记录");
			const scrollBookmark = first();
			const before = scrollBookmark.getBoundingClientRect();
			const frameBefore = frame.getBoundingClientRect();
			const inline = {
				left: scrollBookmark.style.left,
				top: scrollBookmark.style.top,
			};
			const horizontal = writing_mode === "horizontal-tb";
			if (horizontal) viewport.scrollTop += 64;
			else viewport.scrollLeft -= 64;
			await until(
				() =>
					Math.abs(horizontal ? viewport.scrollTop : viewport.scrollLeft) >= 63,
				"Reader must scroll on its writing axis",
			);
			await until(
				() =>
					Math.abs(
						horizontal
							? frame.getBoundingClientRect().top - frameBefore.top
							: frame.getBoundingClientRect().left - frameBefore.left,
					) >= 63,
				"Chapter body must move with scrolling",
			);
			check(
				scrollBookmark.style.left === inline.left &&
					scrollBookmark.style.top === inline.top,
				"Scrolling must preserve bookmark inline content coordinates",
			);
			const after = scrollBookmark.getBoundingClientRect();
			const frameAfter = frame.getBoundingClientRect();
			check(
				Math.abs(
					after.left - before.left - (frameAfter.left - frameBefore.left),
				) < 1 &&
					Math.abs(
						after.top - before.top - (frameAfter.top - frameBefore.top),
					) < 1,
				"Bookmark must move by the same screen delta as the chapter body",
			);
			click("阅读设置");
			await until(
				() => !!container.querySelector('input[aria-label="字号"]'),
				"Settings must open",
			);
			inputValue(find<HTMLInputElement>('input[aria-label="字号"]'), "28");
			await until(
				() =>
					frame.contentDocument?.body.style.fontSize === "28px" &&
					buttons().length > 0,
				"Font change must reflow the chapter and retain bookmarks",
			);
			click("关闭阅读设置");
			await until(
				() =>
					!container.querySelector('[aria-label="阅读设置"][role="dialog"]'),
				"Settings must close",
			);
			buttons()[0]?.click();
			await until(() => !!preview(), "Bookmark must open after reflow");
			click("下一章");
			await until(
				() =>
					buttons().length === 0 &&
					!preview() &&
					container.textContent?.includes("chapter-two") === true,
				"Chapter change must clear old bookmarks and preview",
			);
			results.push(
				`${writing_mode}: content coordinates, scroll alignment, individual/group toggles, font reflow, chapter cleanup`,
			);
		} finally {
			dispose();
		}
	}
	return `reader bookmarks: ${results.join("; ")}`;
}
