import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const timestamp = "2026-10-29T00:00:00Z";
const materialId = "position-bookmarks";
const hash = "a".repeat(64);
const paragraphs = Array.from(
	{ length: 100 },
	(_, index) =>
		`第${String(index).padStart(3, "0")}段落。春の風が静かな庭を通り抜ける。`,
);
const text = paragraphs.join("");
const offsetAt = (index: number) => paragraphs.slice(0, index).join("").length;
const title = "第一章・庭の記憶";
const imageTitle = "第二章・挿絵";
const stressExcerpt = `${paragraphs[8]}${"遠い日の記憶をたどりながら、庭の小道をゆっくり歩いた。".repeat(12)}摘要の終わり。`;
const stressNote = `冒頭の記憶${"。窓辺の描写と庭の風景を比較して読み返す".repeat(24)}。备注の終わり。`;
const image =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1200"><rect width="600" height="1200" fill="#d8e5df"/><circle cx="300" cy="360" r="180" fill="#527d78"/><text x="160" y="720" font-size="60">挿絵 七</text></svg>',
	);
const chapters: Schema["MaterialChapterResponse"][] = [
	{
		id: "text-chapter",
		material_id: materialId,
		version_id: "v1",
		title,
		level: 0,
		resources: [
			{
				id: "text-resource",
				text,
				text_sha256: hash,
				href: "one.xhtml",
				css: "p{margin:0 0 1.8em}",
				html_attributes: { lang: "ja" },
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "text-resource",
				spine_index: 0,
				start: 0,
				end: text.length,
				leaf_start: 0,
				leaf_end: paragraphs.length,
				html: paragraphs
					.map(
						(value, index) =>
							`<p><span data-locator-leaf="${index}">${value}</span></p>`,
					)
					.join(""),
			},
		],
	},
	{
		id: "image-chapter",
		material_id: materialId,
		version_id: "v1",
		title: imageTitle,
		level: 0,
		resources: [
			{
				id: "image-resource",
				text: "",
				text_sha256: hash,
				href: "two.xhtml",
				css: "",
				html_attributes: {},
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "image-resource",
				spine_index: 1,
				start: 0,
				end: 0,
				leaf_start: 0,
				leaf_end: 0,
				html: `<img data-epub-image="7" src="${image}" alt="庭の挿絵">`,
			},
		],
	},
];

/** Real reader controls, source frames and persistence; every HTTP request stays offline. */
export async function positionBookmarks(h: BrowserHarness) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const { bookmarkDraftSession } = await import(
		"../src/materials/bookmark-drafts"
	);
	const { bookmarkKeys } = await import("../src/materials/bookmarks-api");
	const check: BrowserHarness["check"] = h.check;
	const { container, until, inputValue } = h;
	const parameters = new URLSearchParams(location.search);
	const vertical = parameters.get("direction") === "vertical-rl";
	const detailed = !vertical && innerWidth > 720;
	const nativeConfirm = window.confirm;
	let confirmations = 0;
	window.confirm = () => {
		confirmations++;
		throw new Error(
			"Bookmark deletion must use the built-in confirmation dialog",
		);
	};
	const capture = parameters.has("capture") || parameters.has("preview");
	const longExcerpt = parameters.has("compact")
		? `${paragraphs[8]}遠い日の記憶をたどりながら、庭の小道をゆっくり歩いた。窓辺に揺れる木漏れ日を見て、もう少しここにいたいと思った。`
		: stressExcerpt;
	const longNote = parameters.has("compact")
		? "冒頭の記憶。窓辺の描写と庭の風景を比較して読み返す。"
		: stressNote;
	localStorage.clear();
	localStorage.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({
			focus: false,
			theme: parameters.get("theme") === "light" ? "white" : "black",
		}),
	);
	const browserKey = (
		window as Window & { browserKey?: (key: "Escape" | "Tab") => Promise<void> }
	).browserKey;
	const browserPointer = (
		window as Window & {
			browserPointer?: (
				events: {
					type: string;
					x: number;
					y: number;
					button?: "left";
					clickCount?: number;
				}[],
			) => Promise<void>;
		}
	).browserPointer;
	const settings: Schema["ReadingSettings"] = {
		font_size: 22,
		line_height: 2,
		writing_mode: vertical ? "vertical-rl" : "horizontal-tb",
	};
	const anchor = (index: number): Schema["PositionAnchor"] => ({
		version_id: "v1",
		chapter_id: "text-chapter",
		resource_id: "text-resource",
		part_index: 0,
		kind: "text",
		offset: offsetAt(index),
		at_chapter_end: false,
	});
	const makeBookmark = (
		id: string,
		position: Schema["PositionAnchor"],
		note = "",
	): Schema["BookmarkResponse"] => ({
		id,
		material_id: materialId,
		position,
		chapter_title: position.chapter_id === "text-chapter" ? title : imageTitle,
		chapter_progress:
			position.kind === "text" ? (position.offset ?? 0) / text.length : 0.45,
		excerpt:
			position.kind === "text"
				? (paragraphs[
						Math.floor((position.offset ?? 0) / (paragraphs[0]?.length ?? 1))
					] ?? "庭の原文")
				: "庭の挿絵",
		note,
		revision: 0,
		created_at: timestamp,
		updated_at: timestamp,
	});
	const records = [
		{ ...makeBookmark("early", anchor(8), longNote), excerpt: longExcerpt },
		makeBookmark("late", anchor(65), "後で読み返す"),
		makeBookmark("illustration", {
			version_id: "v1",
			chapter_id: "image-chapter",
			resource_id: "image-resource",
			part_index: 0,
			kind: "image",
			image_id: 7,
			image_progress: 0.45,
			at_chapter_end: false,
		}),
	];
	const book: Schema["MaterialResponse"] = {
		id: materialId,
		source_id: "source",
		title: "位置書籤の回帰読本",
		version_id: "v1",
		contract_version: "1",
		product_sha256: hash,
		source_sha256: hash,
		created_at: timestamp,
		warnings: [],
		chapters: chapters.map((chapter) => ({
			id: chapter.id,
			title: chapter.title,
			level: 0,
			part_count: 1,
		})),
		reading_position: {
			...anchor(30),
			progress: 0.3,
			revision: 0,
			updated_at: timestamp,
			settings,
		},
	};
	const writes: Schema["ReadingPositionUpdate"][] = [];
	const creates: Schema["BookmarkCreate"][] = [];
	const patches: Schema["BookmarkUpdate"][] = [];
	const deletes: string[] = [];
	const deleteRequests: { id: string; expected_revision: number }[] = [];
	let listReads = 0;
	let listPageLimit: number | undefined;
	let listUnavailable = false;
	let singleReads = 0;
	let opened = 0;
	let nextPatch: "ok" | "failure" | "conflict" = "ok";
	let nextDelete: "ok" | "failure" | "conflict" = "ok";
	let nextCreate: "ok" | "nearby" | "failure" = "nearby";
	let releaseCreate: (() => void) | undefined;
	let holdCreate = true;
	let createSerial = 0;
	h.mock(async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === "/api/settings/context-copy" && request.method === "GET")
			return Response.json(defaultContextCopySettings);
		if (path === `/api/materials/${materialId}`) return Response.json(book);
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "離線資料",
				description: "",
				note: "",
				segment_count: 0,
				created_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["SourceResponse"]);
		if (path.endsWith("/opened") || path.endsWith("/usage")) {
			if (path.endsWith("/opened")) opened++;
			return Response.json({
				material_id: materialId,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["MaterialUsageResponse"]);
		}
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: materialId,
				version_id: "v1",
				generation_id: "g",
				token_count: 0,
			});
		if (path.endsWith("/readings"))
			return Response.json({
				material_id: materialId,
				version_id: "v1",
				generation_id: "g",
				resources: [],
			});
		const chapter = chapters.find(
			(item) => path === `/api/materials/${materialId}/chapters/${item.id}`,
		);
		if (chapter) return Response.json(chapter);
		if (
			path.endsWith("/segments") ||
			/\/chapters\/[^/]+\/translations$/.test(path)
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/translations"))
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			writes.push(update);
			return Response.json({
				...update,
				revision: update.expected_revision + 1,
				progress: 0.3,
				updated_at: timestamp,
			});
		}
		if (path === `/api/materials/${materialId}/bookmarks`) {
			if (request.method === "GET") {
				listReads++;
				if (listUnavailable)
					return Response.json({ detail: "来源不可用" }, { status: 404 });
				check(
					url.searchParams.get("version_id") === "v1",
					"Bookmark list must be scoped to the current version",
				);
				const offset = Number(url.searchParams.get("offset") ?? 0);
				const limit = Number(url.searchParams.get("limit") ?? 40);
				const ordered = [...records].sort(
					(a, b) =>
						chapters.findIndex(
							(chapter) => chapter.id === a.position.chapter_id,
						) -
							chapters.findIndex(
								(chapter) => chapter.id === b.position.chapter_id,
							) || (a.position.offset ?? 0) - (b.position.offset ?? 0),
				);
				return Response.json({
					material_id: materialId,
					version_id: "v1",
					total: ordered.length,
					offset,
					limit: listPageLimit ?? limit,
					items: ordered.slice(offset, offset + (listPageLimit ?? limit)),
				});
			}
			if (request.method === "POST") {
				const body: Schema["BookmarkCreate"] = await request.json();
				creates.push(body);
				if (holdCreate)
					await new Promise<void>((resolve) => {
						releaseCreate = resolve;
					});
				const behavior = nextCreate;
				nextCreate = "ok";
				if (behavior === "nearby" && !body.allow_nearby)
					return Response.json({ kind: "nearby", bookmark: records[0] });
				if (behavior === "failure")
					return Response.json({ detail: "首次响应失败" }, { status: 503 });
				const record = makeBookmark(`created-${++createSerial}`, body.position);
				records.push(record);
				return Response.json(record);
			}
		}
		const bookmark = records.find(
			(item) => path === `/api/materials/${materialId}/bookmarks/${item.id}`,
		);
		if (bookmark) {
			if (request.method === "GET") {
				singleReads++;
				return Response.json(bookmark);
			}
			if (request.method === "PATCH") {
				const update: Schema["BookmarkUpdate"] = await request.json();
				patches.push(update);
				const behavior = nextPatch;
				nextPatch = "ok";
				if (behavior === "failure")
					return Response.json({ detail: "離線保存失敗" }, { status: 503 });
				if (behavior === "conflict") {
					bookmark.revision++;
					bookmark.note = "另一窗口的备注";
					return Response.json(
						{ detail: "书签已被其他操作修改" },
						{ status: 409 },
					);
				}
				if (update.expected_revision !== bookmark.revision)
					return Response.json(
						{ detail: "书签已被其他操作修改" },
						{ status: 409 },
					);
				check(
					update.expected_revision === bookmark.revision,
					"Saving a note must use its current revision",
				);
				bookmark.note = update.note;
				bookmark.revision++;
				return Response.json(bookmark);
			}
			if (request.method === "DELETE") {
				deletes.push(bookmark.id);
				const expectedRevision = Number(
					url.searchParams.get("expected_revision"),
				);
				deleteRequests.push({
					id: bookmark.id,
					expected_revision: expectedRevision,
				});
				const behavior = nextDelete;
				nextDelete = "ok";
				if (behavior === "failure")
					return Response.json({ detail: "離線削除失敗" }, { status: 503 });
				if (behavior === "conflict") {
					bookmark.revision++;
					return Response.json({ detail: "书签已更新" }, { status: 409 });
				}
				if (expectedRevision !== bookmark.revision)
					return Response.json(
						{ detail: "书签已被其他操作修改" },
						{ status: 409 },
					);
				check(
					Number(url.searchParams.get("expected_revision")) ===
						bookmark.revision,
					"Delete must use the current bookmark revision",
				);
				records.splice(records.indexOf(bookmark), 1);
				return new Response(null, { status: 204 });
			}
		}
		if (
			path.startsWith(`/api/materials/${materialId}/bookmarks/`) &&
			request.method === "GET"
		) {
			singleReads++;
			return Response.json({ detail: "书签已不存在" }, { status: 404 });
		}
		throw new Error(
			`Unmocked position-bookmark request ${request.method} ${path}`,
		);
	});
	let queryClient: QueryClient | undefined;
	function ReaderScenario() {
		const client = useQueryClient();
		useEffect(() => {
			queryClient = client;
			return () => {
				queryClient = undefined;
			};
		}, [client]);
		return <MaterialReader />;
	}
	const refreshList = async () => {
		check(queryClient, "Mounted reader must expose its actual query client");
		const before = listReads;
		await queryClient.invalidateQueries({
			queryKey: bookmarkKeys.list(materialId, "v1"),
		});
		await until(
			() => listReads > before,
			"Background invalidation must refetch the active bookmark list",
		);
	};
	let dispose = await h.mount(
		<ReaderScenario />,
		"/materials/:id",
		`/materials/${materialId}`,
	);
	const find = <T extends Element>(selector: string): T => {
		const node = container.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const button = (
		name: string,
		scope: ParentNode = container,
	): HTMLButtonElement => {
		const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) =>
				(candidate.getAttribute("aria-label") ??
					candidate.textContent?.trim()) === name &&
				!candidate.closest("[hidden],[inert]"),
		);
		check(
			node && !node.disabled,
			`Missing or disabled button ${name}; controls=${[...scope.querySelectorAll("button")].map((node) => `${node.getAttribute("aria-label") ?? node.textContent?.trim()} [disabled=${node.disabled},inert=${!!node.closest("[inert]")},hidden=${!!node.closest("[hidden]")}]`).join("|")}`,
		);
		return node;
	};
	const items = () => [
		...container.querySelectorAll<HTMLLIElement>(
			'ol[aria-label="位置书签"] > li',
		),
	];
	const itemContaining = (value: string) => {
		const item = items().find((item) => item.textContent?.includes(value));
		check(item, `Missing bookmark containing ${value}`);
		return item;
	};
	const edit = () =>
		find<HTMLTextAreaElement>('textarea[aria-label="书签备注"]');
	const detail = () =>
		container.querySelector<HTMLElement>(
			'.reader-bookmark-detail[role="dialog"]:popover-open',
		);
	const openDetail = async (item: HTMLLIElement) => {
		const opener = item.querySelector<HTMLButtonElement>(
			".reader-bookmark-open",
		);
		check(opener, "Each bookmark needs a separate detail action");
		opener.focus();
		opener.click();
		await until(
			() => !!detail()?.querySelector(".reader-bookmark-detail-excerpt"),
			"Bookmark detail must open and finish current-item validation",
		);
		return detail() as HTMLElement;
	};
	const closeDetail = async () => {
		if (!detail()) return;
		button("关闭书签详情", detail() as HTMLElement).click();
		await until(() => !detail(), "Bookmark detail must close");
	};
	const beginEdit = async (item: HTMLLIElement) => {
		await closeDetail();
		const opened = await openDetail(item);
		if (!opened.querySelector('textarea[aria-label="书签备注"]'))
			button(
				opened.textContent?.includes("编辑备注") ? "编辑备注" : "添加备注",
				opened,
			).click();
		await until(
			() => !!container.querySelector('textarea[aria-label="书签备注"]'),
			"Bookmark editor must open",
		);
	};
	const confirmDelete = async () => {
		const confirmation = container.querySelector<HTMLDialogElement>(
			"dialog.reader-bookmark-confirm[open]",
		);
		check(confirmation, "Deletion must open a built-in modal confirmation");
		button("删除书签", confirmation).click();
	};
	const viewport = () => find<HTMLElement>(".reader-viewport");
	const frames = () => [
		...container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	const visibleParagraphs = () => {
		const view = viewport().getBoundingClientRect();
		return frames().flatMap((frame) => {
			const outer = frame.getBoundingClientRect();
			return [
				...(frame.contentDocument?.querySelectorAll<HTMLElement>(
					"[data-locator-leaf]",
				) ?? []),
			]
				.filter((leaf) =>
					[...leaf.getClientRects()].some(
						(rect) =>
							outer.left + rect.right > view.left &&
							outer.left + rect.left < view.right &&
							outer.top + rect.bottom > view.top &&
							outer.top + rect.top < view.bottom,
					),
				)
				.map((leaf) => Number(leaf.dataset.locatorLeaf));
		});
	};
	const openBookmarks = async () => {
		if (!container.querySelector('[role="dialog"]:not([inert]) [role="tab"]'))
			button("目录").click();
		await until(
			() =>
				!!container.querySelector('[role="dialog"]:not([inert]) [role="tab"]'),
			"Navigation must open",
		);
		button("书签").click();
		await until(
			() => items().length === records.length,
			"Persistent bookmark list must load",
		);
	};
	const closeNavigation = async () => {
		await closeDetail();
		button("关闭书内导航").click();
		await until(
			() => !container.querySelector('[role="dialog"]:not([inert])'),
			"Navigation must close",
		);
	};
	try {
		await until(
			() => opened > 0 && writes.length > 0 && visibleParagraphs().includes(30),
			"Reader must restore its original midpoint before adding a bookmark",
		);
		const originalVisible = visibleParagraphs();
		button("添加当前位置书签").click();
		await until(
			() => Number(creates.length) === 1,
			"Toolbar add must submit a bookmark",
		);
		const firstCreate = creates[0];
		check(
			firstCreate &&
				firstCreate.position.kind === "text" &&
				firstCreate.request_id,
			"Add must send a text anchor and idempotency identity",
		);
		check(
			Math.abs((firstCreate.position.offset ?? 0) - offsetAt(30)) <
				(paragraphs[30]?.length ?? 0) * 2,
			"Adding must capture the actual source at the reading edge",
		);
		const frozen = JSON.stringify(firstCreate.position);
		const beforeScroll = writes.length;
		if (vertical) viewport().scrollLeft -= viewport().clientWidth * 2;
		else viewport().scrollTop += viewport().clientHeight * 2;
		viewport().dispatchEvent(new Event("scroll"));
		await until(
			() => writes.length > beforeScroll && !visibleParagraphs().includes(30),
			"Reader must move while bookmark creation remains pending",
		);
		check(
			JSON.stringify(firstCreate.position) === frozen &&
				Number(creates.length) === 1,
			"Pending creation must retain the clicked anchor during subsequent scrolling",
		);
		check(releaseCreate, "Pending create release must exist");
		holdCreate = false;
		releaseCreate();
		await until(
			() =>
				!!container
					.querySelector(".reader-bookmark-notice")
					?.textContent?.includes("附近已有书签"),
			"Nearby response must show an explicit choice",
		);
		check(
			records.length === 3 &&
				!container
					.querySelector(".reader-bookmark-notice")
					?.textContent?.includes("已添加书签"),
			"Nearby detection must not create a bookmark or announce success",
		);
		const beforeNearbyView = visibleParagraphs().join(",");
		button("查看已有").click();
		await until(
			() => !!detail()?.querySelector(".reader-bookmark-detail-excerpt"),
			"View existing must open and validate bookmark details",
		);
		check(
			visibleParagraphs().join(",") === beforeNearbyView &&
				!container.querySelector(".reader-return-origin"),
			"Viewing an existing nearby bookmark must not navigate",
		);
		check(
			detail()?.textContent?.includes(longExcerpt) &&
				detail()?.textContent?.includes(longNote),
			"Nearby details must show the complete excerpt and note",
		);
		await closeNavigation();

		nextCreate = "nearby";
		button("添加当前位置书签").click();
		await until(
			() =>
				!!container
					.querySelector(".reader-bookmark-notice")
					?.textContent?.includes("附近已有书签"),
			"A new add must work after viewing an existing bookmark",
		);
		button("关闭书签提示").click();
		await until(
			() => !container.querySelector(".reader-bookmark-notice"),
			"Dismissing nearby choice must close it",
		);
		check(
			records.length === 3 && Number(creates.length) === 2,
			"Dismissing nearby choice must not write a bookmark",
		);

		nextCreate = "nearby";
		button("添加当前位置书签").click();
		await until(
			() =>
				Number(creates.length) === 3 &&
				!!container
					.querySelector(".reader-bookmark-notice")
					?.textContent?.includes("附近已有书签"),
			"Dismissal must allow another independent add",
		);
		const forcedRequest = creates[2];
		check(
			forcedRequest && forcedRequest.request_id !== firstCreate.request_id,
			"A new attempt must receive a new request identity",
		);
		const forcedPosition = JSON.stringify(forcedRequest.position);
		const beforeForceScroll = visibleParagraphs().join(",");
		if (vertical) viewport().scrollLeft += viewport().clientWidth;
		else viewport().scrollTop -= viewport().clientHeight;
		viewport().dispatchEvent(new Event("scroll"));
		await until(
			() => visibleParagraphs().join(",") !== beforeForceScroll,
			"Reader must scroll while nearby confirmation is pending",
		);
		nextCreate = "failure";
		button("仍然添加").click();
		await until(
			() =>
				Number(creates.length) === 4 &&
				!!container.querySelector(".reader-bookmark-notice [role=alert]"),
			"Forced add failure must offer an explicit retry",
		);
		check(
			creates[3]?.allow_nearby === true &&
				creates[3]?.request_id === forcedRequest.request_id &&
				JSON.stringify(creates[3]?.position) === forcedPosition,
			"Forced addition must preserve the first anchor and request identity after scrolling",
		);
		button("添加当前位置书签").click();
		check(
			Number(creates.length) === 4,
			"A pending failed creation must block sampling a new position",
		);
		button("重试保存书签").click();
		await until(
			() => Number(creates.length) === 5,
			"Forced creation must retry",
		);
		check(
			creates[4]?.allow_nearby === true &&
				creates[4]?.request_id === forcedRequest.request_id &&
				JSON.stringify(creates[4]?.position) === forcedPosition,
			"Retry after force failure must retain allow_nearby, UUID and original position",
		);
		await until(
			() =>
				!!container
					.querySelector('[role="status"]')
					?.textContent?.includes("已添加书签"),
			"Successful addition must show a light confirmation",
		);
		const noticeExcerpt = find<HTMLElement>(".reader-bookmark-notice span");
		check(
			getComputedStyle(noticeExcerpt).whiteSpace === "nowrap" ||
				getComputedStyle(noticeExcerpt).webkitLineClamp === "1",
			"Successful toast must limit the excerpt to one line",
		);
		check(
			button("添加备注").classList.contains("reader-bookmark-note-action"),
			"Quick note must use the visible blue note action",
		);
		button("添加备注").click();
		await until(
			() => !!container.querySelector('textarea[aria-label="书签备注"]'),
			"Quick note action must open the newly saved bookmark editor",
		);
		check(
			!container.querySelector(".reader-bookmark-notice"),
			"Opening quick note editing must dismiss the old creation notice",
		);
		await until(
			() => document.activeElement === edit(),
			"Quick note editing must focus its labelled textarea",
		);
		const note = "風の描写を読み返す";
		inputValue(edit(), note);
		await until(
			() => edit().value === note,
			"Quick note editor must accept a draft",
		);
		button("保存备注").click();
		await until(
			() =>
				records.some(
					(record) => record.id === "created-1" && record.note === note,
				) && !container.querySelector('textarea[aria-label="书签备注"]'),
			"Quick note must persist",
		);
		await closeDetail();
		await openBookmarks();
		check(
			items()
				.map((item) => item.textContent)
				.join("|")
				.indexOf("冒頭の記憶") <
				items()
					.map((item) => item.textContent)
					.join("|")
					.indexOf(note),
			"List must put an earlier source position before a newly added bookmark",
		);
		check(
			items().at(-1)?.textContent?.includes(imageTitle),
			"Bookmarks must follow book order across chapters",
		);
		check(
			items().every(
				(item) =>
					item.textContent?.includes(title) ||
					item.textContent?.includes(imageTitle),
			),
			"Each bookmark must display its chapter title",
		);
		check(
			itemContaining(note).textContent?.includes("段落"),
			"A text bookmark must show nearby original text",
		);
		const longItem = itemContaining("冒頭の記憶");
		const excerptPreview = longItem.querySelector<HTMLElement>(
			".reader-bookmark-excerpt",
		);
		const notePreview = longItem.querySelector<HTMLElement>(
			".reader-bookmark-note",
		);
		check(
			excerptPreview && notePreview,
			"List must show separate excerpt and note previews",
		);
		check(
			getComputedStyle(excerptPreview).webkitLineClamp === "2",
			"List excerpt must be capped at two lines",
		);
		check(
			getComputedStyle(notePreview).webkitLineClamp === "1" ||
				getComputedStyle(notePreview).whiteSpace === "nowrap",
			"List note must be capped at one line",
		);
		check(
			longItem.textContent?.includes("章内约 8%"),
			"List progress must refer to the bookmark chapter",
		);
		const beforeDetailPosition = visibleParagraphs().join(",");
		longItem.scrollIntoView({ block: "nearest" });
		let lastCardBounds = "";
		let stableCardFrames = 0;
		await until(() => {
			const bounds = JSON.stringify(longItem.getBoundingClientRect().toJSON());
			stableCardFrames = bounds === lastCardBounds ? stableCardFrames + 1 : 0;
			lastCardBounds = bounds;
			return (
				stableCardFrames >= 3 &&
				container
					.getAnimations({ subtree: true })
					.every((animation) => animation.playState !== "running")
			);
		}, "Navigation and card geometry must settle before dispatching a real padding click");
		const cardBounds = longItem.getBoundingClientRect();
		const opener = longItem.querySelector<HTMLButtonElement>(
			".reader-bookmark-open",
		);
		check(opener, "Card must retain a semantic keyboard button");
		const corner = { x: cardBounds.left + 4, y: cardBounds.top + 4 };
		check(
			document
				.elementFromPoint(corner.x, corner.y)
				?.closest(".reader-bookmark-open") === opener,
			"Card padding must belong to its detail action",
		);
		opener.focus({ preventScroll: true });
		if (browserPointer) {
			await browserPointer([
				{ type: "mouseMoved", ...corner },
				{ type: "mousePressed", ...corner, button: "left", clickCount: 1 },
				{ type: "mouseReleased", ...corner, button: "left", clickCount: 1 },
			]);
		} else opener.click();
		await until(
			() => !!detail()?.querySelector(".reader-bookmark-detail-excerpt"),
			"Clicking card padding must open the complete detail",
		);
		const fullDetail = detail() as HTMLElement;
		check(
			longItem.dataset.selected === "true",
			"Open detail must persistently emphasize its card",
		);
		const unselected = items().find((item) => item !== longItem);
		check(
			unselected &&
				getComputedStyle(unselected).borderColor !==
					getComputedStyle(longItem).borderColor,
			"Selected card must have a distinct border after focus moves into detail",
		);
		const createdTime = fullDetail.querySelector<HTMLTimeElement>("time");
		check(
			createdTime?.dateTime === timestamp &&
				!!createdTime.textContent?.includes("2026"),
			"Detail must display the actual creation date and time",
		);
		const footer = fullDetail.querySelector<HTMLElement>(
			".reader-bookmark-detail-actions",
		);
		check(
			footer &&
				footer.getBoundingClientRect().bottom <= innerHeight &&
				footer.getBoundingClientRect().height > 0,
			"Long detail must keep its action footer visible",
		);
		await until(
			() => fullDetail.contains(document.activeElement),
			"Opening detail must move keyboard focus into it",
		);
		check(
			visibleParagraphs().join(",") === beforeDetailPosition,
			"Clicking the card main area must show details without navigation",
		);
		check(
			fullDetail.textContent?.includes(longExcerpt) &&
				fullDetail.textContent?.includes(longNote),
			"Detail must retain the complete excerpt and note beyond list truncation",
		);
		const detailBounds = fullDetail.getBoundingClientRect();
		check(
			detailBounds.left >= -1 &&
				detailBounds.right <= innerWidth + 1 &&
				detailBounds.top >= -1 &&
				detailBounds.bottom <= innerHeight + 1 &&
				fullDetail.scrollWidth <= fullDetail.clientWidth + 1,
			"Long details must fit narrow and wide viewports without horizontal overflow",
		);
		if (browserKey) {
			await browserKey("Tab");
			check(
				fullDetail.contains(document.activeElement),
				"Tab from the detail close action must remain in its controls",
			);
			await browserKey("Escape");
		} else {
			check(
				parameters.has("preview"),
				"Automated runner must expose native keyboard dispatch",
			);
			button("关闭书签详情", fullDetail).click();
		}
		await until(() => !detail(), "Escape must close bookmark details");
		await until(
			() =>
				document.activeElement ===
				longItem.querySelector(".reader-bookmark-open"),
			"Closing detail must restore focus to its card action",
		);
		await until(
			() => !longItem.hasAttribute("data-selected"),
			"Closing detail must clear persistent selection",
		);
		const quick = makeBookmark("quick-delete", anchor(11), "快捷删除测试");
		records.push(quick);
		await refreshList();
		await until(
			() => items().length === records.length,
			"Shortcut deletion fixture must load",
		);
		const quickItem = itemContaining(quick.note);
		const shortcut = quickItem.querySelector<HTMLButtonElement>(
			".reader-bookmark-quick-delete",
		);
		check(shortcut, "Every card must offer a shortcut delete icon");
		quickItem.scrollIntoView({ block: "nearest" });
		const shortcutBounds = shortcut.getBoundingClientRect();
		const jumpBounds = quickItem
			.querySelector<HTMLElement>(".reader-bookmark-jump")
			?.getBoundingClientRect();
		check(
			jumpBounds &&
				shortcutBounds.left < jumpBounds.left &&
				Math.abs(shortcutBounds.top - jumpBounds.top) < 8,
			"Delete shortcut must sit at the lower left beside the jump action",
		);
		shortcut.focus();
		shortcut.click();
		await until(
			() => !!container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Shortcut deletion must open the shared confirmation",
		);
		check(
			!detail() && quickItem.dataset.selected === "true",
			"Shortcut must not open or navigate the detail",
		);
		const quickDialog = find<HTMLDialogElement>(
			"dialog.reader-bookmark-confirm[open]",
		);
		check(
			document.activeElement === button("取消", quickDialog),
			"Shortcut deletion must default to Cancel",
		);
		button("取消", quickDialog).click();
		await until(
			() => !container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Shortcut cancel must keep its card",
		);
		check(
			records.includes(quick) &&
				document.activeElement === shortcut &&
				!quickItem.hasAttribute("data-selected"),
			"Cancel must retain bookmark and restore shortcut focus",
		);
		shortcut.click();
		await until(
			() => !!container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Shortcut can reopen confirmation",
		);
		await confirmDelete();
		await until(
			() =>
				!records.includes(quick) &&
				!container.querySelector("dialog.reader-bookmark-confirm[open]") &&
				items().length === records.length,
			"Shortcut confirmation must delete only its bookmark",
		);
		try {
			await until(
				() =>
					document.activeElement ===
					container.querySelector('ol[aria-label="位置书签"]'),
				"Deleted shortcut must restore focus to the stable list",
			);
		} catch (failure) {
			throw new Error(
				`${String(failure)}; active=${document.activeElement?.outerHTML.slice(0, 400)}; list=${container.querySelector('ol[aria-label="位置书签"]')?.outerHTML.slice(0, 200)}`,
			);
		}
		const refreshed = makeBookmark(
			"refresh-target",
			anchor(18),
			"刷新前的备注",
		);
		records.push(refreshed);
		await refreshList();
		await until(
			() => items().length === records.length,
			"External bookmark creation must appear after successful list refetch",
		);
		await openDetail(itemContaining("刷新前的备注"));
		await until(
			() => !!detail()?.textContent?.includes("刷新前的备注"),
			"Refresh fixture detail must show its initial snapshot",
		);
		refreshed.note = "远端更新后的完整备注";
		refreshed.excerpt = "远端更新后的完整原文摘要。";
		refreshed.revision++;
		await refreshList();
		await until(
			() =>
				!!detail()?.textContent?.includes(refreshed.note) &&
				!!detail()?.textContent?.includes(refreshed.excerpt),
			"Successful list refetch must revalidate an open detail and show the current note and excerpt",
		);
		const readsBeforePartialPage = singleReads;
		listPageLimit = 1;
		await refreshList();
		await until(
			() => items().length === 1 && singleReads > readsBeforePartialPage,
			"A partial first page must still trigger independent detail validation",
		);
		check(
			!!detail()?.textContent?.includes(refreshed.note) &&
				!items().some((item) => item.textContent?.includes(refreshed.note)),
			"A valid selected bookmark outside loaded pages must remain open",
		);
		listPageLimit = undefined;
		await refreshList();
		await until(
			() => items().length === records.length,
			"Restoring full pagination must reload the complete fixture list",
		);
		button("编辑备注", detail() as HTMLElement).click();
		await until(
			() => !!container.querySelector('textarea[aria-label="书签备注"]'),
			"Refresh protection must exercise an active note editor",
		);
		const draftBeforeRefresh = "后台刷新期间仍保留的本地草稿";
		inputValue(edit(), draftBeforeRefresh);
		const editorRevision = refreshed.revision;
		refreshed.note = "另一窗口在编辑期间更新的备注";
		refreshed.revision++;
		const readsBeforeEditingRefresh = singleReads;
		await refreshList();
		await until(
			() => singleReads > readsBeforeEditingRefresh,
			"List refetch must independently validate the bookmark while its editor is open",
		);
		check(
			edit().value === draftBeforeRefresh,
			"Successful background refresh must preserve the active local draft",
		);
		const patchesBeforeRefreshSave = patches.length;
		button("保存备注").click();
		await until(
			() =>
				patches.length > patchesBeforeRefreshSave &&
				!!detail()?.textContent?.includes("读取最新书签"),
			"Saving after an external edit must require conflict recovery",
		);
		check(
			patches.at(-1)?.expected_revision === editorRevision &&
				edit().value === draftBeforeRefresh,
			"Background refresh must not silently rebase the draft revision or replace its text",
		);
		records.splice(records.indexOf(refreshed), 1);
		await refreshList();
		await until(
			() => !detail() && items().length === records.length,
			"A successful list refetch followed by item 404 must close a deleted bookmark detail",
		);
		check(
			bookmarkDraftSession(materialId, "v1").read(refreshed).note ===
				draftBeforeRefresh,
			"Closing an unavailable bookmark detail must preserve its local note draft",
		);
		const tabs = [
			...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
		];
		check(
			tabs.map((tab) => tab.textContent?.trim()).join("|") === "目录|书签|搜索",
			"Navigation must expose directory, bookmark and search tabs in order",
		);
		check(
			tabs.every(
				(tab) =>
					!!document.getElementById(tab.getAttribute("aria-controls") ?? ""),
			),
			"Navigation tabs must name actual panels",
		);
		const dialog = find<HTMLElement>('[role="dialog"]:not([inert])');
		check(
			!!document.getElementById(dialog.getAttribute("aria-labelledby") ?? ""),
			"Navigation dialog must have an accessible title",
		);
		button("书签", dialog).focus();
		button("书签", dialog).dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
		);
		await until(
			() =>
				button("搜索", dialog).getAttribute("aria-selected") === "true" &&
				document.activeElement === button("搜索", dialog),
			"Right arrow must focus and activate the next navigation tab",
		);
		button("搜索", dialog).dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
		);
		await until(
			() =>
				button("书签", dialog).getAttribute("aria-selected") === "true" &&
				document.activeElement === button("书签", dialog),
			"Left arrow must return focus and activation to bookmarks",
		);
		check(
			dialog.getBoundingClientRect().left >= -1 &&
				dialog.getBoundingClientRect().right <= innerWidth + 1,
			"Bookmark panel must fit the viewport",
		);
		if (detailed) {
			await beginEdit(itemContaining(note));
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"Saved note must be editable",
			);
			inputValue(edit(), "");
			button("保存备注").click();
			await until(
				() =>
					records.find((record) => record.id === "created-1")?.note === "" &&
					!container.querySelector('textarea[aria-label="书签备注"]'),
				"Saving an empty note must clear the stored note",
			);
			const createdExcerpt = records.find(
				(record) => record.id === "created-1",
			)?.excerpt;
			check(
				createdExcerpt,
				"Created bookmark must retain its original excerpt",
			);
			await beginEdit(itemContaining(createdExcerpt));
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"Cleared note must be editable again",
			);
			inputValue(edit(), "保存失败也保留的草稿");
			nextPatch = "failure";
			const before = patches.length;
			button("保存备注").click();
			await until(
				() =>
					patches.length > before &&
					!!container.querySelector('[role="alert"]'),
				"Failed save must report an actionable error",
			);
			check(
				edit().value === "保存失败也保留的草稿",
				"Save failure must preserve the edited note",
			);
			await closeDetail();
			button("目录", dialog).click();
			button("书签", dialog).click();
			await beginEdit(itemContaining(createdExcerpt));
			await until(
				() =>
					container.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="书签备注"]',
					)?.value === "保存失败也保留的草稿",
				"Changing navigation tabs must retain the note draft",
			);
			button("保存备注").click();
			await until(
				() =>
					records.find((record) => record.id === "created-1")?.note ===
						"保存失败也保留的草稿" &&
					!container.querySelector('textarea[aria-label="书签备注"]'),
				"Retry must persist the retained draft",
			);
			await beginEdit(itemContaining("保存失败也保留的草稿"));
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"Conflict editor must open",
			);
			inputValue(edit(), "冲突后的本地草稿");
			nextPatch = "conflict";
			button("保存备注").click();
			await until(
				() => !!container.textContent?.includes("读取最新书签"),
				"Conflict must offer an explicit latest-version read",
			);
			check(
				edit().value === "冲突后的本地草稿",
				"Conflict must preserve the local draft",
			);
			await closeNavigation();
			await openBookmarks();
			await beginEdit(itemContaining("保存失败也保留的草稿"));
			await until(
				() =>
					container.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="书签备注"]',
					)?.value === "冲突后的本地草稿" &&
					!!container.textContent?.includes("读取最新书签"),
				"Closing and reopening must retain both the conflict and local note draft",
			);
			const beforeRead = singleReads;
			button("读取最新书签").click();
			await until(
				() => singleReads > beforeRead,
				"Conflict recovery must read the latest bookmark",
			);
			check(
				edit().value === "冲突后的本地草稿",
				"Latest-version read must preserve the local draft",
			);
			button("保存备注").click();
			await until(
				() =>
					records.find((record) => record.id === "created-1")?.note ===
						"冲突后的本地草稿" &&
					!container.querySelector('textarea[aria-label="书签备注"]'),
				"Explicit save after reread must use the latest revision",
			);
			await beginEdit(itemContaining("冲突后的本地草稿"));
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"Editor must reopen before source availability changes",
			);
			inputValue(edit(), "来源暂不可用时保留的草稿");
			listUnavailable = true;
			const navigation = find<HTMLElement>(
				'.reader-query-navigation[role="dialog"]:not([inert])',
			);
			await closeDetail();
			button("目录", navigation).click();
			await until(
				() =>
					button("目录", navigation).getAttribute("aria-selected") === "true",
				"Directory must deactivate bookmark reads before revalidation",
			);
			button("书签", navigation).click();
			await until(
				() => !!container.textContent?.includes("本书或所属来源已不可用"),
				"Refetch 404 must explain that the material or source is unavailable",
			);
			check(
				items().length === 0 &&
					!container.querySelector('textarea[aria-label="书签备注"]') &&
					!container
						.querySelector(".reader-bookmarks-content > .reader-bookmark-hint")
						?.textContent?.includes("个书签"),
				"Failed revalidation must hide cached bookmarks, their old count and the old editor",
			);
			listUnavailable = false;
			button("重试读取书签").click();
			await until(
				() => items().length === records.length,
				"Successful retry must restore the bookmark list",
			);
			await beginEdit(itemContaining("冲突后的本地草稿"));
			check(
				edit().value === "来源暂不可用时保留的草稿",
				"Successful retry must restore the retained note draft",
			);
			button("取消编辑").click();
		}
		await closeNavigation();
		button("阅读设置").click();
		await until(
			() => !!container.querySelector('[aria-label="文字方向"]'),
			"Reading settings must open",
		);
		const newMode = vertical ? "horizontal-tb" : "vertical-rl";
		const beforeLayout = writes.length;
		button(vertical ? "横排" : "竖排", find('[aria-label="文字方向"]')).click();
		await until(
			() =>
				writes.length > beforeLayout &&
				writes.at(-1)?.settings?.writing_mode === newMode,
			"Changing writing direction must settle before bookmark navigation",
		);
		button("关闭阅读设置").click();
		await until(
			() => !container.querySelector('[role="dialog"]:not([inert])'),
			"Reading settings must close",
		);
		const departure = visibleParagraphs();
		await openBookmarks();
		button(`前往书签：${title}`, itemContaining("冒頭の記憶")).click();
		await until(
			() => visibleParagraphs().includes(8),
			"Stored text bookmark must locate its source after layout changes",
		);
		find<HTMLButtonElement>(".reader-return-origin").click();
		await until(
			() =>
				visibleParagraphs().some((index) => departure.includes(index)) &&
				!visibleParagraphs().includes(8),
			"Return to origin must restore the reading position before the bookmark jump",
		);
		await openBookmarks();
		if (detailed) {
			await beginEdit(itemContaining("冲突后的本地草稿"));
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"Draft editor must open before chapter change",
			);
			inputValue(edit(), "切章仍然保留的草稿");
		}
		button(`前往书签：${imageTitle}`, itemContaining(imageTitle)).click();
		await until(
			() =>
				!!frames()[0]?.contentDocument?.querySelector(
					'[data-epub-image="7"]',
				) && writes.at(-1)?.kind === "image",
			"Image bookmark must open its source illustration",
		);
		const beforeImageCreate = creates.length;
		button("添加当前位置书签").click();
		await until(
			() =>
				Number(creates.length) === beforeImageCreate + 1 &&
				records.some((record) => record.id === "created-2"),
			"Adding at an image must create an image bookmark",
		);
		check(
			creates.at(-1)?.position.kind === "image" &&
				creates.at(-1)?.position.image_id === 7 &&
				(creates.at(-1)?.position.image_progress ?? -1) >= 0,
			"Image bookmark must preserve image identity and intra-image progress",
		);
		await openBookmarks();
		if (detailed) {
			await beginEdit(itemContaining("冲突后的本地草稿"));
			await until(
				() =>
					container.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="书签备注"]',
					)?.value === "切章仍然保留的草稿",
				"Changing chapters must retain the original bookmark note draft",
			);
			button("取消编辑").click();
			const imageItem = items().at(-1);
			check(imageItem, "New image bookmark must appear in the list");
			await beginEdit(imageItem);
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"List action must edit the newly created image bookmark",
			);
			inputValue(edit(), "挿絵へ戻る目印");
			button("保存备注").click();
			await until(
				() =>
					records.find((record) => record.id === "created-2")?.note ===
						"挿絵へ戻る目印" &&
					!container.querySelector('textarea[aria-label="书签备注"]'),
				"List note save must persist the new image note",
			);
			check(
				!container.querySelector(".reader-bookmark-notice"),
				"Saving through the list must remove the old creation notice and its stale revision",
			);
			await closeDetail();
			button("添加当前位置书签").click();
			await until(
				() =>
					records.some((record) => record.id === "created-3") &&
					!!container.querySelector(".reader-bookmark-notice"),
				"Another image bookmark must show its own creation notice",
			);
			await openBookmarks();
			const newest = items().at(-1);
			check(newest, "Newest image bookmark must appear in the list");
			await openDetail(newest);
			button("删除书签", detail() as HTMLElement).click();
			await until(
				() => !!container.querySelector("dialog.reader-bookmark-confirm[open]"),
				"New bookmark delete must request confirmation",
			);
			await confirmDelete();
			await until(
				() =>
					!records.some((record) => record.id === "created-3") &&
					!container.querySelector(".reader-bookmark-notice"),
				"Deleting a just-created bookmark must remove its stale creation notice",
			);
		}
		await closeDetail();
		await openDetail(itemContaining("後で読み返す"));
		const beforeCancelledDelete = deletes.length;
		button("删除书签", detail() as HTMLElement).click();
		await until(
			() => !!container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Delete must open an in-app confirmation",
		);
		const cancelledDialog = find<HTMLDialogElement>(
			"dialog.reader-bookmark-confirm[open]",
		);
		check(
			cancelledDialog.contains(document.activeElement),
			"Delete confirmation must take keyboard focus",
		);
		const danger = button("删除书签", cancelledDialog);
		const checkDeleteContrast = (state: string) => {
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 1;
			const context = canvas.getContext("2d");
			check(context, "Contrast check requires a canvas color resolver");
			const luminance = (color: string) => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				const pixel = context.getImageData(0, 0, 1, 1).data;
				check(pixel[3] === 255, "Delete confirmation colors must be opaque");
				const channel = (value: number) =>
					value / 255 <= 0.04045
						? value / 255 / 12.92
						: ((value / 255 + 0.055) / 1.055) ** 2.4;
				return (
					channel(pixel[0] ?? 0) * 0.2126 +
					channel(pixel[1] ?? 0) * 0.7152 +
					channel(pixel[2] ?? 0) * 0.0722
				);
			};
			const style = getComputedStyle(danger);
			const foreground = luminance(style.color);
			const background = luminance(style.backgroundColor);
			const contrast =
				(Math.max(foreground, background) + 0.05) /
				(Math.min(foreground, background) + 0.05);
			check(
				contrast >= 4.5,
				`Delete button ${state} contrast must remain readable in this paper theme; got ${contrast.toFixed(2)}`,
			);
		};
		checkDeleteContrast("default");

		if (browserPointer) {
			const bounds = danger.getBoundingClientRect();
			await browserPointer([
				{
					type: "mouseMoved",
					x: bounds.left + bounds.width / 2,
					y: bounds.top + bounds.height / 2,
				},
			]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			check(
				danger.matches(":hover"),
				"Native pointer must actually hover over delete confirmation",
			);
			checkDeleteContrast("hover");
		}
		button("取消", cancelledDialog).click();
		await until(
			() => !container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Cancel must close only delete confirmation",
		);
		check(
			deletes.length === beforeCancelledDelete &&
				records.some((record) => record.id === "late") &&
				!!detail(),
			"Cancelling deletion must preserve the bookmark and detail",
		);
		nextDelete = "failure";
		const deletionTarget = records.find((record) => record.id === "late");
		check(deletionTarget, "Deletion conflict fixture must exist");
		const confirmedRevision = deletionTarget.revision;
		const confirmedExcerpt = deletionTarget.excerpt;
		button("删除书签", detail() as HTMLElement).click();
		await until(
			() => !!container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Retryable delete must request confirmation",
		);
		await confirmDelete();
		await until(
			() =>
				!!container.querySelector(
					'dialog.reader-bookmark-confirm[open] [role="alert"]',
				),
			"Failed delete must keep its confirmation and show the error inside it",
		);
		check(
			records.some((record) => record.id === "late"),
			"A failed deletion must preserve persistent state",
		);
		deletionTarget.note = "後で読み返す・別窗口更新";
		deletionTarget.excerpt = "削除確認中に更新された原文。";
		deletionTarget.revision++;
		const readsBeforeConfirmRefresh = singleReads;
		await refreshList();
		await until(
			() => singleReads > readsBeforeConfirmRefresh,
			"Successful list refetch must validate the open deletion confirmation independently",
		);
		const frozenConfirmation = find<HTMLDialogElement>(
			"dialog.reader-bookmark-confirm[open]",
		);
		check(
			frozenConfirmation.textContent?.includes(confirmedExcerpt) &&
				!frozenConfirmation.textContent?.includes(deletionTarget.excerpt),
			"A pending deletion confirmation must retain the preview originally confirmed by the user",
		);
		const deletesBeforeRealConflict = deleteRequests.length;
		await confirmDelete();
		await until(
			() =>
				deleteRequests.length > deletesBeforeRealConflict &&
				!!container
					.querySelector("dialog.reader-bookmark-confirm[open]")
					?.textContent?.includes("书签已更新"),
			"Delete conflict must retain its confirmation and offer a latest-version read inside it",
		);
		check(
			deleteRequests.at(-1)?.expected_revision === confirmedRevision,
			"Automatic detail refresh must not silently raise the deletion revision the user confirmed",
		);
		const beforeDeleteRead = singleReads;
		button(
			"读取最新书签",
			find("dialog.reader-bookmark-confirm[open]"),
		).click();
		await until(
			() =>
				singleReads > beforeDeleteRead &&
				!detail()?.querySelector('[role="alert"]'),
			"Delete recovery must reread the current revision",
		);
		check(
			find("dialog.reader-bookmark-confirm[open]").textContent?.includes(
				deletionTarget.excerpt,
			),
			"Explicit latest-version read must update the confirmation preview before another decision",
		);
		await until(
			() => !!container.querySelector("dialog.reader-bookmark-confirm[open]"),
			"Recovered delete must keep confirmation for a fresh explicit decision",
		);
		await confirmDelete();
		await until(
			() =>
				!records.some((record) => record.id === "late") &&
				!container.textContent?.includes("後で読み返す"),
			"Confirmed delete must remove the bookmark from persistent state and list",
		);
		check(
			deleteRequests.at(-1)?.expected_revision === deletionTarget.revision,
			"Only explicit conflict recovery may confirm deletion against the latest revision",
		);
		check(
			confirmations === 0,
			"Bookmark deletion must never invoke window.confirm",
		);
		if (detailed) {
			await closeNavigation();
			const beforeExpiry = records.length;
			nextCreate = "nearby";
			button("添加当前位置书签").click();
			await until(
				() =>
					!!container
						.querySelector(".reader-bookmark-notice")
						?.textContent?.includes("附近已有书签"),
				"Expiry scenario must show nearby choice",
			);
			await new Promise((resolve) => setTimeout(resolve, 8500));
			check(
				!container.querySelector(".reader-bookmark-notice") &&
					records.length === beforeExpiry,
				"Timing out nearby choice must abandon creation without a bookmark write",
			);
			nextCreate = "nearby";
			button("添加当前位置书签").click();
			await until(
				() =>
					!!container
						.querySelector(".reader-bookmark-notice")
						?.textContent?.includes("附近已有书签"),
				"Expiry must unlock another independent bookmark action",
			);
			button("关闭书签提示").click();
		}
		const readsBeforeRemount = listReads;
		dispose();
		dispose = await h.mount(
			<MaterialReader />,
			"/materials/:id",
			`/materials/${materialId}`,
		);
		await until(
			() => opened >= 2 && visibleParagraphs().includes(30),
			"Reopening the reader must present the original material",
		);
		await openBookmarks();
		check(
			listReads > readsBeforeRemount &&
				items().length === records.length &&
				!container.textContent?.includes("後で読み返す"),
			"Reopening must retrieve saved bookmarks and retain deletion",
		);
		check(
			!container.querySelector(".reader-study-margin"),
			"Position bookmarks must not create margin markers",
		);
		await until(
			() =>
				container
					.getAnimations({ subtree: true })
					.every((animation) => animation.playState !== "running"),
			"Reader and panel motion must settle before visual inspection",
		);
		check(
			originalVisible.includes(30),
			"Fixture must exercise the original reading source",
		);
		await openDetail(itemContaining("冒頭の記憶"));
		return `position bookmarks (${innerWidth}px, ${vertical ? "vertical" : "horizontal"}, ${parameters.get("theme") === "light" ? "light" : "dark"}): nearby no-write/view/dismiss, frozen force/retry, quick note, chapter progress, truncated list/full detail, native Escape/focus, ordered persistence, layout-independent jump/return, image position, built-in delete cancel/failure/conflict/confirm${detailed ? ", expiry, empty note, failed/conflicting saves retain drafts and chapter changes preserve edits" : ""}`;
	} finally {
		window.confirm = nativeConfirm;
		if (!capture) dispose();
	}
}
