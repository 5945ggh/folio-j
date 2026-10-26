import { Outlet, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { Book } from "../src/catalog/api";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";

const source: Source = {
	id: "import-source",
	title: "导入回归来源",
	description: "",
	note: "",
	segment_count: 0,
	created_at: "2026-10-25T00:00:00Z",
	updated_at: "2026-10-25T00:00:00Z",
};
function book(id: string, title: string): Book {
	return {
		id,
		title,
		version_id: `version-${id}`,
		contract_version: "1",
		type: "book",
		source_id: source.id,
		source_title: source.title,
		cover_url: null,
		created_at: source.created_at,
		last_opened_at: null,
		status: "not_started",
		usage_revision: 0,
		product_sha256: "a".repeat(64),
		source_sha256: "b".repeat(64),
		warnings: [],
	};
}
function imported(
	item: Book,
	reused = false,
): components["schemas"]["MaterialImportResponse"] {
	return {
		material: { ...item, chapters: [], reading_position: null },
		reused,
	};
}

export async function materialImport(
	h: BrowserHarness,
	preview: boolean | string = false,
) {
	const { MaterialsPage } = await import("../src/catalog/MaterialsPage");
	const { SourceContent } = await import("../src/catalog/SourceViews");
	const { container, mount, mock, until } = h;
	const check: BrowserHarness["check"] = h.check;
	const items: Book[] =
		preview === "source"
			? [
					book("preview-first", "夏目漱石作品集"),
					book("preview-second", "日本語の物語"),
				]
			: [];
	let catalogError = false;
	const uploads: {
		filename: string;
		body: string;
		finish: (response: Response) => void;
	}[] = [];
	mock(async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/api/sources")
			return Response.json([source]);
		if (
			request.method === "GET" &&
			url.pathname === `/api/sources/${source.id}`
		)
			return Response.json(source);
		if (request.method === "GET" && url.pathname === "/api/materials") {
			if (catalogError)
				return Response.json({ detail: "测试目录刷新失败" }, { status: 500 });
			const query = url.searchParams.get("q") ?? "";
			const visible = items.filter((item) => item.title.includes(query));
			return Response.json({
				items: visible,
				page: 1,
				page_size: Number(url.searchParams.get("page_size") ?? 50),
				total: visible.length,
			});
		}
		if (
			request.method === "GET" &&
			url.pathname === `/api/sources/${source.id}/materials`
		)
			return Response.json(items.map((item) => imported(item).material));
		if (
			request.method === "POST" &&
			url.pathname === `/api/sources/${source.id}/materials`
		) {
			const filename = url.searchParams.get("filename");
			check(filename, "Import must send its original filename");
			check(
				request.headers.get("content-type") === "application/epub+zip",
				"Import must retain the EPUB request content type",
			);
			const body = await request.text();
			return await new Promise<Response>((finish) =>
				uploads.push({ filename, body, finish }),
			);
		}
		throw new Error(
			`Unexpected import request ${request.method} ${url.pathname}`,
		);
	});
	function Routes() {
		const navigate = useNavigate();
		const location = useLocation();
		return (
			<>
				<nav aria-label="回归导航">
					<button type="button" onClick={() => navigate("/materials")}>
						测试素材库
					</button>
					<button
						type="button"
						onClick={() => navigate(`/sources/${source.id}?view=materials`)}
					>
						测试来源
					</button>
					<button
						type="button"
						onClick={() => navigate("/materials?q=未匹配的筛选")}
					>
						测试筛选
					</button>
					<button type="button" onClick={() => navigate("/away")}>
						测试离开
					</button>
				</nav>
				<output data-test-path>{location.pathname}</output>
				<Outlet />
			</>
		);
	}
	const action = (label: string, scope: ParentNode = container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				node.textContent?.trim() === label ||
				node.getAttribute("aria-label") === label,
		);
		check(found && !found.disabled, `Missing enabled import action ${label}`);
		return found;
	};
	const cards = () => [
		...container.querySelectorAll<HTMLElement>(".book-import-card"),
	];
	const card = (title: string) =>
		cards().find((node) => node.textContent?.includes(title));
	const dialog = () =>
		container.querySelector<HTMLDialogElement>(".import-dialog[open]");
	async function start(filename: string, scoped = false) {
		await until(
			() =>
				!!container.querySelector(
					scoped
						? "#source-content-panel-materials .book-grid"
						: "#library-empty-import, #library-add",
				),
			"Import entry must be available after route navigation",
		);
		action(
			scoped
				? "导入书籍"
				: container.querySelector("#library-empty-import")
					? "导入 EPUB"
					: "添加书籍",
		).click();
		await until(() => !!dialog(), "Import picker must open");
		const picker =
			dialog()?.querySelector<HTMLInputElement>('input[type="file"]');
		check(picker, "Import picker must expose a file input");
		const transfer = new DataTransfer();
		transfer.items.add(
			new File([`epub:${filename}`], filename, {
				type: "application/epub+zip",
			}),
		);
		picker.files = transfer.files;
		picker.dispatchEvent(new Event("change", { bubbles: true }));
		const select = dialog()?.querySelector<HTMLSelectElement>("select");
		check(select, "Import picker must expose the source");
		if (!scoped) {
			select.value = source.id;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		await until(
			() =>
				[
					...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
				].some((node) => node.textContent?.trim() === "导入" && !node.disabled),
			"Selected EPUB must enable Import",
		);
		const before = uploads.length;
		action("导入", dialog() ?? container).click();
		await until(
			() => !dialog() && uploads.length === before + 1,
			"Import must close the picker before its request completes",
		);
		return uploads.length - 1;
	}
	async function pending(title: string) {
		await until(() => !!card(title), `Pending card ${title} must be visible`);
		const node = card(title);
		check(node, `Missing pending card ${title}`);
		check(
			node.querySelector(".book-title")?.textContent === title,
			"Preparing title must omit the EPUB extension",
		);
		check(
			node.getAttribute("aria-busy") === "true",
			"Preparing card must announce busy state",
		);
		check(
			node.textContent?.includes("正在准备书籍和注音…"),
			"Preparing card must explain preparation",
		);
		check(
			node.querySelector(".import-preparation-indicator"),
			"Preparing card must show its indicator",
		);
		check(
			!node.querySelector("a, .book-menu-trigger"),
			"Preparing book must not expose reader links or book menus",
		);
		const bounds = node.getBoundingClientRect();
		check(
			bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1,
			"Import card must fit the viewport",
		);
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
			const indicator = node.querySelector(".import-preparation-indicator");
			check(indicator, "Missing preparation indicator");
			const style = getComputedStyle(indicator);
			check(
				style.animationName === "none" ||
					Number.parseFloat(style.animationDuration) <= 0.01,
				"Reduced motion must stop continuous preparation animation",
			);
		}
	}
	const layoutEvidence: string[] = [];
	function sourceLayout(expectedCount: number) {
		const panel = container.querySelector("#source-content-panel-materials");
		check(panel, "Source material panel must be active for layout checks");
		const nodes = [...panel.querySelectorAll<HTMLElement>(".book-card")];
		check(
			nodes.length === expectedCount,
			`Source grid must contain ${expectedCount} cards`,
		);
		const grid = nodes[0]?.closest(".book-grid");
		check(grid, "Source cards must belong to a book grid");
		check(
			nodes.every((node) => node.closest(".book-grid") === grid),
			"Source preparing and existing books must share one book grid",
		);
		const columns =
			getComputedStyle(grid).gridTemplateColumns.split(" ").length;
		check(columns >= 2, "Source grid must use available horizontal columns");
		if (innerWidth <= 720)
			check(
				columns === 2,
				"Narrow source grid must retain its two-column layout",
			);
		const bounds = nodes.map((node) => node.getBoundingClientRect());
		for (const [index, rect] of bounds.entries()) {
			check(
				rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1,
				"Every source card must fit the viewport",
			);
			const rowStart = bounds[Math.floor(index / columns) * columns];
			check(
				rowStart && Math.abs(rect.top - rowStart.top) < 1,
				"Source cards must fill each available grid row horizontally",
			);
			if (index % columns !== 0) {
				const previous = bounds[index - 1];
				check(
					previous && rect.left >= previous.right,
					"Source cards in one row must sit side by side without overlap",
				);
			} else if (index > 0) {
				const previousRow = bounds[index - columns];
				check(
					previousRow && rect.top > previousRow.bottom,
					"Source cards must wrap below the preceding row",
				);
			}
		}
		layoutEvidence.push(
			`${expectedCount} cards/${columns} columns/${bounds[0]?.width}px`,
		);
		return bounds.map(({ left, top, width }) => ({ left, top, width }));
	}
	function complete(index: number, item: Book, reused = false) {
		if (!items.some((existing) => existing.id === item.id)) items.push(item);
		const request = uploads[index];
		check(request, `Missing import request ${index}`);
		request.finish(Response.json(imported(item, reused)));
	}
	async function ready(item: Book) {
		await until(
			() =>
				container.querySelectorAll(
					`.book-main-link[href="/materials/${item.id}"]`,
				).length === 1 && !card(item.title),
			`Completed book ${item.title} must replace its pending card exactly once`,
		);
		check(
			container.querySelector("[data-test-path]")?.textContent !==
				`/materials/${item.id}`,
			"Import completion must leave the current route unchanged",
		);
	}
	localStorage.clear();
	sessionStorage.clear();
	const dispose = await mount(
		<Routes />,
		"/",
		preview === "source"
			? `/sources/${source.id}?view=materials`
			: "/materials",
		[
			{ path: "materials", element: <MaterialsPage /> },
			{
				path: "sources/:id",
				element: (
					<SourceContent
						source={source}
						onAddSegment={() => {}}
						onShowInfo={() => {}}
					/>
				),
			},
			{ path: "away", element: <p data-test-away>已离开素材库</p> },
			{
				path: "materials/:id",
				element: <p data-test-reader>不应自动进入阅读器</p>,
			},
		],
	);
	try {
		if (preview === "source") {
			await until(
				() =>
					container.querySelectorAll(
						"#source-content-panel-materials .book-main-link",
					).length === 2,
				"Source preview must load two existing books",
			);
			await start("新しい本.epub", true);
			await pending("新しい本");
			return "material import: source preview with two existing books and one pending import";
		}
		await until(
			() => !!container.querySelector("#library-empty-import, #library-add"),
			"Empty catalog must allow importing",
		);
		const first = await start("夏目.epub");
		await pending("夏目");
		if (preview) return "material import: pending card preview";
		action("测试离开").click();
		await until(
			() => !!container.querySelector("[data-test-away]"),
			"Navigation must unmount the catalog",
		);
		action("测试素材库").click();
		await pending("夏目");
		check(
			uploads.length === 1,
			"Returning must retain rather than restart the import",
		);
		action("测试来源").click();
		await pending("夏目");
		complete(first, book("summer", "夏目"));
		await ready(book("summer", "夏目"));
		action("测试素材库").click();
		await ready(book("summer", "夏目"));

		const failed = await start("再試行.epub");
		await pending("再試行");
		uploads[failed]?.finish(
			Response.json({ detail: "测试准备失败" }, { status: 500 }),
		);
		await until(
			() => !!card("再試行")?.textContent?.includes("测试准备失败"),
			"Failed import must show its error on the card",
		);
		const failedCard = card("再試行");
		check(
			failedCard && failedCard.getAttribute("aria-busy") !== "true",
			"Failed card must leave busy state",
		);
		action("重试", failedCard).click();
		await until(
			() => uploads.length === failed + 2,
			"Retry must submit another import request",
		);
		await pending("再試行");
		check(
			uploads[failed]?.filename === uploads[failed + 1]?.filename &&
				uploads[failed]?.body === uploads[failed + 1]?.body,
			"Retry must preserve the selected EPUB name and contents",
		);
		complete(failed + 1, book("retry", "再試行"));
		await ready(book("retry", "再試行"));

		action("测试来源").click();
		await ready(book("summer", "夏目"));
		await ready(book("retry", "再試行"));
		const sourceImport = await start("来源新增.epub", true);
		await pending("来源新增");
		const preparingLayout = sourceLayout(3);
		complete(sourceImport, book("source-added", "来源新增"));
		await ready(book("source-added", "来源新增"));
		const completedLayout = sourceLayout(3);
		check(
			Math.abs(
				(preparingLayout[0]?.top ?? 0) - (completedLayout[0]?.top ?? 0),
			) < 1 &&
				preparingLayout.every((before, index) => {
					const after = completedLayout[index];
					return (
						after &&
						Math.abs(before.left - after.left) < 1 &&
						Math.abs(before.width - after.width) < 1
					);
				}),
			`Source completion must preserve the grid start, columns and card widths: ${JSON.stringify({ preparingLayout, completedLayout })}`,
		);

		const slow = await start("先行.epub", true);
		const fast = await start("後続.epub", true);
		await pending("先行");
		await pending("後続");
		check(
			cards().length === 2,
			"Concurrent imports need independent preparation cards",
		);
		sourceLayout(5);
		complete(fast, book("fast", "後続"));
		await ready(book("fast", "後続"));
		await pending("先行");
		complete(slow, book("slow", "先行"));
		await ready(book("slow", "先行"));
		sourceLayout(5);
		action("测试素材库").click();
		await ready(book("slow", "先行"));

		const reused = await start("夏目.epub");
		await pending("夏目");
		complete(reused, book("summer", "夏目"), true);
		await ready(book("summer", "夏目"));
		check(
			cards().length === 0,
			"Reused material must not retain duplicate preparation cards",
		);

		action("测试来源").click();
		await until(
			() => !!container.querySelector(".book-grid"),
			"Source books must load",
		);
		const removed = await start("移除.epub", true);
		await pending("移除");
		uploads[removed]?.finish(
			Response.json({ detail: "测试可移除失败" }, { status: 500 }),
		);
		await until(
			() => !!card("移除")?.textContent?.includes("测试可移除失败"),
			"Source import failure must be visible",
		);
		const removable = card("移除");
		check(removable, "Missing failed source import");
		action("移除", removable).click();
		await until(
			() => !card("移除"),
			"Remove must dismiss the failed import card",
		);
		const refreshFailed = await start("刷新失敗.epub", true);
		await pending("刷新失敗");
		catalogError = true;
		complete(refreshFailed, book("refresh-failed", "刷新失敗"));
		await until(
			() =>
				!!card("刷新失敗")?.querySelector(
					'.book-main-link[href="/materials/refresh-failed"]',
				),
			"Successful import must remain readable when catalog refresh fails",
		);
		check(
			card("刷新失敗")?.getAttribute("aria-busy") !== "true" &&
				!card("刷新失敗")?.querySelector(".import-preparation-indicator"),
			"Catalog refresh failure must not leave a completed book spinning",
		);
		await until(
			() => !!container.textContent?.includes("测试目录刷新失败"),
			"Catalog refresh failure must be exercised",
		);
		catalogError = false;
		action("测试筛选").click();
		await until(
			() =>
				!!container
					.querySelector(".library-chips")
					?.textContent?.includes("未匹配的筛选"),
			"Filtered catalog must mount",
		);
		const hidden = await start("筛选外.epub");
		await pending("筛选外");
		complete(hidden, book("outside-filter", "筛选外"));
		await until(
			() =>
				!!card("筛选外")?.querySelector(
					'.book-main-link[href="/materials/outside-filter"]',
				),
			"Successful book outside the active filter must remain readable through its import card",
		);
		check(
			card("筛选外")?.getAttribute("aria-busy") !== "true" &&
				!card("筛选外")?.querySelector(".import-preparation-indicator"),
			"Filtered completion must stop preparing",
		);
		check(
			container.querySelectorAll(
				'.book-main-link[href="/materials/outside-filter"]',
			).length === 1,
			"Filtered completion must expose exactly one reading link",
		);
		check(
			!container.querySelector("[data-test-reader]"),
			"No import may navigate to the reader automatically",
		);
		return `material import: immediate close, pending, route persistence, source geometry, stable completion layout, responsive wrapping, success, retry payload, independent completion, reuse, removal, refresh failure, filtered completion and motion verified at ${innerWidth}px (${uploads.length} mocked uploads; source grids ${layoutEvidence.join(", ")})`;
	} finally {
		if (!preview) dispose();
	}
}
