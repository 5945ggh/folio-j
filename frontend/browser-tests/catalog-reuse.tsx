import { useMutationState } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { Book } from "../src/catalog/api";
import { importKey } from "../src/catalog/import-state";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";

const source: Source = {
	id: "catalog-reuse-source",
	title: "重复导入回归来源",
	description: "",
	note: "",
	segment_count: 0,
	created_at: "2026-10-25T00:00:00Z",
	updated_at: "2026-10-25T00:00:00Z",
};
const book: Book = {
	id: "catalog-reused-book",
	title: "吾輩は猫である",
	version_id: "catalog-reused-version",
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
const imported: components["schemas"]["MaterialImportResponse"] = {
	material: { ...book, chapters: [], reading_position: null },
	reused: true,
};

/** Let mutation notifications and passive consumption effects settle before failing GET. */
async function renderFrames(count = 12) {
	for (let frame = 0; frame < count; frame++)
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
}

export async function reusedImportRegression(
	h: BrowserHarness,
	preview = false,
): Promise<string> {
	const { MaterialsPage } = await import("../src/catalog/MaterialsPage");
	const { SourceContent } = await import("../src/catalog/SourceViews");
	const { container, mock, mount, until } = h;
	const check: BrowserHarness["check"] = h.check;
	const readerPath = `/materials/${book.id}`;
	const linkSelector = `.book-main-link[href="${readerPath}"]`;
	const errorText = "重复导入后目录刷新失败";
	let phase: "initial" | "refresh" | "error" | "recovered" = "initial";
	const deferred: {
		refresh?: (response: Response) => void;
		upload?: (response: Response) => void;
	} = {};
	function resetDeferred() {
		delete deferred.refresh;
		delete deferred.upload;
	}
	let uploadCount = 0;
	let catalogCount = 0;
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
			catalogCount++;
			if (phase === "refresh")
				return new Promise<Response>((resolve) => {
					deferred.refresh = resolve;
				});
			if (phase === "error")
				return Response.json({ detail: errorText }, { status: 500 });
			return Response.json({
				items: [book],
				page: 1,
				page_size: Number(url.searchParams.get("page_size") ?? 50),
				total: 1,
			});
		}
		if (
			request.method === "POST" &&
			url.pathname === `/api/sources/${source.id}/materials`
		) {
			uploadCount++;
			check(
				url.searchParams.get("filename") === `${book.title}.epub`,
				"Reimport must upload the existing book's filename",
			);
			check(
				(await request.text()) === "existing-epub-contents",
				"Reimport must upload the selected EPUB contents",
			);
			return new Promise<Response>((resolve) => {
				deferred.upload = resolve;
			});
		}
		throw new Error(
			`Unexpected reused import request ${request.method} ${url}`,
		);
	});
	function Routes() {
		const navigate = useNavigate();
		const location = useLocation();
		const successes = useMutationState({
			filters: { mutationKey: importKey, status: "success" },
			select: (mutation) => mutation.mutationId,
		});
		return (
			<>
				<button type="button" onClick={() => navigate(-1)}>
					返回回归目录
				</button>
				<output data-test-path>{location.pathname}</output>
				<output data-test-successes hidden>
					{successes.length}
				</output>
				<Outlet />
			</>
		);
	}
	function action(label: string, scope: ParentNode = container) {
		const button = [
			...scope.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(node) =>
				node.textContent?.trim() === label ||
				node.getAttribute("aria-label") === label,
		);
		check(
			button && !button.disabled,
			`Missing enabled reused import action ${label}`,
		);
		return button;
	}
	function readingLink(context: string) {
		const links = container.querySelectorAll<HTMLAnchorElement>(linkSelector);
		check(
			links.length === 1,
			`${context}: expected exactly one reading entry, got ${links.length}`,
		);
		const link = links[0];
		check(link, `${context}: missing reading entry`);
		const rect = link.getBoundingClientRect();
		check(
			rect.width > 0 &&
				rect.height > 0 &&
				rect.left >= 0 &&
				rect.right <= innerWidth + 1,
			`${context}: reading entry must be visible and fit the viewport`,
		);
		check(
			getComputedStyle(link).pointerEvents !== "none",
			`${context}: reading entry must accept clicks`,
		);
		return link;
	}
	const results: string[] = [];
	for (const scoped of [false, true]) {
		phase = "initial";
		resetDeferred();
		localStorage.clear();
		sessionStorage.clear();
		const path = scoped ? `/sources/${source.id}` : "/materials";
		const label = scoped ? "source materials" : "materials library";
		const dispose = await mount(
			<Routes />,
			"/",
			`${path}${scoped ? "?view=materials" : ""}`,
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
				{
					path: "materials/:id",
					element: <p data-test-reader>重复导入书籍的阅读器</p>,
				},
			],
		);
		let preserve = false;
		try {
			await until(
				() => container.querySelectorAll(linkSelector).length === 1,
				`${label}: cached book must load before reimport`,
			);
			readingLink(`${label}: initial catalog`);
			action(scoped ? "导入书籍" : "添加书籍").click();
			await until(
				() => !!container.querySelector(".import-dialog[open]"),
				`${label}: import picker must open`,
			);
			const dialog = container.querySelector<HTMLDialogElement>(
				".import-dialog[open]",
			);
			const picker =
				dialog?.querySelector<HTMLInputElement>('input[type="file"]');
			const select = dialog?.querySelector<HTMLSelectElement>("select");
			check(
				dialog && picker && select,
				`${label}: import picker must expose file and source controls`,
			);
			const transfer = new DataTransfer();
			transfer.items.add(
				new File(["existing-epub-contents"], `${book.title}.epub`, {
					type: "application/epub+zip",
				}),
			);
			picker.files = transfer.files;
			picker.dispatchEvent(new Event("change", { bubbles: true }));
			if (!scoped) {
				select.value = source.id;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
			await until(
				() =>
					[...dialog.querySelectorAll<HTMLButtonElement>("button")].some(
						(node) => node.textContent?.trim() === "导入" && !node.disabled,
					),
				`${label}: selected file must enable import`,
			);
			action("导入", dialog).click();
			await until(
				() => !!deferred.upload && !dialog.open,
				`${label}: upload must start and picker must close`,
			);
			check(deferred.upload, `${label}: missing deferred upload`);
			phase = "refresh";
			deferred.upload(Response.json(imported));
			await until(
				() => !!deferred.refresh,
				`${label}: successful reused upload must start catalog refresh`,
			);
			// An immediate 500 can run before the success-consumption effect and miss this race.
			await renderFrames();
			readingLink(`${label}: pending refresh`);
			check(
				!container.querySelector(
					".import-preparation-indicator, .book-import-card[aria-busy='true']",
				),
				`${label}: completed upload must stop its preparation indicator during refresh`,
			);
			check(
				container.querySelector("[data-test-path]")?.textContent === path,
				`${label}: reuse must not navigate automatically`,
			);
			check(deferred.refresh, `${label}: missing deferred refresh`);
			phase = "error";
			deferred.refresh(Response.json({ detail: errorText }, { status: 500 }));
			await until(
				() => !!container.textContent?.includes(errorText),
				`${label}: deferred catalog failure must be visible`,
			);
			await renderFrames(3);
			const fallback = readingLink(`${label}: failed refresh`);
			check(
				fallback.closest(".book-import-card"),
				`${label}: failed refresh must retain its successful import fallback`,
			);
			check(
				!container.querySelector(
					".import-preparation-indicator, .book-import-card[aria-busy='true']",
				),
				`${label}: failed refresh must not leave a completed book spinning`,
			);
			check(
				container.querySelector("[data-test-path]")?.textContent === path,
				`${label}: catalog failure must not navigate`,
			);
			action("重试");
			if (preview && scoped) {
				preserve = true;
				return `catalog reuse: library verified; source reused success and catalog failure preview at ${innerWidth}px`;
			}
			fallback.click();
			await until(
				() => !!container.querySelector("[data-test-reader]"),
				`${label}: failed-refresh reading entry must open its reader`,
			);
			action("返回回归目录").click();
			await until(
				() =>
					!!container.textContent?.includes(errorText) &&
					!!container.querySelector(linkSelector),
				`${label}: returning must preserve readable fallback and retry`,
			);
			phase = "recovered";
			const beforeRetry = catalogCount;
			action("重试").click();
			await until(
				() =>
					catalogCount > beforeRetry &&
					!container.textContent?.includes(errorText) &&
					container.querySelectorAll(linkSelector).length === 1 &&
					!container.querySelector(".book-import-card"),
				`${label}: retry must replace fallback with exactly one real catalog card`,
			);
			await until(
				() =>
					container.querySelector("[data-test-successes]")?.textContent === "0",
				`${label}: successful refreshed catalog must consume its temporary import success`,
			);
			readingLink(`${label}: recovered catalog`);
			check(
				container.querySelector("[data-test-path]")?.textContent === path,
				`${label}: catalog recovery must stay on the current route`,
			);
			results.push(label);
		} finally {
			if (!preserve) dispose();
		}
	}
	check(
		uploadCount === 2,
		"Each surface must reimport the same EPUB exactly once",
	);
	await expandedImportRegression(h);
	return `catalog reuse: expanded filtered source retention and ${results.join(" and ")} verified delayed refresh, unique readable fallback, stopped preparation, reader click, retry, recovery and consumed success at ${innerWidth}px (${uploadCount} offline uploads)`;
}

async function expandedImportRegression(h: BrowserHarness): Promise<void> {
	const { SourceContent } = await import("../src/catalog/SourceViews");
	const { container, mock, mount, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const added: Book = { ...book, id: "expanded-new-book", title: "新しい物語" };
	const selector = `.book-main-link[href="/materials/${added.id}"]`;
	const requests: { pageSize: number; query: string }[] = [];
	const upload: { finish?: (response: Response) => void } = {};
	let completed = false;
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
			const pageSize = Number(url.searchParams.get("page_size"));
			const query = url.searchParams.get("q") ?? "";
			check(
				pageSize === 6 || pageSize === 50,
				"Expanded regression must request preview or full catalog size",
			);
			requests.push({ pageSize, query });
			const available = completed ? [book, added] : [book];
			const items = available.filter((item) => item.title.includes(query));
			return Response.json({
				items,
				page: 1,
				page_size: pageSize,
				total: items.length,
			});
		}
		if (
			request.method === "POST" &&
			url.pathname === `/api/sources/${source.id}/materials`
		) {
			check(
				url.searchParams.get("filename") === `${added.title}.epub`,
				"Expanded regression must upload its selected EPUB",
			);
			return new Promise<Response>((resolve) => {
				upload.finish = resolve;
			});
		}
		throw new Error(
			`Unexpected expanded import request ${request.method} ${url}`,
		);
	});
	function SuccessProbe() {
		const successes = useMutationState({
			filters: { mutationKey: importKey, status: "success" },
			select: (mutation) => mutation.mutationId,
		});
		return (
			<output data-expanded-successes hidden>
				{successes.length}
			</output>
		);
	}
	function action(label: string, scope: ParentNode = container) {
		const button = [
			...scope.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.trim() === label);
		check(
			button && !button.disabled,
			`Missing expanded import action ${label}`,
		);
		return button;
	}
	localStorage.clear();
	sessionStorage.clear();
	const dispose = await mount(
		<>
			<SuccessProbe />
			<Outlet />
		</>,
		"/",
		`/sources/${source.id}?view=materials`,
		[
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
			{
				path: "materials/:id",
				element: <p data-expanded-reader>展开目录书籍阅读器</p>,
			},
		],
	);
	try {
		await until(
			() =>
				!!container.querySelector(
					"#source-content-panel-materials .book-main-link",
				),
			"Expanded regression must first load source preview",
		);
		action("导入书籍").click();
		await until(
			() => !!container.querySelector(".import-dialog[open]"),
			"Expanded regression must open the import picker",
		);
		const pickerDialog = container.querySelector<HTMLDialogElement>(
			".import-dialog[open]",
		);
		const picker =
			pickerDialog?.querySelector<HTMLInputElement>('input[type="file"]');
		check(
			pickerDialog && picker,
			"Expanded regression needs the EPUB file input",
		);
		const transfer = new DataTransfer();
		transfer.items.add(
			new File(["expanded-epub-contents"], `${added.title}.epub`, {
				type: "application/epub+zip",
			}),
		);
		picker.files = transfer.files;
		picker.dispatchEvent(new Event("change", { bubbles: true }));
		await until(
			() =>
				[...pickerDialog.querySelectorAll<HTMLButtonElement>("button")].some(
					(node) => node.textContent?.trim() === "导入" && !node.disabled,
				),
			"Expanded regression must enable import",
		);
		action("导入", pickerDialog).click();
		await until(
			() => !!upload.finish && !pickerDialog.open,
			"Expanded regression must leave upload pending after closing picker",
		);
		action("查看全部").click();
		await until(
			() => !!container.querySelector(".scoped-material-dialog[open]"),
			"View all must open the full source catalog",
		);
		const modal = container.querySelector<HTMLDialogElement>(
			".scoped-material-dialog[open]",
		);
		check(modal, "Missing expanded source catalog dialog");
		const search = modal.querySelector<HTMLInputElement>(
			'input[type="search"]',
		);
		check(search, "Expanded catalog must expose its real search toolbar");
		inputValue(search, "unmatched");
		await until(
			() =>
				requests.some(
					(request) => request.pageSize === 50 && request.query === "unmatched",
				) && modal.textContent?.includes("共 0 项") === true,
			"Expanded catalog must apply an unmatched search while import is pending",
		);
		check(
			modal.querySelectorAll(".book-import-card[aria-busy='true']").length ===
				1,
			"Filtered modal must retain exactly one pending import card",
		);
		check(upload.finish, "Missing expanded import resolver");
		completed = true;
		upload.finish(
			Response.json({
				material: { ...added, chapters: [], reading_position: null },
				reused: false,
			} satisfies components["schemas"]["MaterialImportResponse"]),
		);
		await until(
			() =>
				[...container.querySelectorAll<HTMLAnchorElement>(selector)].some(
					(node) =>
						!node.closest(".scoped-material-dialog") &&
						!node.closest(".book-import-card"),
				),
			"Completed book must enter the background six-book preview",
		);
		await renderFrames();
		const links = modal.querySelectorAll<HTMLAnchorElement>(selector);
		check(
			links.length === 1,
			`Filtered modal must retain one successful import entry despite background preview, got ${links.length}`,
		);
		const link = links[0];
		check(link, "Missing filtered modal successful reading entry");
		check(
			link.closest(".book-import-card"),
			"Filtered modal must keep its temporary successful reading entry",
		);
		check(
			!modal.querySelector(
				".import-preparation-indicator, .book-import-card[aria-busy='true']",
			),
			"Completed filtered modal import must stop spinning",
		);
		check(
			container.querySelector("[data-expanded-successes]")?.textContent === "1",
			"Background preview must not consume success while the modal owns visible reading",
		);
		check(
			requests.some(
				(request) => request.pageSize === 6 && request.query === "",
			) &&
				requests.filter(
					(request) => request.pageSize === 50 && request.query === "unmatched",
				).length >= 2,
			"Preview and filtered full catalog must refresh independently after upload",
		);
		// Probe actual browser click hit testing without leaving the modal before its close/consumption check.
		link.scrollIntoView({ block: "center" });
		await renderFrames(2);
		const rect = link.getBoundingClientRect();
		check(
			rect.width > 0 &&
				rect.height > 0 &&
				rect.left >= 0 &&
				rect.right <= innerWidth + 1,
			"Filtered modal success entry must fit the viewport",
		);
		const target = document.elementFromPoint(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
		);
		check(
			target && link.contains(target),
			"Filtered modal success entry must be the browser click target",
		);
		action("关闭", modal).click();
		await until(
			() =>
				!container.querySelector(".scoped-material-dialog[open]") &&
				container.querySelector("[data-expanded-successes]")?.textContent ===
					"0",
			"Closing full catalog must allow the visible source preview to consume successful import state",
		);
		check(
			container.querySelectorAll(selector).length === 1 &&
				!container.querySelector(".book-import-card"),
			"Visible preview must retain exactly one real reading entry after consuming success",
		);
		const finalLink = container.querySelector<HTMLAnchorElement>(selector);
		check(finalLink, "Missing final preview reader link");
		finalLink.click();
		await until(
			() => !!container.querySelector("[data-expanded-reader]"),
			"Recovered visible preview must open the imported book reader",
		);
	} finally {
		dispose();
	}
}
