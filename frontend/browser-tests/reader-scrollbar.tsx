import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const timestamp = "2026-11-09T00:00:00Z";
const hash = "a".repeat(64);
const settings = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb" as const,
};

// Generated sentences keep these fixtures independent of any imported book.
function chapterFor(id: string, parts: string[][]) {
	let offset = 0;
	let leaf = 0;
	const chapter: Schema["MaterialChapterResponse"] = {
		id: "chapter",
		material_id: id,
		version_id: "v1",
		title: "滚动条占宽回归",
		level: 0,
		resources: [
			{
				id: "resource",
				text: parts.flat().join(""),
				text_sha256: hash,
				href: "chapter.xhtml",
				css: "p{margin:0;overflow-wrap:anywhere}",
				html_attributes: { lang: "ja" },
				body_attributes: {},
			},
		],
		parts: parts.map((paragraphs) => {
			const start = offset;
			const first = leaf;
			offset += paragraphs.join("").length;
			return {
				resource_id: "resource",
				spine_index: 0,
				start,
				end: offset,
				leaf_start: first,
				leaf_end: first + paragraphs.length,
				html: paragraphs
					.map(
						(text) =>
							`<p><span data-locator-leaf="${leaf++}">${text}</span></p>`,
					)
					.join(""),
			};
		}),
	};
	return chapter;
}

/** Exercise occupied scrollbars with the production reader and mock API. */
export async function readerScrollbar(h: BrowserHarness) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const check: BrowserHarness["check"] = h.check;
	const keep =
		new URLSearchParams(location.search).has("capture") ||
		new URLSearchParams(location.search).has("preview");
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	const style = document.createElement("style");
	// Custom scrollbars allocate layout space even on macOS overlay defaults.
	// Only the environment is overridden; gutter behavior is production CSS.
	style.textContent = `
		#root .reader-viewport{scrollbar-width:auto;scrollbar-color:auto}
		#root .reader-viewport::-webkit-scrollbar{display:block;width:32px;height:16px}
	`;
	document.head.append(style);
	const frames = () => [
		...h.container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	const viewport = () => {
		const root = h.container.querySelector<HTMLElement>(".reader-viewport");
		check(root, "Reader viewport must exist");
		return root;
	};
	const leafRects = (frame: HTMLIFrameElement) => {
		const leaves = frame.contentDocument?.querySelectorAll<HTMLElement>(
			"[data-locator-leaf]",
		);
		return [...(leaves ?? [])].flatMap((leaf) => [...leaf.getClientRects()]);
	};
	const assertHorizontal = (label: string) => {
		const root = viewport();
		check(
			root.offsetWidth - root.clientWidth > 0,
			`${label} must exercise an actually space-consuming scrollbar: ${root.offsetWidth}/${root.clientWidth}; gutter=${getComputedStyle(root).scrollbarGutter}; width=${getComputedStyle(root).scrollbarWidth}; custom=${getComputedStyle(root, "::-webkit-scrollbar").width}; scoped=${root.matches("#root .reader-viewport")}`,
		);
		check(
			root.scrollWidth <= root.clientWidth + 1 &&
				Math.abs(root.scrollLeft) <= 1,
			`${label} must not overflow horizontally: ${root.scrollWidth}/${root.clientWidth}`,
		);
		for (const [index, frame] of frames().entries()) {
			const rects = leafRects(frame);
			check(rects.length > 0, `${label} part ${index} must contain text`);
			check(
				rects.every(
					(rect) =>
						rect.top >= -1 &&
						rect.bottom <= frame.clientHeight + 1 &&
						rect.left >= -1 &&
						rect.right <= frame.clientWidth + 1,
				),
				`${label} part ${index} must contain every original-text rectangle, including wrapped tails: frame=${frame.clientWidth}x${frame.clientHeight}; tails=${JSON.stringify(rects.slice(-4).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })))}`,
			);
		}
	};
	const visibleLeaf = (index: number) => {
		const root = viewport();
		const view = root.getBoundingClientRect();
		return frames().some((frame) => {
			const outer = frame.getBoundingClientRect();
			const leaf = frame.contentDocument?.querySelector<HTMLElement>(
				`[data-locator-leaf="${index}"]`,
			);
			return [...(leaf?.getClientRects() ?? [])].some(
				(rect) =>
					outer.left + rect.right > view.left &&
					outer.left + rect.left < view.left + root.clientWidth &&
					outer.top + rect.bottom > view.top &&
					outer.top + rect.top < view.top + root.clientHeight,
			);
		});
	};
	const assertEndVisible = async (label: string) => {
		const root = viewport();
		root.scrollTop = root.scrollHeight;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const frame = frames().at(-1);
		check(frame, `${label} must have a final iframe`);
		const last = leafRects(frame).at(-1);
		check(last, `${label} must have a final original-text rectangle`);
		const outer = frame.getBoundingClientRect();
		const view = root.getBoundingClientRect();
		check(
			Math.abs(root.scrollHeight - root.clientHeight - root.scrollTop) <= 1 &&
				outer.top + last.top >= view.top - 1 &&
				outer.top + last.bottom <= view.top + root.clientHeight + 1,
			`${label} must expose the final text at the real scroll end: last=${outer.top + last.top}..${outer.top + last.bottom}; viewport=${view.top}..${view.top + root.clientHeight}; scroll=${root.scrollTop}/${root.scrollHeight - root.clientHeight}`,
		);
	};
	const mountScene = async (
		name: string,
		parts: string[][],
		initialLeaf = 0,
	) => {
		const id = `reader-scrollbar-${name}`;
		const chapter = chapterFor(id, parts);
		const saved: Schema["ReadingPositionUpdate"][] = [];
		const initialOffset = parts.flat().slice(0, initialLeaf).join("").length;
		const book: Schema["MaterialResponse"] = {
			id,
			source_id: "source",
			title: chapter.title,
			version_id: "v1",
			contract_version: "1",
			product_sha256: hash,
			source_sha256: hash,
			created_at: timestamp,
			warnings: [],
			chapters: [
				{
					id: chapter.id,
					title: chapter.title,
					level: 0,
					part_count: parts.length,
				},
			],
			reading_position: {
				chapter_id: chapter.id,
				resource_id: "resource",
				version_id: "v1",
				part_index: 0,
				kind: "text",
				offset: initialOffset,
				at_chapter_end: false,
				progress: 0,
				revision: 0,
				updated_at: timestamp,
				settings,
			},
		};
		h.mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET") {
				if (path.endsWith("/usage"))
					return Response.json({
						material_id: id,
						status: "in_progress",
						revision: 1,
						last_opened_at: timestamp,
						updated_at: timestamp,
					} satisfies Schema["MaterialUsageResponse"]);
				if (path === "/api/settings/context-copy")
					return Response.json(defaultContextCopySettings);
				if (path.endsWith("/readings"))
					return Response.json({
						material_id: id,
						version_id: "v1",
						generation_id: "g",
						resources: [],
					} satisfies Schema["MaterialReadingsResponse"]);
				if (path === `/api/materials/${id}`) return Response.json(book);
				if (path === "/api/sources/source")
					return Response.json({
						id: "source",
						title: "合成测试",
						description: "",
						note: "",
						segment_count: 0,
						created_at: timestamp,
						updated_at: timestamp,
					} satisfies Schema["SourceResponse"]);
				if (path === `/api/materials/${id}/chapters/${chapter.id}`)
					return Response.json(chapter);
				if (
					path.endsWith("/segments") ||
					path.endsWith(`/chapters/${chapter.id}/translations`)
				)
					return Response.json({
						items: [],
						next_cursor: null,
						unavailable_count: 0,
					});
				if (path.endsWith("/translations"))
					return Response.json({ results: [], tasks: [], next_offset: null });
			}
			if (request.method === "POST" && path.endsWith("/readings/prepare"))
				return Response.json({
					material_id: id,
					version_id: "v1",
					generation_id: "g",
					token_count: 0,
				} satisfies Schema["MaterialReadingsSummary"]);
			if (request.method === "POST" && path.endsWith("/opened"))
				return Response.json({
					material_id: id,
					status: "in_progress",
					revision: 1,
					last_opened_at: timestamp,
					updated_at: timestamp,
				} satisfies Schema["MaterialUsageResponse"]);
			if (request.method === "PUT" && path.endsWith("/reading-position")) {
				const update: Schema["ReadingPositionUpdate"] = await request.json();
				saved.push(update);
				return Response.json({
					...update,
					revision: update.expected_revision + 1,
					progress: 0,
					updated_at: timestamp,
				} satisfies Schema["ReadingPositionResponse"]);
			}
			throw new Error(`Unmocked scrollbar request ${request.method} ${path}`);
		});
		const dispose = await h.mount(
			<MaterialReader />,
			"/materials/:id",
			`/materials/${id}`,
		);
		await h.until(
			() => frames().length === parts.length && saved.length > 0,
			`${name} must complete the production reader layout and initial position save`,
		);
		return { dispose, saved, initialOffset };
	};
	try {
		const short = await mountScene("short", [["あい"]]);
		let width: number;
		let glyphWidth: number;
		let padding: number;
		const lineHeight = settings.font_size * settings.line_height;
		try {
			assertHorizontal("Short chapter");
			const root = viewport();
			const frame = frames()[0];
			check(frame?.contentDocument, "Short chapter document must exist");
			width = frame.clientWidth;
			const text = frame.contentDocument.querySelector(
				"[data-locator-leaf]",
			)?.firstChild;
			check(text, "Short chapter text must exist");
			const range = frame.contentDocument.createRange();
			range.setStart(text, 0);
			range.setEnd(text, 1);
			glyphWidth = range.getBoundingClientRect().width;
			const css = getComputedStyle(root);
			padding =
				Number.parseFloat(css.paddingTop) +
				Number.parseFloat(css.paddingBottom);
			check(
				root.scrollHeight === root.clientHeight &&
					root.scrollTop === 0 &&
					frame.clientHeight <= lineHeight + 1,
				`Short chapter must not create an empty scroll tail: viewport=${root.scrollHeight}/${root.clientHeight}, frame=${frame.clientHeight}`,
			);
		} finally {
			short.dispose();
		}

		const paragraphs = Array.from(
			{ length: 100 },
			(_, index) =>
				`第${String(index).padStart(3, "0")}段。青い空の下で小さな川が静かに流れる。` +
				"あいうえお".repeat(18) +
				"あ".repeat(index),
		);
		const long = await mountScene("long", [paragraphs], 40);
		try {
			assertHorizontal("Long single iframe");
			check(
				frames()[0]?.clientWidth === width,
				"Scrollbar appearance must retain the short chapter's exact text width",
			);
			check(
				visibleLeaf(40),
				"Long chapter must restore the requested original-text midpoint",
			);
			const previous = frames();
			const documents = previous.map((frame) => frame.contentDocument);
			const open = h.container.querySelector<HTMLButtonElement>(
				'button[aria-label="阅读设置"]',
			);
			check(open, "Real Aa reading settings control must exist");
			open.click();
			await h.until(
				() => !!h.container.querySelector('[aria-label="文字方向"]'),
				"Aa settings must open",
			);
			for (const [mode, label] of [
				["vertical-rl", "竖排"],
				["horizontal-tb", "横排"],
			] as const) {
				const control = [
					...h.container.querySelectorAll<HTMLButtonElement>(
						'[aria-label="文字方向"] button',
					),
				].find((button) => button.textContent === label);
				check(control, `Missing real ${label} settings control`);
				const before = long.saved.length;
				control.click();
				await h.until(
					() =>
						long.saved.length > before &&
						long.saved.at(-1)?.settings?.writing_mode === mode,
					`${label} must finish layout and persist the restored anchor`,
				);
				check(
					frames().every((frame) => {
						const body = frame.contentDocument?.body;
						return (
							body &&
							frame.contentWindow?.getComputedStyle(body).writingMode === mode
						);
					}),
					`${label} must update the actual iframe writing mode`,
				);
				check(
					frames().every(
						(frame, index) =>
							frame === previous[index] &&
							frame.contentDocument === documents[index],
					),
					`${label} must retain iframe and Document identities`,
				);
				check(
					visibleLeaf(40),
					`${label} must keep the original midpoint visible`,
				);
				check(
					Math.abs((long.saved.at(-1)?.offset ?? -1) - long.initialOffset) <=
						(paragraphs[40]?.length ?? 0),
					`${label} must retain the saved original-text anchor`,
				);
				if (mode === "vertical-rl") {
					const root = viewport();
					check(
						root.scrollHeight <= root.clientHeight + 1 && root.scrollTop === 0,
						"Vertical reading must have no vertical overflow",
					);
				} else {
					assertHorizontal("Return to horizontal reading");
					check(
						frames()[0]?.clientWidth === width,
						"Returning to horizontal reading must restore the exact original text width",
					);
				}
			}
			await assertEndVisible("Long single iframe");
		} finally {
			long.dispose();
		}

		// Each part occupies four lines before scrollbar allocation and five at
		// the reserved width. Two complete parts still fit when a third is
		// temporarily reduced to 1px for measurement, so every sizing pass can
		// hide and reintroduce the scrollbar. The old total exceeds room by 1px.
		const thresholdText = "あ".repeat(
			4 * Math.floor((width + 32) / glyphWidth),
		);
		const thresholdStyle = document.createElement("style");
		thresholdStyle.textContent = `#root .reader-viewport:not(.material-vertical){bottom:auto;height:${padding + 12 * lineHeight - 1}px}`;
		document.head.append(thresholdStyle);
		let completed = false;
		try {
			const multiple = await mountScene("threshold", [
				[thresholdText],
				[thresholdText],
				[thresholdText],
			]);
			try {
				assertHorizontal("Three iframes crossing the scrollbar threshold");
				const root = viewport();
				check(
					root.scrollHeight > root.clientHeight,
					"The combined parts must overflow even though every individual part fits the viewport",
				);
				check(
					frames().every(
						(frame) => frame.clientHeight < root.clientHeight - padding,
					),
					"Threshold fixture must contain individually short iframes",
				);
				check(
					frames().every((frame) => frame.clientWidth === width),
					"Every threshold part must use the same stable text width",
				);
				await assertEndVisible(
					"Three iframes crossing the scrollbar threshold",
				);
				completed = true;
			} finally {
				if (!keep || !completed) multiple.dispose();
			}
		} finally {
			if (!keep || !completed) thresholdStyle.remove();
		}
		return "reader scrollbar: classic occupied gutter, short/long stable width, complete single/multipart tails, true scroll end and Aa horizontal → vertical → horizontal identity/anchor preservation";
	} finally {
		if (!keep) style.remove();
	}
}
