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
	const check: BrowserHarness["check"] = h.check;
	const { container, until, inputValue } = h;
	const parameters = new URLSearchParams(location.search);
	const vertical = parameters.get("direction") === "vertical-rl";
	const detailed = !vertical && innerWidth > 720;
	const nativeConfirm = window.confirm;
	let confirmationAccepted = false;
	let confirmations = 0;
	window.confirm = () => {
		confirmations++;
		return confirmationAccepted;
	};
	const capture = parameters.has("capture") || parameters.has("preview");
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
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
		makeBookmark("early", anchor(8), "冒頭の記憶"),
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
	let listReads = 0;
	let listUnavailable = false;
	let singleReads = 0;
	let opened = 0;
	let nextPatch: "ok" | "failure" | "conflict" = "ok";
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
					limit,
					items: ordered.slice(offset, offset + limit),
				});
			}
			if (request.method === "POST") {
				const body: Schema["BookmarkCreate"] = await request.json();
				creates.push(body);
				if (holdCreate)
					await new Promise<void>((resolve) => {
						releaseCreate = resolve;
					});
				if (detailed && creates.length === 1)
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
				check(
					update.expected_revision === bookmark.revision,
					"Saving a note must use its current revision",
				);
				bookmark.note = update.note;
				bookmark.revision++;
				return Response.json(bookmark);
			}
			if (request.method === "DELETE") {
				check(
					Number(url.searchParams.get("expected_revision")) ===
						bookmark.revision,
					"Delete must use the current bookmark revision",
				);
				records.splice(records.indexOf(bookmark), 1);
				return new Response(null, { status: 204 });
			}
		}
		throw new Error(
			`Unmocked position-bookmark request ${request.method} ${path}`,
		);
	});
	let dispose = await h.mount(
		<MaterialReader />,
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
			() => creates.length === 1,
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
			JSON.stringify(firstCreate.position) === frozen && creates.length === 1,
			"Pending creation must retain the clicked anchor during subsequent scrolling",
		);
		check(releaseCreate, "Pending create release must exist");
		holdCreate = false;
		releaseCreate();
		if (detailed) {
			await until(
				() => !!container.querySelector(".reader-bookmark-notice [role=alert]"),
				"Failed creation must offer retry for the original location",
			);
			button("添加当前位置书签").click();
			check(
				creates.length === 1,
				"A failed frozen request must require an explicit retry instead of adding the later reading position",
			);
			button("重试保存书签").click();
			await until(
				() => creates.length === 2,
				"Creation retry must submit the frozen request",
			);
			check(
				creates[1]?.request_id === firstCreate.request_id &&
					JSON.stringify(creates[1]?.position) === frozen,
				"Creation retry must preserve both anchor and idempotency identity after scrolling",
			);
		}
		await until(
			() =>
				!!container
					.querySelector('[role="status"]')
					?.textContent?.includes("已添加书签"),
			"Successful addition must show a light confirmation",
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
			button("编辑备注", itemContaining(note)).click();
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
			button("添加备注", itemContaining(createdExcerpt)).click();
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
			button("目录", dialog).click();
			button("书签", dialog).click();
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
			button("编辑备注", itemContaining("保存失败也保留的草稿")).click();
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
			button("编辑备注", itemContaining("冲突后的本地草稿")).click();
			await until(
				() => !!container.querySelector('textarea[aria-label="书签备注"]'),
				"Editor must reopen before source availability changes",
			);
			inputValue(edit(), "来源暂不可用时保留的草稿");
			listUnavailable = true;
			const navigation = find<HTMLElement>('[role="dialog"]:not([inert])');
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
				() =>
					items().length === records.length &&
					container.querySelector<HTMLTextAreaElement>(
						'textarea[aria-label="书签备注"]',
					)?.value === "来源暂不可用时保留的草稿",
				"Successful retry must restore the list and its retained note draft",
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
			button("编辑备注", itemContaining("冲突后的本地草稿")).click();
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
				creates.length === beforeImageCreate + 1 &&
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
			button("添加备注", imageItem).click();
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
			confirmationAccepted = true;
			button("删除书签", newest).click();
			await until(
				() =>
					!records.some((record) => record.id === "created-3") &&
					!container.querySelector(".reader-bookmark-notice"),
				"Deleting a just-created bookmark through the list must remove its old notice",
			);
			confirmationAccepted = false;
		}
		const beforeCancelledDelete = confirmations;
		button("删除书签", itemContaining("後で読み返す")).click();
		check(
			confirmations === beforeCancelledDelete + 1 &&
				records.some((record) => record.id === "late"),
			"Cancelling deletion must retain the bookmark",
		);
		confirmationAccepted = true;
		button("删除书签", itemContaining("後で読み返す")).click();
		await until(
			() =>
				!records.some((record) => record.id === "late") &&
				!container.textContent?.includes("後で読み返す"),
			"Delete must remove the selected bookmark from persistent state and list",
		);
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
		return `position bookmarks (${innerWidth}px, ${vertical ? "vertical" : "horizontal"}): frozen add, quick note, ordered persistent list, direction-independent jump/return, image position, deletion${detailed ? ", empty note, failed/conflicting saves retain drafts and chapter changes preserve edits" : ""}`;
	} finally {
		window.confirm = nativeConfirm;
		if (!capture) dispose();
	}
}
