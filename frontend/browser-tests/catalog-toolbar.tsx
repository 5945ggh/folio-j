import type { Book } from "../src/catalog/api";
import type { BrowserHarness } from "./harness";

export async function catalogToolbarRegression(
	h: BrowserHarness,
	preview = false,
): Promise<string> {
	const { MaterialsPage } = await import("../src/catalog/MaterialsPage");
	const { container, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const book: Book = {
		id: "toolbar-book",
		version_id: "toolbar-version",
		contract_version: "1",
		type: "book",
		title: "夏目漱石作品集",
		source_id: "toolbar-source",
		source_title: "日本文学",
		cover_url: null,
		created_at: "2026-10-25T00:00:00Z",
		last_opened_at: null,
		status: "not_started",
		usage_revision: 0,
		product_sha256: "a".repeat(64),
		source_sha256: "b".repeat(64),
		warnings: [],
	};
	const requests: URL[] = [];
	h.mock(async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/api/sources")
			return Response.json([
				{
					id: book.source_id,
					title: book.source_title,
					description: "",
					note: "",
					segment_count: 0,
					created_at: book.created_at,
					updated_at: book.created_at,
				},
			]);
		if (request.method === "GET" && url.pathname === "/api/materials") {
			requests.push(url);
			return Response.json({ items: [book], page: 1, page_size: 50, total: 1 });
		}
		throw new Error(
			`Unexpected toolbar request ${request.method} ${url.pathname}`,
		);
	});
	function element<T extends HTMLElement>(selector: string): T {
		const node = container.querySelector<T>(selector);
		check(node, `Missing toolbar element ${selector}`);
		return node;
	}
	const action = (label: string) =>
		element<HTMLButtonElement>(
			`.library-toolbar button[aria-label="${label}"]`,
		);
	function inViewport(node: HTMLElement, label: string) {
		const bounds = node.getBoundingClientRect();
		check(
			bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1,
			`${label} must fit ${innerWidth}px viewport: left=${bounds.left}, right=${bounds.right}`,
		);
	}
	function layout() {
		for (const label of [
			"搜索书名或来源",
			"筛选书籍",
			"排序",
			"卡片大小",
			"添加书籍",
		]) {
			const button = action(label);
			check(!button.disabled, `${label} must remain enabled`);
			inViewport(button, label);
			const bounds = button.getBoundingClientRect();
			const hit = document.elementFromPoint(
				bounds.left + bounds.width / 2,
				bounds.top + bounds.height / 2,
			);
			check(
				hit && button.contains(hit),
				`${label} must be reachable by pointer`,
			);
		}
		for (const selector of [".library-toolbar", ".library-tools"]) {
			const node = element(selector);
			inViewport(node, selector);
			check(
				node.scrollWidth <= node.clientWidth + 1,
				`${selector} must not overflow horizontally`,
			);
		}
		check(
			document.documentElement.scrollWidth <= innerWidth + 1,
			"Expanded catalog search must not cause document horizontal overflow",
		);
	}
	async function panel(label: string) {
		action(label).click();
		await until(
			() =>
				!!container.querySelector(
					`.library-popover[aria-label="${label}"]:popover-open`,
				),
			`${label} must open its panel`,
		);
		const node = element<HTMLDivElement>(
			`.library-popover[aria-label="${label}"]`,
		);
		inViewport(node, `${label} panel`);
		return node;
	}
	async function queryValue(name: string, value: string) {
		await until(
			() => requests.some((url) => url.searchParams.get(name) === value),
			`Toolbar must apply ${name}=${value} to catalog requests`,
		);
	}
	localStorage.clear();
	sessionStorage.clear();
	const dispose = await h.mount(<MaterialsPage />, "/materials", "/materials");
	try {
		await until(
			() => !!container.querySelector(".book-card"),
			"Catalog must load",
		);
		layout();
		const searchButton = action("搜索书名或来源");
		searchButton.click();
		await until(
			() => !!container.querySelector("#library-search"),
			"Search must expand",
		);
		const search = element<HTMLInputElement>("#library-search");
		await until(
			() => document.activeElement === search,
			"Expanded search must receive focus",
		);
		layout();
		inViewport(search, "Expanded search field");
		inputValue(search, "夏目");
		await queryValue("q", "夏目");

		const filter = await panel("筛选书籍");
		const source = filter.querySelector("select");
		check(source, "Filter must expose source selection");
		source.value = book.source_id;
		source.dispatchEvent(new Event("change", { bubbles: true }));
		await queryValue("source_id", book.source_id);
		filter.hidePopover();

		const sort = await panel("排序");
		const order = sort.querySelector<HTMLButtonElement>(
			'button[aria-pressed="false"]',
		);
		check(order, "Sort must expose the opposite direction");
		const expectedOrder = order.textContent === "升序" ? "asc" : "desc";
		order.click();
		await queryValue("order", expectedOrder);
		sort.hidePopover();

		const size = await panel("卡片大小");
		const slider = size.querySelector<HTMLInputElement>('input[type="range"]');
		check(slider, "Card size must expose its slider");
		inputValue(slider, "140");
		await until(
			() =>
				Math.abs(element(".book-card").getBoundingClientRect().width - 140) < 1,
			"Card width control must update rendered card width",
		);
		size.hidePopover();

		action("添加书籍").click();
		await until(
			() => !!container.querySelector(".import-dialog[open]"),
			"Add book must open import",
		);
		const cancel = element<HTMLButtonElement>(
			".import-dialog [data-dialog-cancel]",
		);
		cancel.click();
		await until(
			() => !container.querySelector(".import-dialog[open]"),
			"Import must close",
		);
		search.focus();
		search.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await until(
			() => !container.querySelector("#library-search"),
			"Escape must collapse search",
		);
		check(
			document.activeElement === searchButton,
			"Escape must return focus to search trigger",
		);
		check(
			searchButton.getAttribute("aria-expanded") === "false",
			"Collapsed search must announce state",
		);
		layout();
		if (preview) {
			searchButton.click();
			await until(
				() => !!container.querySelector("#library-search"),
				"Preview must retain expanded search",
			);
			layout();
		}
		return `catalog toolbar: search expansion, viewport geometry, pointer reachability, mocked search/filter/sort, card width, add import and Escape focus verified at ${innerWidth}px`;
	} finally {
		if (!preview) dispose();
	}
}
