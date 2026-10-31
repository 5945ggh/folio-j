import { Outlet } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const hash = "a".repeat(64);
const stamp = "2026-10-31T00:00:00Z";

/** Exercise the actual Reader, iframe glyph projection and nested dictionary cards without a network. */
export async function readerDictionary(h: BrowserHarness) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const { SettingsPage } = await import("../src/settings/SettingsPage");
	const check: BrowserHarness["check"] = h.check;
	const paragraphs = [
		"猫が歩く。",
		...Array.from({ length: 36 }, (_, i) =>
			i === 17 ? "猫が歩く。" : "静かな道を歩く。",
		),
	];
	const text = paragraphs.join("");
	const chapter: Schema["MaterialChapterResponse"] = {
		id: "chapter",
		material_id: "dictionary",
		version_id: "v1",
		title: "第一章",
		level: 0,
		resources: [
			{
				id: "r",
				text,
				text_sha256: hash,
				href: "chapter.xhtml",
				css: "p{margin:0 0 1.5em}",
				html_attributes: {},
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 0,
				end: Array.from(text).length,
				leaf_start: 0,
				leaf_end: paragraphs.length,
				html: paragraphs
					.map(
						(value, i) =>
							`<p><span data-locator-leaf="${i}">${value}</span></p>`,
					)
					.join(""),
			},
		],
	};
	const book: Schema["MaterialResponse"] = {
		id: "dictionary",
		source_id: "source",
		title: "查词试读",
		version_id: "v1",
		contract_version: "1",
		product_sha256: hash,
		source_sha256: hash,
		created_at: stamp,
		warnings: [],
		chapters: [{ id: "chapter", title: "第一章", level: 0, part_count: 1 }],
		reading_position: {
			chapter_id: "chapter",
			resource_id: "r",
			version_id: "v1",
			part_index: 0,
			kind: "text",
			offset: 0,
			at_chapter_end: false,
			progress: 0,
			revision: 0,
			updated_at: stamp,
			settings: {
				font_size: 22,
				line_height: 2,
				writing_mode: "horizontal-tb",
			},
		},
	};
	const saved: Schema["MaterialChapterSegment"][] = [
		{
			segment_id: "saved-cat",
			excerpt: "猫",
			created_at: stamp,
			material_provenance: {
				contract_version: "1",
				material_id: book.id,
				version_id: "v1",
				ranges: [
					{
						resource_id: "r",
						spine_index: 0,
						start: 0,
						end: 1,
						exact: "猫",
						text_sha256: hash,
						prefix: "",
						suffix: "",
					},
				],
			},
		},
		{
			segment_id: "other-record",
			excerpt: "静",
			created_at: stamp,
			material_provenance: {
				contract_version: "1",
				material_id: book.id,
				version_id: "v1",
				ranges: [
					{
						resource_id: "r",
						spine_index: 0,
						start: 5,
						end: 6,
						exact: "静",
						text_sha256: hash,
						prefix: "",
						suffix: "",
					},
				],
			},
		},
	];
	const segmentReads: string[] = [];
	const requests: Schema["DictionaryLookupRequest"][] = [];
	let statusReads = 0;
	let activeDictionaryId = "synthetic";
	let activeDictionaryTitle = "合成测试词典";
	let hold = false;
	const deferred: { release?: () => void } = {};
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/dictionary" && request.method === "GET") {
			statusReads++;
			return Response.json({
				ready: true,
				dictionary_id: activeDictionaryId,
				title: activeDictionaryTitle,
				revision: "1",
				entry_count: 3,
			});
		}
		if (path === "/api/dictionary/library" && request.method === "GET")
			return Response.json({
				dictionaries: [
					{
						dictionary_id: activeDictionaryId,
						title: activeDictionaryTitle,
						revision: "1",
						entry_count: 3,
					},
				],
				active_dictionary_id: activeDictionaryId,
			});
		if (path === "/api/dictionary/lookup" && request.method === "POST") {
			const input: Schema["DictionaryLookupRequest"] = await request.json();
			check(
				"expected_dictionary_id" in input &&
					input.expected_dictionary_id === activeDictionaryId,
				"Every lookup must freeze the active dictionary identity",
			);
			requests.push(input);
			if (hold)
				await new Promise<void>((resolve) => {
					deferred.release = resolve;
				});
			const root = input.text.startsWith("猫");
			const term = root ? "猫" : input.text.includes("散歩") ? "散歩" : "道";
			const start = Array.from(
				input.text.slice(0, input.text.indexOf(term)),
			).length;
			check(
				start >= 0 && input.text.includes(term),
				"Mock lookup must find exact Japanese surface",
			);
			const match: Schema["DictionaryMatch"] = {
				id: term,
				dictionary_id: input.expected_dictionary_id,
				term,
				surface: term,
				reading: root ? "ねこ" : term === "散歩" ? "さんぽ" : "みち",
				start,
				end: start + Array.from(term).length,
				definitions: [
					{
						tag: "p",
						lang: "ja",
						role: "def2",
						text: root ? "散歩をする動物。" : "道を歩くこと。",
					},
					{
						tag: "p",
						lang: "zh",
						role: "dfcn",
						text:
							input.expected_dictionary_id === "synthetic"
								? "合成中文释义，用于检查排版。"
								: "第二本词典的独立释义。",
					},
					...Array.from({ length: 12 }, (): Schema["DictionaryNode"] => ({
						tag: "p",
						lang: "ja",
						role: "exam",
						text: "静かな道を歩く。",
					})),
				],
			};
			return Response.json({
				matches: root
					? [
							match,
							{
								...match,
								id: "cat-alternate-reading",
								reading: "マオ",
								definitions: [
									{
										tag: "p",
										lang: "ja",
										role: "def2",
										text: "別の読みの説明。",
									},
								],
							},
							{
								...match,
								id: "cat-particle",
								term: "猫が",
								surface: "猫が",
								end: start + 2,
								definitions: [
									{ tag: "p", lang: "ja", role: "def2", text: "短い説明。" },
								],
							},
							{
								...match,
								id: "cat-walk",
								term: "猫が歩く",
								surface: "猫が歩く",
								end: start + 4,
							},
						]
					: [match],
			});
		}
		if (path.startsWith("/api/segments/")) {
			const item = saved.find(
				(candidate) =>
					path === `/api/segments/${candidate.segment_id}` ||
					path === `/api/segments/${candidate.segment_id}/analyses`,
			);
			check(item, `Unknown saved record ${path}`);
			if (path.endsWith("/analyses")) return Response.json([]);
			segmentReads.push(item.segment_id);
			return Response.json({
				id: item.segment_id,
				source_id: "source",
				text: item.excerpt,
				translation:
					item.segment_id === "saved-cat"
						? "猫的已存记录译文"
						: "其他位置的记录",
				transcription: "",
				context_before: "",
				context_after: "",
				note: "",
				source_ref: "",
				revision: 0,
				text_sha256: hash,
				text_locked_at: null,
				created_at: stamp,
				updated_at: stamp,
			});
		}
		if (path.endsWith("/chapters/chapter/segments"))
			return Response.json({
				items: saved,
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path === "/api/settings/context-copy")
			return Response.json(defaultContextCopySettings);
		if (path === "/api/materials/dictionary") return Response.json(book);
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "离线来源",
				description: "",
				note: "",
				segment_count: 0,
				created_at: stamp,
				updated_at: stamp,
			});
		if (path.endsWith("/opened") || path.endsWith("/usage"))
			return Response.json({
				material_id: book.id,
				status: "in_progress",
				revision: 1,
				last_opened_at: stamp,
				updated_at: stamp,
			});
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "g1",
				token_count: 0,
			});
		if (path.endsWith("/readings"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "g1",
				resources: [],
			});
		if (path.endsWith("/chapters/chapter")) return Response.json(chapter);
		if (
			path.endsWith("/chapters/chapter/segments") ||
			path.endsWith("/chapters/chapter/translations")
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/translations"))
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (path.endsWith("/reading-position")) {
			const input: Schema["ReadingPositionUpdate"] = await request.json();
			return Response.json({
				...input,
				progress: 0,
				revision: input.expected_revision + 1,
				updated_at: stamp,
			});
		}
		throw new Error(`Unexpected dictionary ${request.method} ${path}`);
	});
	localStorage.clear();
	localStorage.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({
			focus: false,
			marks: { studySegmentUnderlines: true, studySegmentMargins: false },
		}),
	);
	let dispose = await h.mount(
		<MaterialReader />,
		"/materials/:id",
		"/materials/dictionary",
	);
	const button = (label: string, scope: ParentNode = h.container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) =>
				(item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
		);
		check(found && !found.disabled, `Missing enabled ${label}`);
		return found;
	};
	const pointer = (
		window as Window & { browserPointer?: (events: unknown[]) => Promise<void> }
	).browserPointer;
	check(pointer, "Browser runner must supply trusted pointer dispatch");
	const clickAt = async (x: number, y: number) => {
		await pointer([
			{ type: "mouseMoved", x, y },
			{ type: "mousePressed", x, y, button: "left", clickCount: 1 },
			{ type: "mouseReleased", x, y, button: "left", clickCount: 1 },
		]);
	};
	const glyphClick = async (
		element: Element,
		offset = 0,
		frame?: HTMLIFrameElement,
	) => {
		const node = element.firstChild;
		check(node?.nodeType === Node.TEXT_NODE, "Expected Japanese text node");
		const range = element.ownerDocument.createRange();
		range.setStart(node, offset);
		range.setEnd(node, offset + 1);
		const rect = range.getBoundingClientRect(),
			outer = frame?.getBoundingClientRect();
		const point = {
			x: (outer?.left ?? 0) + rect.left + rect.width / 2,
			y: (outer?.top ?? 0) + rect.top + rect.height / 2,
		};
		await clickAt(point.x, point.y);
		return point;
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 160));
	const checkCardInViewport = (card: HTMLElement) => {
		const rect = card.getBoundingClientRect();
		check(
			rect.width > 0 &&
				rect.height > 0 &&
				rect.left >= 0 &&
				rect.top >= 0 &&
				rect.right <= window.innerWidth + 1 &&
				rect.bottom <= window.innerHeight + 1,
			`Active card must fit viewport: ${JSON.stringify(rect.toJSON())}`,
		);
	};
	const checkPager = async (card: HTMLElement) => {
		await settle();
		const next = button("下一个候选", card);
		check(
			/1\s*\/\s*3/.test(card.querySelector(".dict-pager")?.textContent ?? ""),
			"Candidate pages must count original ranges rather than dictionary entries",
		);
		check(
			card.textContent?.includes("別の読みの説明。") &&
				card.textContent.includes("マオ"),
			"Different entries and readings for one range must appear together on its page",
		);
		const highlightedOriginal = () => {
			const frame = h.container.querySelector<HTMLIFrameElement>(
				"iframe.material-part",
			);
			const highlights = (
				frame?.contentWindow as (Window & { CSS: typeof CSS }) | null
			)?.CSS.highlights.get("folio-dictionary");
			return highlights
				? [...highlights].map((range) => range.toString()).join("")
				: "";
		};
		check(
			highlightedOriginal() === "猫",
			"First page must highlight its original range",
		);
		check(
			next.closest("header"),
			"Candidate paging must be in the card header",
		);
		const before = next.getBoundingClientRect();
		next.click();
		await h.until(
			() => card.getAttribute("aria-label") === "词卡 · 猫が",
			"Short candidate must replace long definition",
		);
		await settle();
		check(
			highlightedOriginal() === "猫が",
			"Paging must update actual iframe range to the short candidate",
		);
		check(
			!card.textContent?.includes("別の読みの説明。"),
			"Other-range page must replace all entries from the previous range",
		);
		const short = next.getBoundingClientRect();
		check(
			Math.abs(short.x - before.x) <= 1 && Math.abs(short.y - before.y) <= 1,
			`Header paging coordinates must remain stable on a short candidate: ${JSON.stringify({ before: before.toJSON(), after: short.toJSON(), card: card.getBoundingClientRect().toJSON() })}`,
		);
		next.click();
		await h.until(
			() => card.getAttribute("aria-label") === "词卡 · 猫が歩く",
			"Long candidate must replace short definition",
		);
		await settle();
		check(
			highlightedOriginal() === "猫が歩く",
			"Paging must update actual iframe range to the longer candidate",
		);
		const long = next.getBoundingClientRect();
		check(
			Math.abs(long.x - before.x) <= 1 && Math.abs(long.y - before.y) <= 1,
			"Header paging coordinates must remain stable after returning to a long candidate",
		);
		button("上一个候选", card).click();
		await h.until(
			() => card.getAttribute("aria-label") === "词卡 · 猫が",
			"Previous candidate must restore short definition",
		);
		button("上一个候选", card).click();
		await h.until(
			() => card.getAttribute("aria-label") === "词卡 · 猫",
			"Pager must return to initial candidate",
		);
		await settle();
	};

	try {
		await h.until(
			() =>
				!!h.container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector("[data-locator-leaf]"),
			"Reader iframe must load",
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		check(statusReads === 0, "Dictionary status is fetched only on demand");
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-installed"),
			"Settings must read installed dictionary",
		);
		const opacity = h.container.querySelector<HTMLInputElement>(
			'input[type="range"][aria-label="词卡背景不透明度"]',
		);
		check(opacity, "Dictionary settings must expose background opacity slider");
		check(
			Number(opacity.value) === 92 &&
				Number(opacity.min) === 60 &&
				Number(opacity.max) === 100,
			"Opacity slider must expose the supported default and range",
		);
		h.inputValue(opacity, "76");
		button("关闭查词设置").click();
		await h.until(
			() => !h.container.querySelector(".dict-config"),
			"Dictionary settings must close before reopening",
		);
		button("即时查词").click();
		await h.until(
			() =>
				h.container.querySelector<HTMLInputElement>(
					'input[aria-label="词卡背景不透明度"]',
				)?.value === "76",
			"Opacity must survive reopening dictionary settings",
		);
		button("点击查词").click();
		const frame = h.container.querySelector<HTMLIFrameElement>(
			"iframe.material-part",
		);
		const leaf = frame?.contentDocument?.querySelector(
			'[data-locator-leaf="0"]',
		);
		check(frame && leaf, "Loaded reader original must remain mounted");
		await glyphClick(leaf, 0, frame);
		await h.until(
			() =>
				!!h.container.querySelector(
					'.dict-card[aria-label="词卡 · 猫"] .dict-definitions',
				),
			"Body click must open root card",
		);
		check(
			requests[0]?.position === 0 && requests[0]?.text.startsWith("猫が歩く。"),
			"Actual iframe coordinates must reach dictionary input",
		);
		check(
			(
				frame.contentWindow as (Window & { CSS: typeof CSS }) | null
			)?.CSS.highlights.has("folio-dictionary"),
			"Root match must highlight actual original range",
		);
		const root = h.container.querySelector<HTMLElement>(
			'.dict-card[data-depth="0"]',
		);
		check(root, "Root card must render");
		await checkPager(root);
		const originalBackground = getComputedStyle(root).backgroundColor;
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-config"),
			"Open word card must allow opacity preview settings",
		);
		const previewOpacity = h.container.querySelector<HTMLInputElement>(
			'input[aria-label="词卡背景不透明度"]',
		);
		check(previewOpacity, "Open word card settings must retain opacity slider");
		h.inputValue(previewOpacity, "84");
		await h.until(
			() => getComputedStyle(root).backgroundColor !== originalBackground,
			"Opacity slider must update the existing card background immediately",
		);
		check(
			getComputedStyle(root).opacity === "1",
			"Background opacity must preserve opaque dictionary text",
		);
		h.inputValue(previewOpacity, "76");
		await h.until(
			() => getComputedStyle(root).backgroundColor === originalBackground,
			"Opacity preview must restore the chosen preference",
		);
		button("关闭查词设置").click();
		await h.until(
			() => !h.container.querySelector(".dict-config"),
			"Preview settings must close",
		);
		check(
			h.container.querySelector('.dict-card[data-depth="0"]') === root,
			"Closing opacity settings must retain the opened word card",
		);
		const prose = root.querySelector<HTMLElement>('[data-dict-role="def2"]');
		check(prose, "Japanese definition must render");
		const childOrigin = await glyphClick(prose, 1);
		await h.until(
			() => h.container.querySelectorAll(".dict-card").length === 2,
			"Japanese definition click must open child card",
		);
		check(
			requests[1]?.text === "散歩をする動物。" && requests[1]?.position === 1,
			"Nested click must use Japanese definition and middle glyph offset",
		);
		const child = h.container.querySelector<HTMLElement>(
			'.dict-card[data-depth="1"]',
		);
		check(child, "Child card must exist");
		await settle();
		const a = root.getBoundingClientRect(),
			b = child.getBoundingClientRect();
		if (window.innerWidth < 740)
			check(
				b.top > a.top + 30 && b.left < a.right,
				"Narrow screen child must step down with parent exposed",
			);
		checkCardInViewport(child);
		if (window.innerWidth >= 740) {
			check(
				!(
					childOrigin.x >= b.left &&
					childOrigin.x <= b.right &&
					childOrigin.y >= b.top &&
					childOrigin.y <= b.bottom
				),
				"Desktop child must leave its clicked Japanese glyph exposed when surrounding space is available",
			);
			for (let depth = 2; depth <= 3; depth++) {
				const parent = h.container.querySelector<HTMLElement>(
					`.dict-card[data-depth="${depth - 1}"]`,
				);
				const text = parent?.querySelector<HTMLElement>(
					'[data-dict-role="def2"]',
				);
				check(
					parent && text,
					`Depth ${depth} parent definition must remain available`,
				);
				const origin = await glyphClick(text);
				await h.until(
					() => h.container.querySelectorAll(".dict-card").length === depth + 1,
					`Desktop Japanese prose must open depth ${depth + 1}`,
				);
				await settle();
				const active = h.container.querySelector<HTMLElement>(
					`.dict-card[data-depth="${depth}"]`,
				);
				check(active, "Nested active card must exist");
				checkCardInViewport(active);
				const box = active.getBoundingClientRect();
				check(
					!(
						origin.x >= box.left &&
						origin.x <= box.right &&
						origin.y >= box.top &&
						origin.y <= box.bottom
					),
					`Deep desktop card must leave its actual clicked Japanese glyph exposed when space is available: ${JSON.stringify({ depth, origin, box: box.toJSON(), parents: [...h.container.querySelectorAll<HTMLElement>(".dict-card")].map((card) => card.getBoundingClientRect().toJSON()) })}`,
				);
				check(
					h.container.querySelector('.dict-card[data-depth="0"]') === root &&
						root.getBoundingClientRect().width > 0,
					"Deep desktop lookup must retain the earliest visible card and its DOM identity",
				);
			}
			for (let depth = 3; depth >= 2; depth--) {
				const active = h.container.querySelector<HTMLElement>(
					`.dict-card[data-depth="${depth}"]`,
				);
				check(active, "Deep card must support returning one level");
				button("返回上层词卡", active).click();
				await h.until(
					() => h.container.querySelectorAll(".dict-card").length === depth,
					"Back must unwind one desktop level",
				);
			}
			check(
				h.container.querySelector('.dict-card[data-depth="1"]') === child,
				"Returning from deep lookup must preserve the second card DOM",
			);
		}
		const scroll = child.querySelector<HTMLElement>(".dict-scroll");
		check(scroll, "Child must own scroll container");
		scroll.scrollTop = 80;
		scroll.dispatchEvent(new Event("scroll"));
		check(
			h.container.querySelectorAll(".dict-card").length === 2,
			"Card scrolling must retain parent and child",
		);
		button("返回上层词卡", child).click();
		await h.until(
			() => h.container.querySelectorAll(".dict-card").length === 1,
			"Back must restore parent card",
		);
		check(
			h.container.querySelector('.dict-card[aria-label="词卡 · 猫"]') === root,
			"Back must preserve parent DOM identity",
		);
		button("关闭查词", root).click();
		await h.until(
			() => !h.container.querySelector(".dict-deck"),
			"Close must dismiss all cards",
		);
		check(
			!(
				frame.contentWindow as (Window & { CSS: typeof CSS }) | null
			)?.CSS.highlights.has("folio-dictionary"),
			"Close must clear root highlight",
		);
		const viewport = h.container.querySelector<HTMLElement>(".reader-viewport");
		const bottomLeaf = frame.contentDocument?.querySelector(
			'[data-locator-leaf="18"]',
		);
		check(
			viewport && bottomLeaf,
			"Bottom-anchor regression needs a later original paragraph",
		);
		viewport.scrollTop +=
			frame.getBoundingClientRect().top +
			bottomLeaf.getBoundingClientRect().top -
			window.innerHeight * 0.75;
		await settle();
		await glyphClick(bottomLeaf, 0, frame);
		await h.until(
			() =>
				!!h.container.querySelector(
					'.dict-card[aria-label="词卡 · 猫"] .dict-definitions',
				),
			"Near-bottom original must open a card above its anchor",
		);
		const above = h.container.querySelector<HTMLElement>(
			'.dict-card[data-depth="0"]',
		);
		check(above, "Near-bottom card must exist");
		await settle();
		check(
			above.getBoundingClientRect().bottom <=
				frame.getBoundingClientRect().top +
					bottomLeaf.getBoundingClientRect().top,
			"Near-bottom lookup must place the card above the clicked original",
		);
		await checkPager(above);
		button("关闭查词", above).click();
		viewport.scrollTop = 0;
		await settle();
		// There are no margin entrances: dictionary mode must still retain access to this exact saved mark.
		check(
			!h.container.querySelector(".reader-study-margin"),
			"Record lookup must work with margin entrances disabled",
		);
		await glyphClick(leaf, 0, frame);
		await h.until(
			() => !!h.container.querySelector(".dict-definitions"),
			"Saved mark must open dictionary in click mode",
		);
		button("此处记录 ↗").click();
		await h.until(
			() =>
				!!h.container
					.querySelector(".reader-chapter-records")
					?.textContent?.includes("猫的已存记录译文"),
			"Dictionary record action must open the exact saved cat record",
		);
		check(
			segmentReads.includes("saved-cat") &&
				!segmentReads.includes("other-record"),
			"Record action must not load the unrelated chapter record",
		);
		check(
			!h.container.querySelector(".dict-deck"),
			"Record action must dismiss dictionary cards",
		);
		button("关闭阅读记录").click();
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-modes"),
			"Dictionary mode controls must open",
		);
		button("Shift 悬浮").click();
		const countBeforeOrdinaryClick = requests.length;
		await glyphClick(leaf, 0, frame);
		await h.until(
			() =>
				!!h.container
					.querySelector(".reader-chapter-records")
					?.textContent?.includes("猫的已存记录译文"),
			"Ordinary marked mouse click in Shift mode must retain original record behavior",
		);
		check(
			!h.container.querySelector(".dict-deck") &&
				requests.length === countBeforeOrdinaryClick,
			"Ordinary marked click must not start dictionary lookup in Shift mode",
		);
		button("关闭阅读记录").click();
		// Return to click mode before the pending-result regression below.
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-modes"),
			"Dictionary mode controls must reopen",
		);
		button("点击查词").click();
		// A fresh body coordinate avoids the query cache; closing while it is pending must win.
		hold = true;
		const nextLeaf = frame.contentDocument?.querySelector(
			'[data-locator-leaf="1"]',
		);
		check(nextLeaf, "Second original paragraph must be visible");
		await glyphClick(nextLeaf, 3, frame);
		await h.until(
			() => !!deferred.release && !!h.container.querySelector(".dict-deck"),
			"Pending lookup must expose a closable card",
		);
		button("关闭查词").click();
		check(deferred.release, "Pending mock response must have a release");
		deferred.release();
		await new Promise((resolve) => setTimeout(resolve, 150));
		check(
			!h.container.querySelector(".dict-deck"),
			"Late lookup result must not reopen a closed deck",
		);
		if (innerWidth === 1280) {
			hold = false;
			await glyphClick(nextLeaf, 3, frame);
			await h.until(
				() =>
					h.container
						.querySelector(".dict-card")
						?.textContent?.includes("合成中文释义，用于检查排版。") === true,
				"A dictionary card must open before cross-tab library changes",
			);
			const previousCard = h.container.querySelector(".dict-card");
			const broadcast = () =>
				window.dispatchEvent(
					new StorageEvent("storage", {
						key: "folio-j:dictionary-library-changed",
						newValue: String(Date.now()),
						storageArea: localStorage,
					}),
				);
			const beforeImport = statusReads;
			broadcast();
			await h.until(
				() => statusReads > beforeImport,
				"Importing an unselected dictionary in another tab must recheck the active identity",
			);
			await settle();
			check(
				previousCard?.isConnected &&
					previousCard === h.container.querySelector(".dict-card") &&
					previousCard.textContent?.includes("合成测试词典") &&
					previousCard.textContent.includes("合成中文释义，用于检查排版。"),
				"A library change retaining the same active dictionary must preserve the current word card",
			);
			activeDictionaryId = "synthetic-next";
			activeDictionaryTitle = "第二本合成词典";
			broadcast();
			await h.until(
				() => !h.container.querySelector(".dict-deck"),
				"Changing the active dictionary in another tab must clear the previous cards",
			);
			const beforeLookup = requests.length;
			await glyphClick(nextLeaf, 3, frame);
			await h.until(
				() =>
					h.container
						.querySelector(".dict-card")
						?.textContent?.includes("第二本词典的独立释义。") === true,
				"The next lookup must fetch definitions from the new dictionary",
			);
			const nextCard = h.container.querySelector(".dict-card");
			check(
				requests.length === beforeLookup + 1 &&
					requests.at(-1)?.expected_dictionary_id === activeDictionaryId &&
					nextCard?.textContent?.includes(activeDictionaryTitle) &&
					!nextCard.textContent.includes("合成中文释义，用于检查排版。"),
				"A dictionary switch must bypass old lookup cache and pair the new title with only its own definitions",
			);
			button("关闭查词").click();
		}
		dispose();
		dispose = await h.mount(<Outlet />, "/", "/materials/dictionary", [
			{ path: "materials/:id", element: <MaterialReader /> },
			{ path: "settings", element: <SettingsPage /> },
		]);
		await h.until(
			() => !!h.container.querySelector(".dict-trigger"),
			"Reader must remount for preference persistence",
		);
		button("即时查词").click();
		await h.until(
			() =>
				h.container.querySelector<HTMLInputElement>(
					'input[aria-label="词卡背景不透明度"]',
				)?.value === "76",
			"Dictionary opacity must persist across Reader remounts",
		);
		const manage = [
			...h.container.querySelectorAll<HTMLAnchorElement>(".dict-config a"),
		].find((link) => link.textContent?.trim() === "管理词典");
		check(
			manage?.getAttribute("href") === "/settings?section=dictionary",
			"The Reader dictionary menu must link to central dictionary settings",
		);
		check(
			!h.container.querySelector('.dict-config input[type="file"]'),
			"Dictionary imports must live in central settings",
		);
		manage.click();
		await h.until(
			() =>
				!!h.container.querySelector(
					`input[aria-label="使用${activeDictionaryTitle}"]`,
				),
			"The Reader management link must open the installed dictionary library",
		);
		const back = h.container.querySelector<HTMLAnchorElement>(
			'a[aria-label="返回阅读"]',
		);
		check(
			back?.getAttribute("href") === "/materials/dictionary",
			"Dictionary settings reached from a book must provide its return reading link",
		);
		back.click();
		await h.until(
			() => !!h.container.querySelector(".dict-trigger"),
			"Returning from dictionary settings must reopen the source book",
		);
		return `dictionary: real body→Japanese child→${window.innerWidth >= 740 ? "four desktop levels" : "compact stack"}→back→close; saved mark + Shift click retain records; late response ignored`;
	} finally {
		dispose();
	}
}
