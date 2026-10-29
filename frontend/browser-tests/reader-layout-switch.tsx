import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];
const timestamp = "2026-10-29T00:00:00Z";
const hash = "a".repeat(64);
const materialId = "reader-layout-switch";
const chapterId = "long-chapter";
const paragraphs = Array.from(
	{ length: 400 },
	(_, index) =>
		`春の風。第${String(index).padStart(3, "0")}段落。静かな庭を通り抜ける。`,
);
const startAt = (index: number) => paragraphs.slice(0, index).join("").length;
const chapter: Schema["MaterialChapterResponse"] = {
	id: chapterId,
	material_id: materialId,
	version_id: "v1",
	title: "横竖排切换回归",
	level: 0,
	resources: [
		{
			id: "r",
			text: paragraphs.join(""),
			text_sha256: hash,
			href: "chapter.xhtml",
			css: "p{margin:0 0 1.8em}",
			html_attributes: { lang: "ja" },
			body_attributes: {},
		},
	],
	parts: [0, 140, 280].map((first, index) => {
		const end = index === 2 ? 400 : first + 140;
		return {
			resource_id: "r",
			spine_index: 0,
			start: startAt(first),
			end: startAt(end),
			leaf_start: first,
			leaf_end: end,
			html: paragraphs
				.slice(first, end)
				.map(
					(value, local) =>
						`<p><span data-locator-leaf="${first + local}">${value}</span></p>`,
				)
				.join(""),
		};
	}),
};
const book: Schema["MaterialResponse"] = {
	id: materialId,
	source_id: "source",
	title: "横竖排切换回归",
	version_id: "v1",
	contract_version: "1",
	product_sha256: hash,
	source_sha256: hash,
	created_at: timestamp,
	warnings: [],
	chapters: [{ id: chapterId, title: chapter.title, level: 0, part_count: 3 }],
	reading_position: {
		chapter_id: chapterId,
		resource_id: "r",
		version_id: "v1",
		part_index: 1,
		kind: "text",
		offset: startAt(200),
		at_chapter_end: false,
		progress: 0.5,
		revision: 0,
		updated_at: timestamp,
		settings: { font_size: 22, line_height: 2, writing_mode: "horizontal-tb" },
	},
};

/** Exercise the real settings controls and retained same-origin reading frames. */
export async function readerLayoutSwitch(h: BrowserHarness) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const params = new URLSearchParams(location.search);
	const initialVertical = params.get("direction") === "vertical-rl";
	const preview = params.has("preview");
	const check: BrowserHarness["check"] = h.check;
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	localStorage.setItem(
		`folio-reader-book-ui-v1:${materialId}:v1`,
		JSON.stringify({ rubyScope: "all" }),
	);
	let releaseReadings = () => {};
	const readingsGate = new Promise<void>((resolve) => {
		releaseReadings = resolve;
	});
	let readingsRequested = false;
	const saved: Schema["ReadingPositionUpdate"][] = [];
	let opened = false;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		check(
			request.method === "GET" ||
				(request.method === "POST" &&
					(path.endsWith("/opened") || path.endsWith("/readings/prepare"))) ||
				(request.method === "PUT" && path.endsWith("/reading-position")),
			`Unexpected layout-switch side effect ${request.method} ${path}`,
		);
		if (path === `/api/materials/${materialId}`)
			return Response.json({
				...book,
				reading_position: {
					...book.reading_position,
					settings: {
						...book.reading_position?.settings,
						writing_mode: initialVertical ? "vertical-rl" : "horizontal-tb",
					},
				},
			});
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "Source",
				description: "",
				note: "",
				segment_count: 3,
				created_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["SourceResponse"]);
		if (path === `/api/materials/${materialId}/chapters/${chapterId}`)
			return Response.json(chapter);
		if (path.endsWith("/segments"))
			return Response.json({
				items: [20, 200, 350].map((index) => ({
					segment_id: `saved-${index}`,
					excerpt: paragraphs[index] ?? "",
					created_at: timestamp,
					material_provenance: {
						contract_version: "1",
						material_id: materialId,
						version_id: "v1",
						ranges: [
							{
								resource_id: "r",
								spine_index: 0,
								start: startAt(index),
								end: startAt(index + 1),
								exact: paragraphs[index] ?? "",
								text_sha256: hash,
								prefix: "",
								suffix: "",
							},
						],
					},
				})),
				next_cursor: null,
				unavailable_count: 0,
			} satisfies Schema["MaterialChapterSegmentsResponse"]);
		if (path.endsWith(`/chapters/${chapterId}/translations`))
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/translations"))
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: materialId,
				version_id: "v1",
				generation_id: "generation",
				token_count: paragraphs.length,
			} satisfies Schema["MaterialReadingsSummary"]);
		if (path.endsWith("/readings")) {
			readingsRequested = true;
			await readingsGate;
			return Response.json({
				material_id: materialId,
				version_id: "v1",
				generation_id: "generation",
				resources: [
					{
						resource_id: "r",
						text_sha256: hash,
						tokens: paragraphs.map((_, index) => ({
							start: startAt(index),
							end: startAt(index) + 1,
							surface: "春",
							reading: "ハル",
							dictionary_form: "春",
							normalized_form: "春",
							is_oov: false,
							pos: ["名詞"],
						})),
					},
				],
			} satisfies Schema["MaterialReadingsResponse"]);
		}
		if (path.endsWith("/opened") || path.endsWith("/usage")) {
			if (path.endsWith("/opened")) opened = true;
			return Response.json({
				material_id: materialId,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["MaterialUsageResponse"]);
		}
		if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			saved.push(update);
			return Response.json({
				...update,
				revision: update.expected_revision + 1,
				progress: 0.5,
				updated_at: timestamp,
			} satisfies Schema["ReadingPositionResponse"]);
		}
		throw new Error(`Unmocked layout-switch request ${request.method} ${path}`);
	});
	const dispose = await h.mount(
		<MaterialReader />,
		"/materials/:id",
		`/materials/${materialId}`,
	);
	try {
		await h.until(
			() => readingsRequested,
			"All-scope initial reading assets must be requested",
		);
		check(
			!h.container.querySelector(".reader-viewport") && saved.length === 0,
			"Pending readings must not mount a provisional viewport or save a temporary position",
		);
		releaseReadings();
		const frames = () => [
			...h.container.querySelectorAll<HTMLIFrameElement>(
				"iframe.material-part",
			),
		];
		await h.until(
			() => opened && frames().length === 3 && saved.length > 0,
			"Reader must present all three frames at the saved chapter midpoint",
		);
		check(
			frames().every(
				(frame) =>
					!!frame.contentDocument?.querySelector("ruby[data-auto-ruby]"),
			),
			"Late all-scope assets must decorate the newly mounted reading frames",
		);
		const previous = frames();
		const documents = previous.map((frame) => frame.contentDocument);
		const viewport = h.container.querySelector<HTMLElement>(".reader-viewport");
		check(viewport, "Reader viewport must exist");
		const visibleParagraphs = () => {
			const view = viewport.getBoundingClientRect();
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
		check(
			visibleParagraphs().includes(200) &&
				(initialVertical
					? Math.abs(viewport.scrollLeft) > viewport.clientWidth
					: viewport.scrollTop > viewport.clientHeight),
			"Initial reading position must be in the middle of the second frame",
		);
		await h.until(
			() =>
				h.container.querySelectorAll(".reader-study-margin").length ===
				(!initialVertical && innerWidth <= 720 ? 0 : 3),
			"Initial study margins must be rendered before switching direction",
		);
		const beforeLateMountResize = saved.length;
		viewport.style.height = `${viewport.clientHeight - 40}px`;
		await h.until(
			() => saved.length > beforeLateMountResize,
			"The first resize after delayed readings mount must restore and save",
		);
		check(
			visibleParagraphs().includes(200),
			"Delayed readings mount must establish a usable recovery baseline for resize",
		);
		if (preview)
			return "reader layout switch fixture: chapter midpoint with study marks";
		const settings = h.container.querySelector<HTMLButtonElement>(
			'button[aria-label="阅读设置"]',
		);
		check(settings, "Real reader settings control must exist");
		settings.click();
		await h.until(
			() => !!h.container.querySelector('[aria-label="文字方向"]'),
			"Reading settings must open",
		);
		const assertMargins = async (mode: "horizontal-tb" | "vertical-rl") => {
			const vertical = mode === "vertical-rl";
			const expected = !vertical && innerWidth <= 720 ? 0 : 3;
			await h.until(
				() =>
					h.container.querySelectorAll(".reader-study-margin").length ===
					expected,
				`Study margins must follow ${mode} and available width (expected ${expected})`,
			);
			if (!expected) return;
			const frame = frames()[1];
			const leaf = frame?.contentDocument?.querySelector(
				'[data-locator-leaf="200"]',
			);
			const source = leaf?.getClientRects()[0];
			check(
				frame && source,
				"Midpoint source rectangle must exist for study margin alignment",
			);
			const outer = frame.getBoundingClientRect();
			const target = vertical
				? outer.left + source.left
				: outer.top + source.top;
			const distance = () =>
				Math.min(
					...[
						...h.container.querySelectorAll<HTMLButtonElement>(
							".reader-study-margin",
						),
					].map((mark) => {
						const rect = mark.getBoundingClientRect();
						return Math.abs((vertical ? rect.left : rect.top) - target);
					}),
				);
			await h.until(
				() => distance() <= 2,
				`Midpoint study margin must align with source text after ${mode}; distance=${distance()}`,
			);
		};
		const assertLayout = async (
			mode: "horizontal-tb" | "vertical-rl",
			label: string,
			checkMargins = true,
		) => {
			const geometry = frames().map((frame) => ({
				mode: frame.contentWindow?.getComputedStyle(
					frame.contentDocument?.body as HTMLElement,
				).writingMode,
				width: frame.offsetWidth,
				height: frame.offsetHeight,
			}));
			check(
				geometry.every((frame) => frame.mode === mode),
				`${label} must update every iframe writing mode: ${JSON.stringify(geometry)}`,
			);
			check(
				frames().every(
					(frame, index) =>
						frame === previous[index] &&
						frame.contentDocument === documents[index],
				),
				`${label} must retain all iframe and Document identities`,
			);
			check(
				visibleParagraphs().includes(200),
				`${label} must keep the midpoint original text visible; visible=${JSON.stringify(visibleParagraphs())}; geometry=${JSON.stringify(geometry)}; scroll=${viewport.scrollLeft},${viewport.scrollTop}`,
			);
			const position = saved.at(-1);
			check(
				position?.part_index === 1 &&
					Math.abs((position.offset ?? 0) - startAt(200)) <=
						(paragraphs[200]?.length ?? 0),
				`${label} must preserve the original text anchor: ${JSON.stringify(position)}`,
			);
			if (mode === "vertical-rl") {
				check(
					viewport.scrollHeight <= viewport.clientHeight + 1 &&
						viewport.scrollTop === 0,
					`Vertical reading must not retain horizontal-mode vertical overflow: ${viewport.scrollHeight}/${viewport.clientHeight}, scrollTop=${viewport.scrollTop}`,
				);
				check(
					geometry.every(
						(frame) =>
							frame.width > viewport.clientWidth &&
							frame.height <= viewport.clientHeight,
					),
					`Vertical frames must expand horizontally within the reading height: ${JSON.stringify(geometry)}`,
				);
			} else {
				check(
					geometry.every(
						(frame) =>
							frame.width <= viewport.clientWidth &&
							frame.height > viewport.clientHeight,
					) && Math.abs(viewport.scrollLeft) <= 1,
					`Horizontal frames must restore vertical scrolling and fit the reading width: ${JSON.stringify(geometry)}`,
				);
			}
			if (checkMargins) await assertMargins(mode);
		};
		const changes = initialVertical
			? ([
					["horizontal-tb", "横排"],
					["vertical-rl", "竖排"],
				] as const)
			: ([
					["vertical-rl", "竖排"],
					["horizontal-tb", "横排"],
				] as const);
		for (const [mode, label] of changes) {
			const control = [
				...h.container.querySelectorAll<HTMLButtonElement>(
					'[aria-label="文字方向"] button',
				),
			].find((button) => button.textContent === label);
			check(control, `Missing ${label} settings control`);
			const before = saved.length;
			control.click();
			await h.until(
				() =>
					saved.length > before &&
					saved.at(-1)?.settings?.writing_mode === mode,
				`${label} must finish layout and save its restored reading position`,
			);
			await assertLayout(mode, label);
			if (mode === "vertical-rl") {
				const font = h.container.querySelector<HTMLInputElement>(
					'input[aria-label="字号"]',
				);
				check(font, "Reading font-size control must exist");
				const beforeFont = saved.length;
				h.inputValue(font, "26");
				await h.until(
					() =>
						saved.length > beforeFont &&
						saved.at(-1)?.settings?.font_size === 26,
					"Font-size change must finish restoring its reading position",
				);
				await assertLayout(mode, "竖排调整字号");
				const beforeNarrow = saved.length;
				viewport.style.width = "80%";
				await h.until(
					() => saved.length > beforeNarrow,
					"Narrowing the viewport must restore and save the same reading position",
				);
				await assertLayout(mode, "竖排缩窄正文");
			}
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const reset = h.container.querySelector<HTMLButtonElement>(
				"button.reader-reset",
			);
			check(reset, "Real reset settings button must remain available");
			const beforeReset = saved.length;
			reset.click();
			await h.until(
				() =>
					saved.length > beforeReset &&
					saved.at(-1)?.settings?.font_size === 22 &&
					saved.at(-1)?.settings?.line_height === 2 &&
					saved.at(-1)?.settings?.writing_mode === "horizontal-tb",
				"Each real reset, including identical defaults, must complete restoration and save",
			);
			await assertLayout("horizontal-tb", `恢复默认 ${attempt + 1}`, false);
			const beforeResize = saved.length;
			viewport.style.width = attempt === 0 ? "75%" : "85%";
			await h.until(
				() => saved.length > beforeResize,
				"After reset the reader must resume sampling and persist the resized anchor",
			);
			await assertLayout(
				"horizontal-tb",
				`恢复默认后缩放 ${attempt + 1}`,
				false,
			);
		}
		check(
			saved.every(
				(position) =>
					position.part_index === 1 &&
					Math.abs((position.offset ?? 0) - startAt(200)) <=
						(paragraphs[200]?.length ?? 0),
			),
			`Restoration must never persist a temporary layout position: ${JSON.stringify(saved)}`,
		);
		return `reader layout switch (${initialVertical ? "vertical → horizontal → vertical" : "horizontal → vertical → horizontal"}): midpoint text, anchor, scroll axis, study margins, iframe and Document identities retained`;
	} finally {
		if (!preview) dispose();
	}
}
