import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const hash = "a".repeat(64);
const stamp = "2026-10-31T00:00:00Z";

/** Exercise the actual Reader, iframe glyph projection and nested dictionary cards without a network. */
export async function readerDictionary(h: BrowserHarness) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const check: BrowserHarness["check"] = h.check;
	const paragraphs = [
		"猫が歩く。",
		...Array.from({ length: 36 }, () => "静かな道を歩く。"),
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
	let hold = false;
	const deferred: { release?: () => void } = {};
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/dictionary" && request.method === "GET") {
			statusReads++;
			return Response.json({
				ready: true,
				dictionary_id: "synthetic",
				title: "合成测试词典",
				revision: "1",
				entry_count: 3,
			});
		}
		if (path === "/api/dictionary/lookup" && request.method === "POST") {
			const input: Schema["DictionaryLookupRequest"] = await request.json();
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
			return Response.json({
				matches: [
					{
						id: term,
						dictionary_id: "synthetic",
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
								text: "合成中文释义，用于检查排版。",
							},
							...Array.from({ length: 12 }, () => ({
								tag: "p",
								lang: "ja",
								role: "exam",
								text: "静かな道を歩く。",
							})),
						],
					},
				],
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
	const dispose = await h.mount(
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
		await clickAt(
			(outer?.left ?? 0) + rect.left + rect.width / 2,
			(outer?.top ?? 0) + rect.top + rect.height / 2,
		);
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
		const prose = root?.querySelector<HTMLElement>('[data-dict-role="def2"]');
		check(root && prose, "Japanese definition must render");
		await glyphClick(prose, 1);
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
		const a = root.getBoundingClientRect(),
			b = child.getBoundingClientRect();
		if (window.innerWidth >= 900)
			check(
				b.left >= a.right - 2,
				"Desktop parent and child must sit side by side",
			);
		else
			check(
				b.top > a.top + 30 && b.left < a.right,
				"Narrow screen child must step down with parent exposed",
			);
		check(
			b.left >= 0 &&
				b.right <= window.innerWidth + 1 &&
				b.bottom <= window.innerHeight + 1,
			"Active card must fit viewport",
		);
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
		return `dictionary: real body→Japanese child→${window.innerWidth >= 900 ? "desktop pair" : "compact stack"}→back→close; saved mark + Shift click retain records; late response ignored`;
	} finally {
		dispose();
	}
}
