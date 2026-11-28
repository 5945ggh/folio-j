import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { readerAnkiProbeResponse } from "./reader-base-fixture";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";
import {
	readerSessionFixture as fixture,
	readerSessionFixtureData,
} from "./reader-session-fixture";

type Schema = components["schemas"];
/** Real Reader, local-only APIs and exact iframe ranges exercise search independently of layout. */
export async function readerSearch(h: BrowserHarness, preview = false) {
	const check: BrowserHarness["check"] = h.check;
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const { ReaderSessionHost } = await import(
		"../src/materials/ReaderSessionHost"
	);
	const { book, chapter, targetStart, targetText, timestamp, reference } =
		fixture;
	const scene = new URLSearchParams(location.search).get("scene");
	let client: QueryClient | undefined;
	let segmentRead: "ready" | "error" | "deleted" | "pending" =
		scene === "segment-read-error"
			? "error"
			: scene === "inline-overlap-pending"
				? "pending"
				: "ready";
	let segmentPending = false;
	let releaseSegment: (() => void) | undefined;
	const segmentGate = new Promise<void>((resolve) => {
		releaseSegment = resolve;
	});
	let translationPending = false;
	let translationReadFails = false;
	let pendingTranslationRefresh: Promise<void> | undefined;
	let releaseTranslation: (() => void) | undefined;
	const translationGate = new Promise<void>((resolve) => {
		releaseTranslation = resolve;
	});
	const otherChapter = { ...chapter, id: "other-chapter", title: "第二章" };
	const { targetIdentity } = await import("../src/translation/state");
	const translationIdentity = await targetIdentity(reference);
	const savedTranslation = {
		id: "translation-saved",
		material_id: book.id,
		source_id: "source",
		chapter_id: chapter.id,
		identity_sha256: fixture.hash,
		material_provenance: reference,
		parts: [],
		text: targetText,
		translation: "已保存的失配译文",
		context_before: "",
		context_after: "",
		created_at: timestamp,
		reader_deleted: false,
		material_deleted: false,
		adopted_segment_ids: [],
		task_id: "task",
		run_id: "run",
		scheme_id: "scheme",
		scheme_name: "合成方案",
		scheme_revision: 0,
		target_language: "中文",
		model_id: "model",
		provider_name: "离线",
		protocol: "openai",
		prompt_version: "1",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: null,
	} satisfies Schema["TranslationResultResponse"];
	const normalTranslation: Schema["TranslationResultResponse"] = {
		...savedTranslation,
		id: "translation-normal",
		identity_sha256: translationIdentity,
		translation: "跨章打开的正常译文",
	};
	const calls: URL[] = [];
	let releaseOld: (() => void) | undefined;
	const oldGate = new Promise<void>((resolve) => {
		releaseOld = resolve;
	});
	let releaseBookmark: (() => void) | undefined;
	const bookmarkGate = new Promise<void>((resolve) => {
		releaseBookmark = resolve;
	});
	let bookmarkRequested = false;
	const positionWrites: Schema["ReadingPositionUpdate"][] = [];
	let position = book.reading_position;
	localStorage.clear();
	localStorage.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({
			focus: false,
			theme:
				new URLSearchParams(location.search).get("mode") === "dark"
					? "black"
					: "white",
		}),
	);
	h.mock(async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		const probe = readerAnkiProbeResponse(request.method, path);
		if (probe) return probe;
		if (
			request.method === "DELETE" &&
			path === `/api/materials/${book.id}/translations/${translationIdentity}`
		)
			return Response.json({ detail: "本地删除失败，请重试" }, { status: 503 });
		if (path === "/api/settings/translation")
			return Response.json({
				id: "scheme",
				adapter: "llm",
				revision: 0,
				name: "合成方案",
				model_id: "model",
				target_language: "中文",
				before_sentences: 2,
				after_sentences: 2,
				before_characters: 100,
				after_characters: 100,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (path === "/api/settings/context-copy")
			return Response.json(defaultContextCopySettings);
		if (
			request.method === "GET" &&
			(path === `/api/materials/${book.id}/search` ||
				path === `/api/materials/${book.id}/record-search`)
		) {
			calls.push(url);
			const q = url.searchParams.get("q") ?? "";
			const kind = url.searchParams.get("kind");
			if (q === "古い") await oldGate;
			if (q === "失敗" && kind === "translation")
				return Response.json({ detail: "译文暂不可用" }, { status: 503 });
			const common = {
				material_id: book.id,
				version_id: book.version_id,
				query: q,
				offset: Number(url.searchParams.get("offset") ?? 0),
				limit: Number(url.searchParams.get("limit") ?? 40),
			};
			if (!kind)
				return Response.json({
					...common,
					total: q ? 1 : 0,
					items: q
						? [
								{
									chapter_id: chapter.id,
									chapter_title: chapter.title,
									part_index: 2,
									resource_id: "r",
									spine_index: 0,
									start: targetStart,
									end: targetStart + targetText.length,
									match: targetText,
									before: "",
									after: "",
								},
							]
						: [],
				} satisfies Schema["MaterialSearchResponse"]);
			check(
				kind === "segment" || kind === "translation" || kind === "bookmark",
				"Search must request a known record kind",
			);
			return Response.json({
				...common,
				kind,
				total: kind === "segment" ? 43 : 1,
				items: Array.from(
					{
						length:
							kind === "segment"
								? Math.min(common.limit, 43 - common.offset)
								: 1,
					},
					(_, index) => ({
						kind,
						id:
							kind === "segment"
								? common.offset + index === 0
									? "saved"
									: `saved-${common.offset + index}`
								: `${kind}-saved`,
						chapter_id: chapter.id,
						chapter_title: chapter.title,
						snippet: `${q || "浏览"} · ${kind}资料`,
						source_excerpt: targetText,
						material_provenance: kind === "bookmark" ? null : reference,
						position:
							q === "失配" && kind !== "segment"
								? null
								: {
										version_id: book.version_id,
										chapter_id: chapter.id,
										resource_id: "r",
										part_index: 2,
										kind: "text",
										offset: targetStart,
										at_chapter_end: false,
									},
						segment_id: kind === "segment" ? "saved" : null,
						result_id:
							kind === "translation"
								? q === "正常"
									? "translation-normal"
									: "translation-saved"
								: null,
						identity_sha256:
							kind === "translation" ? translationIdentity : null,
						bookmark_id: kind === "bookmark" ? "bookmark-saved" : null,
					}),
				),
			} satisfies Schema["MaterialRecordSearchResponse"]);
		}
		if (path === "/api/translation-results/translation-saved")
			return Response.json(savedTranslation);
		if (path === "/api/translation-results/translation-normal")
			return Response.json(normalTranslation);
		if (
			request.method === "GET" &&
			path === `/api/materials/${book.id}/chapters/${chapter.id}/segments`
		) {
			if (segmentRead === "error")
				return Response.json({ detail: "章片段暂不可用" }, { status: 503 });
			if (segmentRead === "pending") {
				segmentPending = true;
				await segmentGate;
				segmentPending = false;
			}
			return Response.json(
				readerSessionFixtureData(request.method, path, {
					studyRecords: segmentRead !== "deleted",
				}),
			);
		}
		if (
			request.method === "GET" &&
			path === `/api/materials/${book.id}/chapters/${chapter.id}/translations`
		) {
			if (scene === "translation-read-error" || translationReadFails)
				return Response.json({ detail: "章译文暂不可用" }, { status: 503 });
			if (scene === "translation-read-pending" || pendingTranslationRefresh) {
				translationPending = true;
				await (pendingTranslationRefresh ?? translationGate);
				translationPending = false;
			}
			return Response.json({
				items: [
					{
						identity_sha256: translationIdentity,
						result_id: normalTranslation.id,
						material_provenance: reference,
						excerpt: targetText,
						translation_excerpt: normalTranslation.translation,
						result_count: 1,
						target_language: normalTranslation.target_language,
						created_at: timestamp,
					},
				],
				next_cursor: null,
				unavailable_count: 0,
			} satisfies Schema["MaterialChapterTranslations"]);
		}
		if (
			request.method === "GET" &&
			path === `/api/materials/${book.id}/translations`
		)
			return Response.json({
				results: [normalTranslation],
				tasks: [],
				next_offset: null,
			});
		if (
			request.method === "GET" &&
			path === `/api/materials/${book.id}/bookmarks/bookmark-saved`
		) {
			bookmarkRequested = true;
			await bookmarkGate;
			return Response.json({
				id: "bookmark-saved",
				material_id: book.id,
				chapter_title: chapter.title,
				excerpt: targetText,
				note: "延迟书签",
				revision: 0,
				created_at: timestamp,
				updated_at: timestamp,
				position: {
					version_id: book.version_id,
					chapter_id: chapter.id,
					resource_id: "r",
					part_index: 2,
					kind: "text",
					offset: targetStart,
					at_chapter_end: false,
				},
			} satisfies Schema["BookmarkResponse"]);
		}
		if (request.method === "GET" && path === `/api/materials/${book.id}`)
			return Response.json({
				...book,
				reading_position: position,
				chapters: [
					...book.chapters,
					{
						id: otherChapter.id,
						title: otherChapter.title,
						level: 0,
						part_count: 3,
					},
				],
			} satisfies Schema["MaterialResponse"]);
		if (
			request.method === "GET" &&
			path === `/api/materials/${book.id}/chapters/${otherChapter.id}`
		)
			return Response.json(otherChapter);
		if (
			path === `/api/materials/${book.id}/reading-position` &&
			request.method === "PUT"
		) {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			positionWrites.push(update);
			position = {
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: timestamp,
			};
			return Response.json(position);
		}
		const data = readerSessionFixtureData(request.method, path, {
			extraChapter: otherChapter,
		});
		if (data !== undefined) return Response.json(data);
		throw new Error(`Unmocked search request ${request.method} ${path}`);
	});
	const panel = () =>
		h.container.querySelector<HTMLElement>(".reader-search-panel");
	const tool = (name: string) => {
		const found = h.container.querySelector<HTMLButtonElement>(
			`button[aria-label="${name}"]`,
		);
		check(found && !found.disabled, `Missing active ${name} tool`);
		return found;
	};
	const click = (label: string, root: ParentNode = panel() ?? h.container) => {
		const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) =>
				item.textContent?.trim() === label ||
				item.getAttribute("aria-label") === label,
		);
		check(found && !found.disabled, `Missing active search button ${label}`);
		found.click();
	};
	const input = () => {
		const found = panel()?.querySelector<HTMLInputElement>(
			'input[aria-label="搜索本书"]',
		);
		check(found, "Search must expose labelled input");
		return found;
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
	function SearchReader() {
		client = useQueryClient();
		return scene === "preview-refresh" ? (
			<>
				<ReaderSessionHost />
				<Outlet />
			</>
		) : (
			<MaterialReader />
		);
	}
	const readerPath = `/materials/${book.id}`;
	const dispose =
		scene === "preview-refresh"
			? await h.mount(<SearchReader />, "/", readerPath, [
					{ path: "materials/:id", element: null },
					{
						path: "settings",
						element: <Link to={readerPath}>回到测试书籍</Link>,
					},
				])
			: await h.mount(<SearchReader />, "/materials/:id", readerPath);
	try {
		await h.until(
			() => !!h.container.querySelector("iframe.material-part"),
			"Reader must render exact source frames",
		);
		tool("目录与书签").click();
		await settle();
		check(
			!h.container.querySelector('[role="tab"][data-value="search"]'),
			"Directory must not retain a search tab",
		);
		tool("本书搜索").click();
		await h.until(
			() => !!panel(),
			"Independent search tool must open search panel",
		);
		await h.until(
			() =>
				calls.filter((url) => url.pathname.endsWith("/record-search"))
					.length === 3,
			"Empty query must browse three record categories",
		);
		check(
			!calls.some((url) => url.pathname.endsWith("/search")),
			"Empty query must not scan original text",
		);
		await h.until(
			() =>
				panel()?.querySelectorAll(
					'.reader-search-group[aria-label="片段"] .reader-search-hit',
				).length === 2,
			"All view must preview exactly two segment records",
		);
		if (preview) return `reader search preview ${innerWidth}px`;
		if (scene) {
			const queryClient = client;
			check(queryClient, "Reader must mount with a query client");
			const translation =
				scene === "segment-read-error" || scene === "inline-overlap-pending";
			if (translation) h.inputValue(input(), "正常");
			const label = translation ? "译文" : "片段";
			const firstHit = () =>
				panel()?.querySelector<HTMLButtonElement>(
					`.reader-search-group[aria-label="${label}"] .reader-search-hit`,
				);
			await h.until(
				() =>
					!!firstHit() &&
					(!translation || firstHit()?.textContent?.includes("正常") === true),
				"Search must return the target record",
			);
			firstHit()?.click();
			const card = () =>
				h.container.querySelector<HTMLElement>(".reader-chapter-records");
			await h.until(
				() =>
					card()?.inert === false &&
					card()?.textContent?.includes(
						translation ? normalTranslation.translation : targetText,
					) === true,
				"Search must open an actionable preview while the other record type is unavailable",
			);
			if (scene === "inline-overlap-pending") {
				check(segmentPending, "Chapter segments must still be loading");
				click("关闭阅读记录", card() ?? undefined);
				await h.until(() => !card(), "Search translation preview must close");
				const frames = [
					...h.container.querySelectorAll<HTMLIFrameElement>(
						"iframe.material-part",
					),
				];
				const doc = frames[2]?.contentDocument;
				const leaf = doc?.querySelector(
					`[data-locator-leaf="${fixture.targetParagraph}"]`,
				);
				check(doc && leaf?.firstChild, "Search must present the target leaf");
				const range = doc.createRange();
				range.setStart(leaf.firstChild, 2);
				range.setEnd(leaf.firstChild, 3);
				const rect = range.getBoundingClientRect();
				for (const type of ["pointerdown", "pointerup"])
					leaf.dispatchEvent(
						new PointerEvent(type, {
							bubbles: true,
							cancelable: true,
							pointerId: 7,
							isPrimary: true,
							pointerType: "mouse",
							button: 0,
							clientX: rect.left + rect.width / 2,
							clientY: rect.top + rect.height / 2,
						}),
					);
				await settle();
				check(
					!doc.querySelector("[data-reader-inline-translation]"),
					"A partly loaded record group must not insert an inline translation",
				);
				segmentRead = "ready";
				releaseSegment?.();
				await h.until(
					() =>
						card()?.inert === false &&
						!!card()?.querySelector('[role="tab"][aria-label="学习片段"]') &&
						!!card()?.querySelector('[role="tab"][aria-label="译文"]'),
					"The original text tap must open the combined record preview once overlap is verified",
				);
				return "reader search translation preserves the combined body preview while segments load";
			}
			const open = card()?.querySelector<HTMLButtonElement>(
				'button[aria-expanded="false"]',
			);
			check(open, "Preview must offer its normal expand action");
			open.click();
			await h.until(
				() => card()?.classList.contains("expanded") === true,
				"Preview must support expansion",
			);
			const refreshSegments = () =>
				queryClient.invalidateQueries({
					queryKey: [
						"material-chapter-segments",
						book.id,
						book.version_id,
						chapter.id,
					],
				});
			if (scene === "preview-refresh") {
				await h.until(
					() => !!card()?.querySelector('[role="tab"][aria-label="译文"]'),
					"Two verified overlapping types must remain available",
				);
				const translationTab = () =>
					card()?.querySelector<HTMLButtonElement>(
						'[role="tab"][aria-label="译文"]',
					);
				translationTab()?.click();
				const translationKey = [
					"material-chapter-translations",
					book.id,
					book.version_id,
					chapter.id,
				];
				await h.until(
					() => !!card()?.querySelector(".reader-record-translation"),
					"Selecting the related translation tab must list its records",
				);
				card()
					?.querySelector<HTMLButtonElement>(".reader-record-translation")
					?.click();
				const translationPanel = () =>
					card()?.querySelector<HTMLElement>(".translation-card");
				await h.until(
					() =>
						translationPanel()?.textContent?.includes(
							normalTranslation.translation,
						) === true,
					"Selecting the related translation must open its details",
				);
				const openedTranslation = translationPanel();
				segmentRead = "pending";
				pendingTranslationRefresh = translationGate;
				const refresh = Promise.all([
					refreshSegments(),
					queryClient.invalidateQueries({ queryKey: translationKey }),
				]);
				await h.until(
					() => segmentPending && translationPending,
					"Both background refreshes must be held",
				);
				await settle();
				check(
					card()?.inert === false,
					"A background refresh must leave the preview actionable",
				);
				check(
					translationTab()?.getAttribute("aria-selected") === "true" &&
						translationPanel() === openedTranslation &&
						openedTranslation?.parentElement?.hidden === false,
					"Keep the selected related translation and its mounted details during refresh",
				);
				segmentRead = "ready";
				pendingTranslationRefresh = undefined;
				releaseSegment?.();
				releaseTranslation?.();
				await refresh;
				h.container
					.querySelector<HTMLAnchorElement>('a[aria-label="全局设置"]')
					?.click();
				const back = () =>
					[...h.container.querySelectorAll<HTMLAnchorElement>("a")].find(
						(link) => link.textContent === "回到测试书籍",
					);
				await h.until(
					() => !!back(),
					"Reader must suspend while settings are open",
				);
				pendingTranslationRefresh = new Promise<void>((resolve) => {
					releaseTranslation = resolve;
				});
				back()?.click();
				await h.until(
					() => translationPending && card()?.inert === false,
					"Selected translation must revalidate after settings while the verified segment stays usable",
				);
				check(
					translationPanel() === openedTranslation &&
						openedTranslation?.parentElement?.hidden &&
						translationTab()?.getAttribute("aria-selected") === "true",
					"Unverified translation must stay mounted and hidden without changing the selected tab",
				);
				pendingTranslationRefresh = undefined;
				releaseTranslation?.();
				await h.until(
					() =>
						translationPanel() === openedTranslation &&
						!openedTranslation?.parentElement?.hidden &&
						openedTranslation?.textContent?.includes(
							normalTranslation.translation,
						) === true,
					"Verified translation must become visible again without remounting",
				);
				click("返回译文列表", card() ?? undefined);
				const remove = () =>
					card()?.querySelector<HTMLButtonElement>(
						".reader-record-translation-entry .translation-remove",
					);
				await h.until(() => !!remove(), "Return to related translation list");
				remove()?.click();
				const dialog = () =>
					card()?.querySelector<HTMLDialogElement>("dialog:modal");
				await h.until(
					() => !!dialog(),
					"Related translation must open deletion confirmation",
				);
				const openedDialog = dialog();
				check(openedDialog, "A modal must be open");
				click("确认删除", openedDialog);
				await h.until(
					() =>
						openedDialog.textContent?.includes("本地删除失败，请重试") === true,
					"Failed deletion must keep its error in the confirmation",
				);
				translationReadFails = true;
				await queryClient.invalidateQueries({ queryKey: translationKey });
				await h.until(
					() => remove()?.hidden === true,
					"Failed chapter refresh must hide unverified row actions",
				);
				check(
					dialog() === openedDialog &&
						openedDialog.getBoundingClientRect().width > 0 &&
						openedDialog.textContent?.includes("本地删除失败，请重试"),
					"Failed refresh must preserve the visible confirmation and its retry feedback",
				);
				check(
					card()?.querySelector(".reader-record-translation")?.getClientRects()
						.length === 0 && remove()?.getClientRects().length === 0,
					"Unverified row and removal controls must have no visible boxes",
				);
				const cancel = openedDialog.querySelector<HTMLButtonElement>(
					"[data-dialog-cancel]",
				);
				check(
					cancel && !cancel.disabled,
					"Modal cancellation must be available",
				);
				const cancelBounds = cancel.getBoundingClientRect();
				const x = cancelBounds.left + cancelBounds.width / 2;
				const y = cancelBounds.top + cancelBounds.height / 2;
				check(
					document.elementFromPoint(x, y) === cancel,
					"Cancel must be the visible hit target",
				);
				const pointer = (
					window as Window & {
						browserPointer?: (events: unknown[]) => Promise<void>;
					}
				).browserPointer;
				check(pointer, "Browser pointer must be available");
				await pointer([
					{ type: "mouseMoved", x, y },
					{ type: "mousePressed", x, y, button: "left", clickCount: 1 },
					{ type: "mouseReleased", x, y, button: "left", clickCount: 1 },
				]);
				await h.until(
					() => !dialog(),
					"Native click must cancel the retained modal",
				);
				click("学习片段", card() ?? undefined);
				await h.until(
					() =>
						card()
							?.querySelector('[role="tab"][aria-label="学习片段"]')
							?.getAttribute("aria-selected") === "true",
					"Reader must be usable after modal cancellation",
				);
			}
			if (scene === "translation-read-pending") {
				check(
					translationPending,
					"Preview must be usable before the unrelated read settles",
				);
				segmentRead = "error";
				await refreshSegments();
				await h.until(
					() => card()?.textContent?.includes("重试") === true,
					"The target's own failed refresh must hide the content and offer retry",
				);
				check(
					card()?.querySelector(".reader-study-preview")?.parentElement?.hidden,
					"Own read failure must not show a stale Segment preview",
				);
				releaseTranslation?.();
				await h.until(() => !translationPending, "Unrelated read must settle");
				segmentRead = "deleted";
				click("重试", card() ?? undefined);
				await h.until(
					() => !card(),
					"A deleted target must close even when an overlapping translation remains",
				);
			}
			return `reader search preview isolates ${scene} at ${innerWidth}px`;
		}
		// Remaining assertions follow the real panel's accessible controls below.
		const field = input();
		field.dispatchEvent(
			new CompositionEvent("compositionstart", { bubbles: true }),
		);
		h.inputValue(field, "は");
		await settle();
		check(
			!calls.some((url) => url.searchParams.get("q") === "は"),
			"IME intermediate text must not query",
		);
		h.inputValue(field, "春");
		field.dispatchEvent(
			new CompositionEvent("compositionend", { bubbles: true, data: "春" }),
		);
		await h.until(
			() => calls.some((url) => url.searchParams.get("q") === "春"),
			"IME final value must query",
		);
		h.inputValue(input(), "古い");
		await h.until(
			() => calls.some((url) => url.searchParams.get("q") === "古い"),
			"Old query must start",
		);
		h.inputValue(input(), "新しい");
		await h.until(
			() => panel()?.textContent?.includes("新しい · segment资料") ?? false,
			"New query must render before old response",
		);
		releaseOld?.();
		await settle();
		check(
			!panel()?.textContent?.includes("古い ·"),
			"Late old response must not overwrite current search",
		);
		check(client, "Search must expose its query client");
		const segmentKey = ["segment", "search-scope-check"];
		const beforeRefresh = calls.length;
		client.setQueryData(segmentKey, {
			source_id: book.source_id,
			material_provenance: { ...reference, material_id: "other-book" },
		});
		await client.invalidateQueries({ queryKey: segmentKey });
		await settle();
		check(
			calls.length === beforeRefresh,
			"Another book's segment must not refresh this book's searches",
		);
		for (const data of [
			{ source_id: book.source_id, material_provenance: reference },
			null,
		]) {
			const start = calls.length;
			client.setQueryData(segmentKey, data);
			await client.invalidateQueries({ queryKey: segmentKey });
			await h.until(
				() => calls.length > start,
				"A changed segment from this book or with unknown ownership must refresh segment results",
			);
		}
		check(
			calls
				.slice(beforeRefresh)
				.every((url) => url.searchParams.get("kind") === "segment"),
			"Segment changes must preserve original, translation, and bookmark results",
		);
		tool("本书搜索").click();
		await h.until(() => !panel(), "Search must close");
		tool("本书搜索").click();
		await h.until(() => !!panel(), "Search must reopen");
		check(input().value === "新しい", "Closing search must preserve query");
		const filters = panel()?.querySelector<HTMLButtonElement>(
			".reader-search-filter-toggle",
		);
		check(filters, "Unified filters must be available");
		filters.click();
		await h.until(
			() =>
				!panel()?.querySelector<HTMLElement>(".reader-search-filters")?.hidden,
			"Filters must expand",
		);
		const trigger = panel()?.querySelector<HTMLButtonElement>(
			".reader-search-chapter-trigger",
		);
		check(trigger, "Chapter picker must be available");
		trigger.click();
		await h.until(
			() =>
				!!document.querySelector(".reader-search-chapter-popover:popover-open"),
			"Chapter popover must open",
		);
		const checkbox = (label: string) => {
			const item = document.querySelector<HTMLInputElement>(
				`.reader-search-chapter-popover input[aria-label="${label}"]`,
			);
			check(item, `Missing chapter checkbox ${label}`);
			return item;
		};
		checkbox("全部章节").click();
		await h.until(
			() => panel()?.textContent?.includes("未选择任何章节") ?? false,
			"No chapters must show explicit empty state",
		);
		const beforeEmpty = calls.length;
		await settle();
		check(
			calls.length === beforeEmpty,
			"No chapters must never send whole-book requests",
		);
		checkbox(chapter.title).click();
		await h.until(
			() =>
				calls.some(
					(url) => url.searchParams.getAll("chapter_ids").join() === chapter.id,
				),
			"Selected chapter must reach API",
		);
		check(
			checkbox("全部章节").indeterminate,
			"Partial selection must show mixed checkbox",
		);
		checkbox(otherChapter.title).click();
		await h.until(
			() => checkbox("全部章节").checked,
			"Chapter selections must combine to all",
		);
		checkbox(chapter.title).click();
		await h.until(
			() => checkbox("全部章节").indeterminate,
			"Removing chapter must restore mixed state",
		);
		checkbox("全部章节").click();
		await h.until(
			() => checkbox("全部章节").checked,
			"Mixed total checkbox must select all",
		);
		checkbox("全部章节").dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await h.until(
			() =>
				!document.querySelector(".reader-search-chapter-popover:popover-open"),
			"Escape must close chapter popup",
		);
		check(!!panel(), "Popup Escape must preserve search");
		await h.until(
			() =>
				!!panel()?.querySelector(
					'.reader-search-group[aria-label="片段"] .reader-search-hit',
				),
			"Results must settle after chapter changes",
		);
		const fold = panel()?.querySelector<HTMLButtonElement>(
			'.reader-search-group[aria-label="片段"] .reader-search-group-toggle',
		);
		check(fold, "Categories must expose independent fold control");
		const beforeFold = calls.length;
		fold.click();
		await h.until(
			() => fold.getAttribute("aria-expanded") === "false",
			"Group must collapse",
		);
		check(input().value === "新しい", "Folding must preserve query");
		fold.click();
		await settle();
		check(
			calls.length === beforeFold,
			"Folding must not change conditions or fetch",
		);
		click("原文");
		await h.until(
			() => !!panel()?.textContent?.includes(targetText),
			"Original-only results must render",
		);
		const hit = panel()?.querySelector<HTMLButtonElement>(".reader-search-hit");
		check(hit, "Original result must be actionable");
		hit.click();
		const highlights = () =>
			[
				...h.container.querySelectorAll<HTMLIFrameElement>(
					"iframe.material-part",
				),
			]
				.flatMap((frame) => {
					const ranges =
						frame.contentDocument?.defaultView?.CSS.highlights.get(
							"folio-search",
						);
					return ranges ? [...ranges].map((range) => range.toString()) : [];
				})
				.join("");
		await h.until(
			() => highlights() === targetText,
			"Result must highlight exact real iframe source",
		);
		if (innerWidth <= 720) {
			await h.until(() => !panel(), "Narrow navigation must close search");
			tool("本书搜索").click();
			await h.until(
				() => !!panel(),
				"Search must reopen after narrow navigation",
			);
		} else check(!!panel(), "Desktop navigation must retain list");
		check(input().value === "新しい", "Navigation must retain keyword");
		click("全部");
		h.inputValue(input(), "失敗");
		await h.until(
			() => panel()?.textContent?.includes("译文加载失败") ?? false,
			"One category must expose its own failure",
		);
		check(
			panel()?.textContent?.includes("失敗 · segment资料"),
			"Translation failure must not conceal segments",
		);
		check(
			panel()?.textContent?.includes("失敗 · bookmark资料"),
			"Translation failure must not conceal bookmarks",
		);
		click("片段");
		await h.until(
			() => panel()?.querySelectorAll(".reader-search-hit").length === 40,
			"Single category must show first 40 records",
		);
		click("加载更多");
		await h.until(
			() => panel()?.querySelectorAll(".reader-search-hit").length === 43,
			"Category pagination must append remaining records",
		);
		check(
			calls.some(
				(url) =>
					url.searchParams.get("kind") === "segment" &&
					url.searchParams.get("offset") === "40",
			),
			"Next page must request offset 40",
		);
		const resultList = panel()?.querySelector<HTMLElement>(
			".reader-search-results",
		);
		check(resultList, "Long category must have independent scroll container");
		resultList.scrollTop = 1200;
		resultList.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle();
		const preservedTop = resultList.scrollTop;
		check(
			preservedTop > 500,
			"Long category must actually scroll before closing",
		);
		tool("本书搜索").click();
		await h.until(() => !panel(), "Long list must close");
		tool("本书搜索").click();
		await h.until(
			() => panel()?.querySelectorAll(".reader-search-hit").length === 43,
			"Reopened long list must retain both pages",
		);
		let scrollFailure: unknown;
		await h
			.until(
				() =>
					Math.abs(
						(panel()?.querySelector<HTMLElement>(".reader-search-results")
							?.scrollTop ?? 0) - preservedTop,
					) < 2,
				`Long list must restore scroll after data becomes ready (expected ${preservedTop})`,
			)
			.catch((error: unknown) => {
				scrollFailure = error;
			});
		const segmentHit =
			panel()?.querySelector<HTMLButtonElement>(".reader-search-hit");
		check(segmentHit, "Segment search result must remain actionable");
		segmentHit.click();
		await h.until(
			() => !!h.container.querySelector(".reader-study-preview"),
			"Segment result must open existing Reader study preview",
		);
		check(
			!h.container.querySelector(".workbench"),
			"Search preview must not mount workbench",
		);
		await settle();
		await settle();
		if (!panel() || panel()?.hasAttribute("inert")) {
			tool("本书搜索").click();
			await h.until(
				() => !!panel() && !panel()?.hasAttribute("inert"),
				"Search must be active for next result",
			);
		}
		click("书签");
		await h.until(
			() => panel()?.querySelectorAll(".reader-search-hit").length === 1,
			"Bookmark-only result must render",
		);
		const bookmarkHit =
			panel()?.querySelector<HTMLButtonElement>(".reader-search-hit");
		check(bookmarkHit, "Bookmark result must be actionable");
		bookmarkHit.click();
		await h.until(
			() => bookmarkRequested,
			"Bookmark result detail GET must begin",
		);
		tool("下一章").click();
		await h.until(
			() => position?.chapter_id === otherChapter.id,
			"User navigation must present and save next chapter while bookmark GET is pending",
		);
		const writesBeforeRelease = positionWrites.length;
		releaseBookmark?.();
		await settle();
		await settle();
		check(
			position?.chapter_id === otherChapter.id,
			"Late bookmark GET must not jump back to old chapter",
		);
		check(
			!positionWrites
				.slice(writesBeforeRelease)
				.some((write) => write.chapter_id === chapter.id),
			"Late bookmark GET must not persist superseded target",
		);
		check(
			!h.container.querySelector(".reader-bookmark-detail"),
			"Late bookmark GET must not open superseded bookmark detail",
		);
		if (!panel() || panel()?.hasAttribute("inert")) {
			tool("本书搜索").click();
			await h.until(
				() => !!panel() && !panel()?.hasAttribute("inert"),
				"Search must be active for historical results",
			);
		}
		click("译文");
		h.inputValue(input(), "正常");
		await h.until(
			() => panel()?.textContent?.includes("正常 · translation资料") ?? false,
			"Normal translation search must render across chapters",
		);
		check(
			position?.chapter_id === otherChapter.id,
			"Cross-chapter translation test must start in other chapter",
		);
		panel()?.querySelector<HTMLButtonElement>(".reader-search-hit")?.click();
		await h.until(
			() =>
				position?.chapter_id === chapter.id &&
				(h.container
					.querySelector(".reader-record-popover")
					?.textContent?.includes(normalTranslation.translation) ??
					h.container.textContent?.includes(normalTranslation.translation) ??
					false),
			"First cross-chapter translation click must navigate and open saved content",
		);
		await settle();
		await settle();
		window.dispatchEvent(new Event("resize"));
		await new Promise((resolve) => setTimeout(resolve, 700));
		check(
			h.container.textContent?.includes(normalTranslation.translation),
			"Cross-chapter translation preview must survive post-navigation geometry refresh",
		);
		check(
			!h.container.querySelector(".reader-search-saved-translation"),
			"Resolvable translation must use existing records preview",
		);
		tool("下一章").click();
		await h.until(
			() => position?.chapter_id === otherChapter.id,
			"Return to next chapter for historical detail tests",
		);
		await settle();
		if (!panel() || panel()?.hasAttribute("inert")) {
			tool("本书搜索").click();
			await h.until(
				() => !!panel() && !panel()?.hasAttribute("inert"),
				"Search must return from normal translation",
			);
		}
		click("译文");
		h.inputValue(input(), "失配");
		await h.until(
			() => panel()?.textContent?.includes("失配 · translation资料") ?? false,
			"Historical translation must remain searchable",
		);
		panel()?.querySelector<HTMLButtonElement>(".reader-search-hit")?.click();
		await h.until(
			() =>
				h.container
					.querySelector(".reader-search-saved-translation")
					?.textContent?.includes("已保存的失配译文") ?? false,
			"Unlocatable translation must open saved read-only content",
		);
		check(
			h.container
				.querySelector(".reader-search-saved-translation")
				?.textContent?.includes("无法定位到原书位置"),
			"Historical translation must explain unavailable location",
		);
		check(
			position?.chapter_id === otherChapter.id,
			"Unlocatable translation must not move current reading position",
		);
		tool("关闭已保存译文").click();
		await settle();
		if (!panel() || panel()?.hasAttribute("inert")) {
			tool("本书搜索").click();
			await h.until(
				() => !!panel() && !panel()?.hasAttribute("inert"),
				"Search must return from saved translation",
			);
		}
		click("书签");
		await h.until(
			() => panel()?.textContent?.includes("失配 · bookmark资料") ?? false,
			"Unlocatable bookmark must remain searchable",
		);
		panel()?.querySelector<HTMLButtonElement>(".reader-search-hit")?.click();
		await h.until(
			() => !!h.container.querySelector(".reader-bookmark-detail-excerpt"),
			"Unlocatable bookmark must retain readable detail",
		);
		const go = h.container.querySelector<HTMLButtonElement>(
			".reader-bookmark-detail .reader-bookmark-go",
		);
		check(go?.disabled, "Unlocatable bookmark must disable source navigation");
		check(
			position?.chapter_id === otherChapter.id,
			"Unlocatable bookmark detail must not move reading position",
		);
		if (scrollFailure) throw scrollFailure;
		return `reader search: ${innerWidth}px; independent entry, empty-query records, IME/stale isolation, reopen retention, chapter multi-select/mixed/empty guard, folding/failure isolation, two-record previews/40-record pagination, exact iframe navigation/study preview, long-list scroll restoration and superseded bookmark GET isolation, unlocatable translation/bookmark read-only details and persistent first-click cross-chapter translation preview`;
	} finally {
		releaseSegment?.();
		releaseTranslation?.();
		releaseOld?.();
		releaseBookmark?.();
		if (!preview) dispose();
	}
}
