import { Outlet, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { Book } from "../src/catalog/api";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";
import "../src/catalog/source-content.css";
import "../src/catalog/sources-s2.css";
import "../src/catalog/import-dialog.css";

const source: Source = {
	id: "overview-source",
	title: "来源概览导入回归",
	description: "",
	note: "",
	segment_count: 0,
	created_at: "2026-10-25T00:00:00Z",
	updated_at: "2026-10-25T00:00:00Z",
};
const other = { ...source, id: "other-source", title: "另一个来源" };
function book(id: string, title: string): Book {
	return {
		id,
		title,
		version_id: `v-${id}`,
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
export async function overviewImportRegression(
	h: BrowserHarness,
	preview = false,
): Promise<string> {
	const { SourceContent } = await import("../src/catalog/SourceViews");
	const { container, until, mount, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const items: Book[] = [];
	let learning = false;
	const uploads: {
		filename: string;
		body: string;
		finish: (response: Response) => void;
	}[] = [];
	mock(async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/api/sources")
			return Response.json([source, other]);
		if (request.method === "GET" && url.pathname === "/api/materials") {
			check(
				url.searchParams.get("source_id") !== null,
				"Overview must scope its material query",
			);
			const scoped =
				url.searchParams.get("source_id") === source.id ? items : [];
			return Response.json({
				items: scoped.slice(0, 3),
				total: scoped.length,
				page: 1,
				page_size: 3,
			});
		}
		if (
			request.method === "GET" &&
			/\/catalog\/(analyses|segments)$/.test(url.pathname)
		) {
			const segments =
				learning && url.pathname.endsWith("/segments")
					? [
							{
								id: "segment",
								source_id: source.id,
								text: "既存の学習資料。",
								source_ref: "",
								material_provenance: null,
								created_at: source.created_at,
								updated_at: source.updated_at,
							},
						]
					: [];
			return Response.json({
				items: segments,
				total: segments.length,
				page: 1,
				page_size: 3,
			});
		}
		if (
			request.method === "POST" &&
			url.pathname === `/api/sources/${source.id}/materials`
		) {
			const filename = url.searchParams.get("filename");
			check(filename, "Import must retain filename");
			const body = await request.text();
			return new Promise<Response>((finish) =>
				uploads.push({ filename, body, finish }),
			);
		}
		throw new Error(
			`Unexpected overview request ${request.method} ${url.pathname}`,
		);
	});
	function Routes() {
		const navigate = useNavigate();
		const location = useLocation();
		const current = location.pathname.endsWith(other.id) ? other : source;
		return (
			<>
				<nav aria-label="回归导航">
					<button
						type="button"
						onClick={() => navigate(`/sources/${source.id}`)}
					>
						原来源
					</button>
					<button
						type="button"
						onClick={() => navigate(`/sources/${other.id}`)}
					>
						其他来源
					</button>
				</nav>
				<output data-test-path>
					{location.pathname}
					{location.search}
				</output>
				<SourceContent
					key={current.id}
					source={current}
					onAddSegment={() => {}}
					onShowInfo={() => {}}
				/>
				<Outlet />
			</>
		);
	}
	function action(label: string, scope: ParentNode = container) {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent?.trim() === label,
		);
		check(found && !found.disabled, `Missing enabled overview action ${label}`);
		return found;
	}
	const card = (title: string) =>
		[...container.querySelectorAll<HTMLElement>(".book-import-card")].find(
			(node) => node.getAttribute("aria-label") === title,
		);
	const dialog = () =>
		container.querySelector<HTMLDialogElement>(".import-dialog[open]");
	async function start(filename: string) {
		action(
			container.querySelector(".source-welcome") ? "导入素材" : "导入书籍",
		).click();
		await until(() => !!dialog(), "Overview import dialog must open");
		const picker =
			dialog()?.querySelector<HTMLInputElement>('input[type="file"]');
		check(picker, "Missing file picker");
		const select = dialog()?.querySelector<HTMLSelectElement>("select");
		check(
			select?.value === source.id && select.disabled,
			"Overview import must lock its source",
		);
		const transfer = new DataTransfer();
		transfer.items.add(
			new File([`epub:${filename}`], filename, {
				type: "application/epub+zip",
			}),
		);
		picker.files = transfer.files;
		picker.dispatchEvent(new Event("change", { bubbles: true }));
		await until(
			() =>
				[
					...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
				].some((node) => node.textContent?.trim() === "导入" && !node.disabled),
			"File selection must enable import",
		);
		const before = uploads.length;
		action("导入", dialog() ?? container).click();
		await until(
			() => !dialog() && uploads.length === before + 1,
			"Import must immediately close dialog",
		);
		return before;
	}
	async function pending(title: string) {
		await until(
			() => !!card(title),
			`Overview pending card ${title} must remain visible`,
		);
		const node = card(title);
		check(
			node?.getAttribute("aria-busy") === "true" &&
				node.textContent?.includes("正在准备书籍和注音…"),
			"Overview must explain pending preparation",
		);
		check(
			!node.querySelector("a, .book-menu-trigger"),
			"Pending import cannot open reader or book menu",
		);
		const bounds = node.getBoundingClientRect();
		check(
			bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1,
			"Overview pending card must fit viewport",
		);
		const cover = node.querySelector(".book-cover")?.getBoundingClientRect();
		check(
			cover && cover.width === 55 && cover.height === 77,
			"Overview import must retain compact cover geometry",
		);
	}
	function complete(index: number, item: Book) {
		items.push(item);
		const result: components["schemas"]["MaterialImportResponse"] = {
			material: { ...item, chapters: [], reading_position: null },
			reused: false,
		};
		uploads[index]?.finish(Response.json(result));
	}
	localStorage.clear();
	sessionStorage.clear();
	const dispose = await mount(
		<Routes />,
		"/sources/:id",
		`/sources/${source.id}`,
	);
	try {
		await until(
			() => !!container.querySelector(".source-welcome"),
			"Zero-content source must open its default overview",
		);
		const failed = await start("失敗.epub");
		await pending("失敗");
		if (preview)
			return "overview import: compact pending preview in zero-content default overview";
		action("其他来源").click();
		await until(
			() => !!container.querySelector(".source-welcome"),
			"Other source overview must settle",
		);
		check(!card("失敗"), "Import from another source must not appear here");
		action("原来源").click();
		await pending("失敗");
		uploads[failed]?.finish(
			Response.json({ detail: "概览准备失败" }, { status: 500 }),
		);
		await until(
			() => !!card("失敗")?.textContent?.includes("概览准备失败"),
			"Overview must display import failure",
		);
		const failedCard = card("失敗");
		check(failedCard, "Missing failed overview card");
		action("重试", failedCard).click();
		await until(
			() => uploads.length === 2,
			"Retry must submit original EPUB again",
		);
		await pending("失敗");
		check(
			uploads[0]?.filename === uploads[1]?.filename &&
				uploads[0]?.body === uploads[1]?.body,
			"Retry must retain original File name and bytes",
		);
		uploads[1]?.finish(
			Response.json({ detail: "再次准备失败" }, { status: 500 }),
		);
		await until(
			() => !!card("失敗")?.textContent?.includes("再次准备失败"),
			"Retry failure must remain actionable",
		);
		const removable = card("失敗");
		check(removable, "Missing removable card");
		action("移除", removable).click();
		await until(
			() => !card("失敗") && !!container.querySelector(".source-welcome"),
			"Removing last failure must restore empty welcome",
		);
		const success = await start("新しい本.epub");
		await pending("新しい本");
		complete(success, book("new-book", "新しい本"));
		await until(
			() =>
				container.querySelectorAll('a[href="/materials/new-book"]').length ===
					1 && !card("新しい本"),
			"Completed book must replace pending card with one reader link",
		);
		check(
			container
				.querySelector("[data-test-path]")
				?.textContent?.split("?")[0] === `/sources/${source.id}`,
			"Successful overview import must not navigate",
		);
		const hidden = await start("プレビュー外.epub");
		await pending("プレビュー外");
		items.push(book("preview-two", "二冊目"), book("preview-three", "三冊目"));
		complete(hidden, book("outside-preview", "プレビュー外"));
		await until(
			() =>
				!!card("プレビュー外")?.querySelector(
					'a[href="/materials/outside-preview"]',
				),
			"Success omitted by overview preview must retain a temporary reader link",
		);
		check(
			card("プレビュー外")?.getAttribute("aria-busy") === "false",
			"Successful temporary card must stop preparing",
		);
		learning = true;
		action("其他来源").click();
		await until(
			() => !!container.querySelector(".overview-learning"),
			"Existing learning content must activate reference sidebar",
		);
		action("原来源").click();
		await until(
			() => !!container.querySelector(".overview-reference .overview-books"),
			"Overview with learning content must show compact reference sidebar",
		);
		const compact = await start("側欄.epub");
		await pending("側欄");
		check(
			card("側欄")?.closest(".overview-reference"),
			"Pending import must appear beside existing overview materials",
		);
		uploads[compact]?.finish(
			Response.json({ detail: "侧栏导入失败" }, { status: 500 }),
		);
		await until(
			() => !!card("側欄")?.textContent?.includes("侧栏导入失败"),
			"Sidebar import must retain failure feedback",
		);
		return `overview import: immediate close, pending/error, same-file retry, removal, source isolation, success without navigation, out-of-preview reading link and compact sidebar verified at ${innerWidth}px (${uploads.length} mocked uploads)`;
	} finally {
		if (!preview) dispose();
	}
}
