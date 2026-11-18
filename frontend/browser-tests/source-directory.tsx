import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";
import { overviewItems, showsOverview } from "./source-overview-fixture";
import "../src/catalog/source-content.css";
import "../src/catalog/sources-s2.css";

const timestamp = "2026-11-10T00:00:00Z";

function makeSource(id: string, title: string, segmentCount = 1): Source {
	return {
		id,
		title,
		description: `${title}简介`,
		note: `${title}备注`,
		segment_count: segmentCount,
		created_at: timestamp,
		updated_at: timestamp,
	};
}

export async function sourceDirectoryRegression(
	h: BrowserHarness,
): Promise<string> {
	const { SourceDetail } = await import("../src/SourcePages");
	const { container, until, inputValue, mount, mock } = h;
	const check: BrowserHarness["check"] = h.check;

	let sources: Source[] = [
		makeSource("src-a", "小説・雪国"),
		makeSource("src-b", "随筆・春"),
		makeSource("src-c", "新聞記事"),
	];
	const overviewReads = new Map<string, number>();
	const prefetched = overviewItems("src-c", "預読");
	const refreshed = overviewItems("src-c", "更新");
	let currentOverview = prefetched;
	const patched: { id: string; title?: string }[] = [];
	let queryClient: QueryClient | undefined;

	function recordRead(kind: string, id: string) {
		const key = `${kind}:${id}`;
		overviewReads.set(key, (overviewReads.get(key) ?? 0) + 1);
	}

	mock(async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (request.method === "GET" && path === "/api/catalog/sources") {
			const q = (url.searchParams.get("q") ?? "").trim();
			const filtered = q
				? sources.filter((item) => item.title.includes(q))
				: sources;
			return Response.json({
				items: filtered.map((item) => ({
					...item,
					material_count: 0,
					analysis_count: 0,
				})),
				total: filtered.length,
				page: 1,
				page_size: 50,
			});
		}
		if (request.method === "GET" && path === "/api/sources")
			return Response.json(sources);
		const sourceMatch = path.match(/^\/api\/sources\/([^/]+)$/);
		if (sourceMatch) {
			const id = sourceMatch[1] ?? "";
			const found = sources.find((item) => item.id === id);
			if (!found)
				return Response.json({ detail: "not found" }, { status: 404 });
			if (request.method === "GET") return Response.json(found);
			if (request.method === "PATCH") {
				const body = (await request.json()) as { title?: string };
				patched.push({ id, title: body.title });
				if (body.title === "新聞記事・刷新確認") currentOverview = refreshed;
				sources = sources.map((item) =>
					item.id === id && body.title ? { ...item, title: body.title } : item,
				);
				return Response.json(sources.find((item) => item.id === id));
			}
		}
		const catalogMatch = path.match(
			/^\/api\/sources\/([^/]+)\/catalog\/(segments|analyses)$/,
		);
		if (request.method === "GET" && catalogMatch) {
			const id = catalogMatch[1] ?? "";
			const kind = catalogMatch[2] ?? "";
			if (
				url.searchParams.get("page_size") === (kind === "segments" ? "3" : "2")
			)
				recordRead(kind, id);
			const items = id === "src-c" ? currentOverview : overviewItems(id, id);
			return Response.json({
				items: [kind === "segments" ? items.segment : items.analysis],
				total: 1,
				page: 1,
				page_size: Number(url.searchParams.get("page_size")),
			});
		}
		if (request.method === "GET" && path === "/api/materials") {
			const id = url.searchParams.get("source_id") ?? "";
			if (url.searchParams.get("page_size") === "3")
				recordRead("materials", id);
			const items = id === "src-c" ? [currentOverview.book] : [];
			return Response.json({
				items,
				total: items.length,
				page: 1,
				page_size: 3,
			});
		}
		throw new Error(
			`Unexpected source directory request ${request.method} ${path}${url.search}`,
		);
	});

	function Route() {
		queryClient = useQueryClient();
		return <SourceDetail />;
	}
	localStorage.clear();
	sessionStorage.clear();
	const dispose = await mount(
		<Route />,
		"/sources/:id",
		"/sources/src-a?view=segments",
	);
	try {
		await until(
			() =>
				!!container.querySelector(".s2-source-heading h1") &&
				!!container.querySelector(".source-list-sort-trigger"),
			"Source detail and segments toolbar must load",
		);

		const segmentSortTrigger = container.querySelector<HTMLButtonElement>(
			".source-list-sort-trigger",
		);
		check(segmentSortTrigger, "Missing segment sort trigger");
		check(
			segmentSortTrigger.textContent?.includes("排序 · 创建时间 ↓") ?? false,
			`Expected current segment sort label, got: ${segmentSortTrigger.textContent}`,
		);
		const sortBounds = segmentSortTrigger.getBoundingClientRect();
		check(
			sortBounds.left >= 0 && sortBounds.right <= innerWidth + 1,
			"Sort trigger with current state must fit viewport",
		);
		segmentSortTrigger.click();
		await until(
			() => !!container.querySelector(".source-list-sort:popover-open"),
			"Segment sort popover must open",
		);
		const sortPopover = container.querySelector<HTMLElement>(
			".source-list-sort:popover-open",
		);
		check(sortPopover, "Expected open segment sort popover");
		const sortSelect = sortPopover.querySelector("select");
		check(sortSelect, "Expected segment sort select");
		sortSelect.value = "updated_at";
		sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await until(
			() =>
				segmentSortTrigger.textContent?.includes("排序 · 更新时间 ↓") ?? false,
			"Segment sort trigger must reflect updated field before direction change",
		);
		const ascButton = [...sortPopover.querySelectorAll("button")].find(
			(node) => node.textContent?.trim() === "升序",
		);
		check(ascButton, "Expected ascending sort button");
		ascButton.click();
		await until(
			() =>
				segmentSortTrigger.textContent?.includes("排序 · 更新时间 ↑") ?? false,
			"Segment sort trigger must update to reflect new field and direction",
		);
		sortPopover.hidePopover();

		if (innerWidth <= 900) {
			const switchButton = container.querySelector<HTMLButtonElement>(
				"#source-drawer-trigger",
			);
			check(switchButton, "Expected narrow source switch trigger");
			switchButton.click();
			await until(
				() => !!container.querySelector("dialog.s2-source-drawer[open]"),
				"Directory drawer must open on narrow viewports",
			);
		}

		const dirScope =
			container.querySelector("dialog.s2-source-drawer[open]") ??
			container.querySelector(".s2-source-panel");
		check(dirScope, "Expected directory scope");

		const dirSortTrigger = dirScope.querySelector<HTMLButtonElement>(
			'button[aria-label="来源排序"]',
		);
		check(dirSortTrigger, "Expected source directory sort trigger");
		check(
			dirSortTrigger.title === "来源排序 · 名称 ↑",
			`Expected default source sort title, got: ${dirSortTrigger.title}`,
		);
		check(
			!dirSortTrigger.querySelector(".library-tool-indicator"),
			"Default sort must not display active indicator dot",
		);
		dirSortTrigger.click();
		await until(
			() =>
				!!dirScope.querySelector(
					'.library-popover[aria-label="来源排序"]:popover-open',
				),
			"Source directory sort popover must open",
		);
		const dirSortPanel = dirScope.querySelector<HTMLElement>(
			'.library-popover[aria-label="来源排序"]:popover-open',
		);
		check(dirSortPanel, "Expected open directory sort panel");
		const dirSortSelect = dirSortPanel.querySelector("select");
		check(dirSortSelect, "Expected directory sort select");
		dirSortSelect.value = "updated_at";
		dirSortSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await until(
			() =>
				dirSortTrigger.title === "来源排序 · 更新时间 ↑" &&
				!!dirSortTrigger.querySelector(".library-tool-indicator"),
			"Changed directory sort must update title and show indicator dot",
		);
		dirSortPanel.hidePopover();

		const searchButton = dirScope.querySelector<HTMLButtonElement>(
			'button[aria-label="搜索来源"]',
		);
		check(searchButton, "Expected source search button");
		searchButton.click();
		await until(
			() => !!dirScope.querySelector(".s2-source-search input"),
			"Source search input must expand",
		);
		const searchInput = dirScope.querySelector<HTMLInputElement>(
			".s2-source-search input",
		);
		check(searchInput, "Expected source search input");
		inputValue(searchInput, "小説");
		await until(
			() => dirScope.querySelectorAll("a.s2-source-row").length === 1,
			"Source search must filter directory items",
		);
		searchInput.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await until(
			() =>
				!dirScope.querySelector(".s2-source-search") &&
				!!dirScope.querySelector(".s2-search-chip"),
			"Escape must collapse search input into search chip",
		);
		const chipEdit = dirScope.querySelector<HTMLButtonElement>(
			".s2-search-chip-edit",
		);
		const chipClear = dirScope.querySelector<HTMLButtonElement>(
			".s2-search-chip-clear",
		);
		check(chipEdit && chipClear, "Search chip must separate edit and clear");
		chipEdit.click();
		await until(
			() => !!dirScope.querySelector(".s2-source-search input"),
			"Clicking chip text must re-expand search input",
		);
		const reopenedInput = dirScope.querySelector<HTMLInputElement>(
			".s2-source-search input",
		);
		check(
			reopenedInput &&
				document.activeElement === reopenedInput &&
				reopenedInput.value === "小説",
			"Re-expanded search input must focus and keep query",
		);
		reopenedInput.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await until(
			() => !!dirScope.querySelector(".s2-search-chip-clear"),
			"Second Escape must collapse search input back to chip",
		);
		dirScope.querySelector<HTMLButtonElement>(".s2-search-chip-clear")?.click();
		await until(
			() =>
				!dirScope.querySelector(".s2-search-chip") &&
				dirScope.querySelectorAll("a.s2-source-row").length === 3,
			"Clicking clear button must remove chip and restore all sources",
		);
		check(
			document.activeElement === searchButton,
			"Clearing search chip must restore focus to search button",
		);

		if (innerWidth > 900) {
			const rowA = dirScope.querySelector<HTMLAnchorElement>(
				'a.s2-source-row[data-source-id="src-a"]',
			);
			const rowC = dirScope.querySelector<HTMLAnchorElement>(
				'a.s2-source-row[data-source-id="src-c"]',
			);
			check(rowA && rowC, "Expected source rows A and C");
			rowC.focus();
			await until(
				() =>
					overviewReads.has("analyses:src-c") &&
					overviewReads.has("segments:src-c") &&
					overviewReads.has("materials:src-c"),
				"Focusing a source row must prefetch its overview queries",
			);

			rowA.focus();
			rowA.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
			await until(
				() =>
					container.querySelector(".s2-source-heading h1")?.textContent ===
						"随筆・春" &&
					document.activeElement?.getAttribute("data-source-id") === "src-b",
				"ArrowDown must switch to the next source and keep focus on its row",
			);

			const activeRowB = container.querySelector<HTMLAnchorElement>(
				'a.s2-source-row[data-source-id="src-b"]',
			);
			check(activeRowB, "Expected active row B");
			activeRowB.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
			);
			await until(
				() =>
					container.querySelector(".s2-source-heading h1")?.textContent ===
						"小説・雪国" &&
					document.activeElement?.getAttribute("data-source-id") === "src-a",
				"ArrowUp must switch back to the previous source and keep focus on its row",
			);

			const editC = dirScope.querySelector<HTMLButtonElement>(
				'button[aria-label="编辑来源「新聞記事」"]',
			);
			check(editC, "Wide directory row must offer quick edit button");
			editC.click();
			await until(
				() => !!container.querySelector("dialog[open] .source-form"),
				"Row quick-edit button must open SourceEditDialog",
			);
			check(
				container.querySelector(".s2-source-heading h1")?.textContent ===
					"小説・雪国",
				"Opening quick-edit on another row must not steal current source navigation",
			);
			const titleInput = container.querySelector<HTMLInputElement>(
				"dialog[open] .source-form input",
			);
			check(titleInput, "Expected source title input in edit dialog");
			inputValue(titleInput, "新聞記事・改");
			const saveButton = [
				...container.querySelectorAll<HTMLButtonElement>("dialog[open] button"),
			].find((node) => node.textContent?.trim() === "保存更改");
			check(saveButton, "Expected save button in edit dialog");
			saveButton.click();
			await until(
				() =>
					!container.querySelector("dialog[open]") &&
					patched.some((item) => item.id === "src-c") &&
					dirScope.textContent?.includes("新聞記事・改"),
				"Quick-edit save must patch the row source and refresh directory",
			);
		}

		const rowC = dirScope.querySelector<HTMLAnchorElement>(
			'a.s2-source-row[data-source-id="src-c"]',
		);
		check(rowC, "Source C must be available for the prefetch regression");
		const counts = () =>
			["analyses", "segments", "materials"].map(
				(kind) => overviewReads.get(`${kind}:src-c`) ?? 0,
			);
		const beforePrefetch = counts();
		rowC.focus();
		await until(
			() =>
				counts().every((n, i) => n > (beforePrefetch[i] ?? 0)) &&
				queryClient?.isFetching() === 0,
			"The three overview prefetches must finish before navigation",
		);
		const prefetchedCounts = counts();
		check(
			prefetchedCounts.every(
				(count, index) => count === (beforePrefetch[index] ?? 0) + 1,
			),
			"Each overview interface must receive one prefetch",
		);
		rowC.click();
		await until(
			() =>
				!!container.querySelector(
					'a[aria-current="page"][data-source-id="src-c"]',
				) && showsOverview(container, prefetched),
			"Source C must display the prefetched analysis, segment and book",
		);
		check(
			counts().every((count, index) => count === prefetchedCounts[index]),
			`Switching after prefetch must add no overview GETs, got ${counts()} after ${prefetchedCounts}`,
		);

		const menuTrigger = container.querySelector<HTMLButtonElement>(
			"#source-menu-trigger",
		);
		check(menuTrigger, "Source C must show its actions");
		menuTrigger.click();
		const editor = container.querySelector<HTMLButtonElement>(
			".s2-source-menu button:nth-child(2)",
		);
		check(editor, "Source C menu must offer editing");
		editor.click();
		await until(
			() => !!container.querySelector("dialog[open] .source-form input"),
			"Source C editor must open",
		);
		const form = container.querySelector("dialog[open] .source-form");
		const title = form?.querySelector("input");
		const save = [...(form?.querySelectorAll("button") ?? [])].find(
			(node) => node.textContent?.trim() === "保存更改",
		);
		check(title && save, "Source C editor must offer title and save");
		inputValue(title, "新聞記事・刷新確認");
		save.click();
		await until(
			() =>
				container.querySelector(".s2-source-heading h1")?.textContent ===
					"新聞記事・刷新確認" &&
				showsOverview(container, refreshed) &&
				counts().every(
					(count, index) => count === (prefetchedCounts[index] ?? 0) + 1,
				),
			"Saving Source C must refresh each active overview query once",
		);
		return `source directory ${innerWidth}px: overview GETs (analyses, segments, materials) after prefetch + navigation 1/1/1; after editing 1/1/1 additional`;
	} finally {
		dispose();
	}
}
