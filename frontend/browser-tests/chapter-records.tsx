import type { components } from "../src/api/schema";
import { projectPart } from "../src/materials/dom";
import type { BrowserHarness } from "./harness";
import { inlinePerformance } from "./inline-performance";
import { inlineRecords } from "./inline-records";

type Schema = components["schemas"];
const timestamp = "2026-10-23T00:00:00Z";
const hash = "a".repeat(64);
const previewAnalyses: Schema["AnalysisDetail"][] = ["long", "short"].map(
	(kind) => ({
		id: `preview-${kind}`,
		segment_id: "saved",
		current_revision_id: `revision-${kind}`,
		revision_id: `revision-${kind}`,
		title: kind === "long" ? "完整长讲解" : "简短讲解",
		excerpt: "讲解回归",
		source_md:
			kind === "long"
				? `${Array.from({ length: 35 }, (_, index) => `第${index + 1}段讲解。这里说明句子结构与语境，完整阅读应能看到每一段。`).join("\n\n")}\n\n完整讲解终点。`
				: "短讲解正文。",
		sections: [],
		origin: "manual",
		normalizer_version: 1,
		parent_revision_id: null,
		run_id: null,
		warnings: [],
		created_at: timestamp,
		updated_at: kind === "long" ? "2026-10-24T00:00:00Z" : timestamp,
	}),
);

const paragraphs = [
	"春の風が静かな庭を通り抜ける。",
	"猫は縁側でゆっくりと目を開けた。",
	"遠くの空には淡い光が残っている。",
	"風が木の葉を揺らし、小さな音を立てた。",
];
const text = paragraphs.join("");
const reference = (index: number): Schema["MaterialProvenance"] => {
	const exact = paragraphs[index] ?? "";
	const start = paragraphs.slice(0, index).join("").length;
	return {
		contract_version: "1",
		material_id: "chapter-records",
		version_id: "v1",
		ranges: [
			{
				resource_id: "r",
				spine_index: 0,
				start,
				end: start + exact.length,
				exact,
				text_sha256: hash,
				prefix: "",
				suffix: "",
			},
		],
	};
};
const chapter: Schema["MaterialChapterResponse"] = {
	id: "chapter",
	material_id: "chapter-records",
	version_id: "v1",
	title: "本章记录回归",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
			href: "chapter.xhtml",
			css: "p{margin:0 0 1.8em}",
			html_attributes: { lang: "ja" },
			body_attributes: {},
		},
	],
	parts: [
		{
			resource_id: "r",
			spine_index: 0,
			start: 0,
			end: text.length,
			leaf_start: 0,
			leaf_end: 5,
			html: `<p><ruby><span data-locator-leaf="0">春</span><rt>はる</rt></ruby><span data-locator-leaf="1">${paragraphs[0]?.slice(1)}</span></p>${paragraphs
				.slice(1)
				.map(
					(value, i) =>
						`<p><span data-locator-leaf="${i + 2}">${value}</span></p>`,
				)
				.join("")}`,
		},
	],
};

/** Local silent implementation: browser regression and preview never speak. */
function silentSpeech() {
	const synthesis = new EventTarget();
	Object.assign(synthesis, {
		getVoices: () => [],
		cancel: () => {},
		speak: () => {},
	});
	Object.defineProperty(window, "speechSynthesis", {
		configurable: true,
		value: synthesis,
	});
}

export async function chapterRecords(h: BrowserHarness, preview = false) {
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search);
	const inlineSuite = params.get("suite") === "inline-records";
	const performanceSuite = inlineSuite && params.has("performance");
	const inlineParagraphs = inlineSuite
		? [
				...paragraphs,
				...Array.from(
					{ length: performanceSuite ? 400 : 20 },
					(_, index) => `追加第${index}段。春の風が静かな庭を通り抜ける。`,
				),
			]
		: paragraphs;
	const inlineText = inlineParagraphs.join("");
	let inlineChapter = inlineSuite
		? {
				...chapter,
				resources: chapter.resources.map((resource) => ({
					...resource,
					text: inlineText,
					css: "p{margin:0 0 10em}",
				})),
				parts: chapter.parts.map((part) => ({
					...part,
					end: inlineText.length,
					leaf_end: 25,
					html:
						part.html +
						inlineParagraphs
							.slice(4)
							.map(
								(value, index) =>
									`<p><span data-locator-leaf="${index + 5}">${value}</span></p>`,
							)
							.join(""),
				})),
			}
		: chapter;

	if (performanceSuite) {
		// Split one canonical resource into three real reading frames, with marks
		// in the first frame and unrelated ordinary paragraphs in later frames.
		let offset = 0;
		inlineChapter = {
			...inlineChapter,
			parts: [0, 140, 280].map((start, index) => {
				const values = inlineParagraphs.slice(
					start,
					index === 2 ? undefined : start + 140,
				);
				const length = values.join("").length;
				const part = {
					resource_id: "r",
					spine_index: 0,
					start: offset,
					end: offset + length,
					leaf_start: start + 1,
					leaf_end: start + values.length + 1,
					html: values
						.map(
							(value, paragraph) =>
								`<p><span data-locator-leaf="${start + paragraph + 1}">${value}</span></p>`,
						)
						.join(""),
				};
				offset += length;
				return part;
			}),
		};
	}

	const detached = params.has("detached");
	const evicted = params.has("evicted");
	const direction =
		params.get("direction") === "vertical-rl" ? "vertical-rl" : "horizontal-tb";
	localStorage.clear();
	localStorage.setItem(
		"folio-reader-ui-v1",
		JSON.stringify({
			focus: false,
			theme: params.get("theme") === "dark" ? "black" : "white",
		}),
	);
	silentSpeech();
	const [{ MaterialReader }, { targetIdentity }] = await Promise.all([
		import("../src/materials/MaterialReader"),
		import("../src/translation/state"),
	]);
	const references = paragraphs.map((_, index) => reference(index));
	if (inlineSuite) {
		const partial = references[1]?.ranges[0];
		const cross = references[2]?.ranges[0];
		if (partial) {
			partial.start += 3;
			partial.end -= 3;
			partial.exact = text.slice(partial.start, partial.end);
		}
		if (cross) {
			cross.end = text.length - 3;
			cross.exact = text.slice(cross.start, cross.end);
		}
	}
	const identities = await Promise.all(references.map(targetIdentity));
	const results: Schema["TranslationResultResponse"][] = references.map(
		(material_provenance, index) => ({
			id: `result-${index}`,
			task_id: `task-${index}`,
			source_id: "source",
			material_id: "chapter-records",
			material_deleted: false,
			material_provenance,
			identity_sha256: identities[index] ?? "",
			text: inlineSuite
				? (material_provenance.ranges[0]?.exact ?? "")
				: (paragraphs[index] ?? ""),
			translation:
				[
					"春风静静穿过庭院。",
					"猫在走廊上缓缓睁开眼睛。",
					"远处的天空还留着微光。",
					"风吹动树叶，发出细小的声音。",
				][index] ?? "",
			context_before: "",
			context_after: "",
			target_language: "简体中文",
			scheme_name: "默认翻译",
			model_id: "fixture",
			run_id: `run-${index}`,
			created_at: timestamp,
			adopted_segment_ids: [],
			chapter_id: "chapter",
			parts: [],
			scheme_id: "default",
			scheme_revision: 1,
			provider_name: "隔离回归",
			protocol: "chat_completions",
			prompt_version: "v1",
			temperature: null,
			reasoning_effort: null,
			max_output_tokens: 1000,
		}),
	);
	const first = results[0];
	check(first, "Fixture needs first translation");
	const historical = {
		...first,
		id: "result-historical",
		translation: "旧译：春天的风吹过安静的院子。",
		created_at: "2026-10-22T00:00:00Z",
	};
	const summaries: Schema["MaterialChapterTranslation"][] = results
		.slice(0, 3)
		.map((result, index) => ({
			identity_sha256: result.identity_sha256,
			result_id: result.id,
			material_provenance: result.material_provenance,
			excerpt: result.text,
			translation_excerpt: inlineSuite
				? `摘要${index}，不是完整内容。`
				: result.translation,
			result_count: index === 0 ? 2 : 1,
			target_language: result.target_language,
			created_at: result.created_at,
		}));
	const pages: string[] = [];
	const generated: string[] = [];
	let allowGeneration = false;
	let generatedResult = false;
	let acceptedTask = false;
	let pendingObserved = false;
	let hideFromRecent = false;
	let evictedTaskReads = 0;
	const finishTask = () => {
		if (generatedResult) return;
		generatedResult = true;
		const latest = results[3];
		check(latest, "Fixture requires a new successful translation");
		summaries.push({
			identity_sha256: latest.identity_sha256,
			result_id: latest.id,
			material_provenance: latest.material_provenance,
			excerpt: latest.text,
			translation_excerpt: latest.translation,
			result_count: 1,
			target_language: latest.target_language,
			created_at: latest.created_at,
		});
	};
	const segment: Schema["MaterialChapterSegment"] = {
		segment_id: "saved",
		excerpt: first.text,
		material_provenance: first.material_provenance,
		created_at: timestamp,
	};
	const settings: Schema["ReadingSettings"] = {
		font_size: 22,
		line_height: 2,
		writing_mode: direction,
	};
	const book: Schema["MaterialResponse"] = {
		id: "chapter-records",
		source_id: "source",
		title: "本章记录回归",
		version_id: "v1",
		contract_version: "1",
		product_sha256: hash,
		source_sha256: hash,
		created_at: timestamp,
		warnings: [],
		chapters: [
			{
				id: "chapter",
				title: chapter.title,
				level: 0,
				part_count: performanceSuite ? 3 : 1,
			},
			...(inlineSuite
				? [{ id: "chapter-two", title: "第二章", level: 0, part_count: 1 }]
				: []),
		],
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
			updated_at: timestamp,
			settings,
		},
	};
	const successfulTask: Schema["TranslationTaskResponse"] = {
		id: "task-3",
		source_id: "source",
		material_id: book.id,
		material_provenance: references[3] ?? reference(3),
		text: paragraphs[3] ?? "",
		context_before: "",
		context_after: "",
		created_at: timestamp,
		status: "succeeded",
		result_id: "result-3",
		run_id: "run-3",
		error: null,
	};
	const taskSnapshot = (): Schema["TranslationTaskResponse"] =>
		generatedResult
			? successfulTask
			: { ...successfulTask, status: "queued", result_id: null, run_id: null };
	h.mock(async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (
			request.method === "POST" &&
			path === "/api/materials/chapter-records/translations"
		) {
			generated.push(path);
			check(
				allowGeneration,
				"Browsing chapter records must never generate a translation",
			);
			const body: Schema["TranslationCreate"] = await request.json();
			const latest = results[3];
			check(
				latest &&
					body.text === latest.text &&
					(await targetIdentity(body.material_provenance)) ===
						latest.identity_sha256,
				"Explicit selection translation must preserve exact source",
			);
			acceptedTask = true;
			if (!detached) finishTask();
			return Response.json(taskSnapshot());
		}
		if (path === "/api/translation-tasks/task-3") {
			if (hideFromRecent) evictedTaskReads++;
			return Response.json(taskSnapshot());
		}
		if (path === "/api/materials/chapter-records" && request.method === "GET")
			return Response.json(book);
		if (path.endsWith("/opened") || path.endsWith("/usage"))
			return Response.json({
				material_id: book.id,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			} satisfies Schema["MaterialUsageResponse"]);
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "Source",
				description: "",
				note: "",
				segment_count: 1,
				created_at: timestamp,
				updated_at: timestamp,
			});
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "generation",
				token_count: 0,
			});
		if (path.endsWith("/readings"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "generation",
				resources: [],
			});
		if (path === "/api/materials/chapter-records/chapters/chapter")
			return Response.json(inlineChapter);
		if (
			inlineSuite &&
			path === "/api/materials/chapter-records/chapters/chapter-two"
		)
			return Response.json({
				...inlineChapter,
				id: "chapter-two",
				title: "第二章",
			});
		if (
			inlineSuite &&
			/\/chapters\/chapter-two\/(segments|translations)$/.test(path)
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/chapters/chapter/segments"))
			return Response.json({
				items: [segment],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/chapters/chapter/translations")) {
			check(
				url.searchParams.get("version_id") === "v1",
				"Chapter translations must bind immutable version",
			);
			const after = url.searchParams.get("after") ?? "";
			pages.push(after);
			check(after === "" || after === "page-two", `Unexpected cursor ${after}`);
			return Response.json({
				items: after ? summaries.slice(2) : summaries.slice(0, 2),
				next_cursor: after ? null : "page-two",
				unavailable_count: 0,
			});
		}
		if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			return Response.json({
				...update,
				progress: 0,
				revision: update.expected_revision + 1,
				updated_at: timestamp,
			});
		}
		if (path === "/api/segments/saved")
			return Response.json({
				id: "saved",
				source_id: "source",
				text: first.text,
				translation: "保存的片段译文。",
				transcription: "",
				context_before: "",
				context_after: "",
				note: "",
				source_ref: "",
				revision: 0,
				text_sha256: hash,
				text_locked_at: null,
				created_at: timestamp,
				updated_at: timestamp,
			});
		if (path === "/api/segments/saved/analyses")
			return Response.json(previewAnalyses);
		const previewAnalysis = previewAnalyses.find(
			(item) => path === `/api/analyses/${item.id}`,
		);
		if (previewAnalysis) return Response.json(previewAnalysis);
		if (path === "/api/settings/translation")
			return Response.json({
				id: "default",
				adapter: "llm",
				revision: 1,
				name: "默认翻译",
				model_id: "fixture",
				target_language: "简体中文",
				before_sentences: 3,
				after_sentences: 0,
				before_characters: 200,
				after_characters: 0,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (path === "/api/materials/chapter-records/translations") {
			const identity = url.searchParams.get("identity_sha256");
			if (!identity && acceptedTask && !generatedResult) pendingObserved = true;
			const omitFromRecent = !identity && hideFromRecent;
			return Response.json({
				results: (inlineSuite
					? []
					: [
							...results.slice(0, generatedResult && !omitFromRecent ? 4 : 3),
							historical,
						]
				).filter((result) => !identity || result.identity_sha256 === identity),
				tasks:
					acceptedTask &&
					!omitFromRecent &&
					(!identity || identity === identities[3])
						? [taskSnapshot()]
						: [],
				next_offset: null,
			});
		}
		const result = [...results, historical].find(
			(item) => path === `/api/translation-results/${item.id}`,
		);
		if (result) return Response.json(result);
		throw new Error(
			`Unmocked chapter record request ${request.method} ${path}`,
		);
	});
	const dispose = await h.mount(
		<MaterialReader />,
		"/materials/:id",
		"/materials/chapter-records",
	);
	const button = (label: string, scope: ParentNode = h.container) => {
		const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) =>
				(candidate.getAttribute("aria-label") ??
					candidate.textContent?.trim()) === label,
		);
		check(node && !node.disabled, `Missing enabled button ${label}`);
		return node;
	};
	try {
		await h.until(
			() =>
				pages.includes("page-two") &&
				!!h.container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector("[data-locator-leaf]"),
			"Reader and all chapter translation pages must load",
		);
		button("本章记录").click();
		await h.until(
			() => !!h.container.querySelector('[role="tab"]'),
			"Chapter records must expose study and translation tabs",
		);
		button("翻译").click();
		await h.until(
			() =>
				summaries.every((item) =>
					h.container.textContent?.includes(item.translation_excerpt),
				),
			"Both pages must populate chapter translations",
		);
		const containedPanel = () => {
			const panel = h.container.querySelector<HTMLElement>(
				".reader-chapter-records",
			);
			check(panel, "Shared chapter record panel must render");
			const bounds = panel.getBoundingClientRect();
			check(
				bounds.left >= -1 &&
					bounds.right <= innerWidth + 1 &&
					bounds.top >= -1 &&
					bounds.bottom <= innerHeight + 1 &&
					panel.scrollWidth <= panel.clientWidth + 1,
				`Record panel must fit ${innerWidth}×${innerHeight} viewport: ${JSON.stringify(bounds.toJSON())}`,
			);
		};
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		containedPanel();
		if (preview)
			return "chapter records preview: real MaterialReader, paginated exact references, local API and silent speech";
		const frame = h.container.querySelector<HTMLIFrameElement>(
			"iframe.material-part",
		);
		const doc = frame?.contentDocument;
		check(frame && doc, "Missing real reader frame");
		if (inlineSuite) {
			button("本章记录").click();
			await h.until(
				() => !h.container.querySelector('[role="tab"]'),
				"Record list must close before source test",
			);
			if (performanceSuite) return await inlinePerformance(h, results);
			return await inlineRecords(
				h,
				doc,
				inlineText,
				inlineParagraphs,
				results,
				direction,
			);
		}
		check(
			projectPart(doc, text, 0).raw === text,
			"Ruby and record marks must preserve exact raw source projection",
		);
		check(
			doc.querySelector("rt")?.textContent === "はる",
			"Original ruby must survive record marks",
		);
		const registry = (
			doc.defaultView as unknown as {
				CSS: { highlights: Map<string, Set<Range>> };
			}
		).CSS.highlights;
		const projection = projectPart(doc, text, 0);
		const intervals = (name: string) =>
			[...(registry.get(name) ?? [])].map((range) => {
				const first = projection.entries.find(
					(entry) => entry.node === range.startContainer,
				);
				const last = projection.entries.find(
					(entry) => entry.node === range.endContainer,
				);
				check(
					first && last,
					"Native marks must retain raw source text boundaries",
				);
				return {
					start: first.start + range.startOffset,
					end: last.start + range.endOffset,
				};
			});
		const solid = intervals("folio-study");
		const dashed = intervals("folio-translation");
		check(
			solid.length > 0 && dashed.length > 0,
			"Study and translation marks must both render native CSS ranges",
		);
		for (const study of solid)
			for (const translated of dashed)
				check(
					study.start >= translated.end || translated.start >= study.end,
					"Overlapping study and translation source must never draw two underlines",
				);
		const markStyle =
			doc.getElementById("folio-study-style")?.textContent ?? "";
		const verticalLines =
			doc.querySelector<SVGSVGElement>("#folio-study-lines");
		if (direction === "vertical-rl") {
			check(
				verticalLines?.getAttribute("aria-hidden") === "true",
				"Japanese vertical marks must have a decorative line layer",
			);
			check(
				doc.defaultView?.getComputedStyle(verticalLines).pointerEvents ===
					"none",
				"Vertical lines must preserve native selection and taps",
			);
			const paths = [...verticalLines.querySelectorAll("path")];
			check(
				paths.some((path) => !path.hasAttribute("stroke-dasharray")) &&
					paths.some((path) => path.getAttribute("stroke-dasharray") === "3 3"),
				"Vertical saved segments and translations must both have visible line paths",
			);
			check(
				paths.every((path) => path.getBBox().height > 0),
				"Vertical lines must follow nonempty source columns",
			);
		} else
			check(
				!verticalLines,
				"Horizontal records must use native underlines without an overlay",
			);
		check(
			/::highlight\(folio-study\)\{[^}]*text-decoration-style:solid/.test(
				markStyle,
			),
			"Learning segment marks must use solid underlines",
		);
		check(
			/::highlight\(folio-translation\)\{[^}]*text-decoration-style:dashed/.test(
				markStyle,
			),
			"Translation marks must use dashed underlines",
		);
		const solidColor =
			/::highlight\(folio-study\)\{[^}]*text-decoration-color:(#[\da-f]{6})/i.exec(
				markStyle,
			)?.[1];
		const translationColor =
			/::highlight\(folio-translation\)\{[^}]*text-decoration-color:(#[\da-f]{8})/i.exec(
				markStyle,
			)?.[1];
		check(
			solidColor &&
				translationColor?.startsWith(solidColor) &&
				Number.parseInt(translationColor.slice(-2), 16) < 255,
			"Translation dash must share the segment red with lower emphasis in each theme",
		);
		const tabs = [...h.container.querySelectorAll('[role="tab"]')].map(
			(node) => node.getAttribute("aria-label") ?? node.textContent?.trim(),
		);
		check(
			tabs.includes("学习片段") && tabs.includes("翻译"),
			"Chapter panel must retain both record kinds",
		);
		const summaryButtons = [
			...h.container.querySelectorAll<HTMLButtonElement>("button"),
		].filter((node) =>
			summaries.some((item) =>
				node.textContent?.includes(item.translation_excerpt),
			),
		);
		check(
			summaryButtons.length === 3,
			"Same exact source history must occupy one chapter list row",
		);
		check(
			summaryButtons.every((node, index) =>
				node.textContent?.includes(
					summaries[index]?.translation_excerpt ?? "MISSING",
				),
			),
			"Chapter translations must follow source order across pagination",
		);
		check(
			summaryButtons.every(
				(node, index) =>
					node.children.length === 2 &&
					node.textContent ===
						`${summaries[index]?.excerpt}${summaries[index]?.translation_excerpt}`,
			),
			"Translation list rows must contain only original and latest translation",
		);
		button("学习片段").click();
		await h.until(
			() =>
				!!h.container.querySelector(
					".reader-study-preview-candidates button time",
				),
			"Learning segment list must load its saved date",
		);
		const candidate = h.container.querySelector<HTMLButtonElement>(
			".reader-study-preview-candidates button",
		);
		check(candidate, "Chapter list needs the saved learning segment");
		const savedDate = candidate.querySelector("time");
		check(
			candidate.children.length === 2 &&
				!candidate.textContent?.includes("saved") &&
				!h.container
					.querySelector(".reader-study-preview-list")
					?.textContent?.includes("选择"),
			"Learning list must omit selection instructions and segment ID suffixes",
		);
		check(
			savedDate?.textContent ===
				new Date(timestamp).toLocaleString(undefined, {
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				}),
			"Learning list date must include year, month, day, hour and minute",
		);
		candidate.click();
		const markdown = () =>
			h.container.querySelector<HTMLElement>(".reader-study-preview-markdown");
		await h.until(
			() => markdown()?.textContent?.includes("完整讲解终点。") === true,
			"Chapter learning segment must load the complete explanation",
		);
		check(
			h.container.querySelector(".reader-study-preview-analysis-heading h3")
				?.textContent === "讲解" &&
				!markdown()?.hasAttribute("data-clipped") &&
				getComputedStyle(markdown() as HTMLElement).maskImage === "none" &&
				getComputedStyle(markdown() as HTMLElement).maxHeight === "none",
			"Chapter explanation must display in full without a preview heading or fade",
		);
		const chapterBody = h.container.querySelector<HTMLElement>(
			".reader-record-body",
		);
		const chapterEnding = markdown()?.querySelector(
			".analysis-markdown:last-child > :last-child",
		);
		check(
			chapterBody &&
				chapterEnding &&
				chapterBody.scrollHeight > chapterBody.clientHeight,
			"Chapter learning segment needs a scrollable body for its full explanation",
		);
		chapterBody.scrollTop = chapterBody.scrollHeight;
		await h.until(() => {
			const ending = chapterEnding.getBoundingClientRect();
			const body = chapterBody.getBoundingClientRect();
			return ending.top >= body.top && ending.bottom <= body.bottom + 1;
		}, "Chapter explanation ending must be visible after scrolling to the bottom");
		chapterBody.scrollTop = 0;
		const open = h.container.querySelector<HTMLElement>(
			".reader-study-preview-open",
		);
		const originalBounds = h.container
			.querySelector(".reader-study-preview-original")
			?.getBoundingClientRect();
		const tabsBounds = h.container
			.querySelector(".reader-record-tabs")
			?.getBoundingClientRect();
		check(
			open && originalBounds && tabsBounds,
			"Selected learning segment needs its open action, source and tabs",
		);
		const openBounds = open.getBoundingClientRect();
		const compactBounds = h.container
			.querySelector(".reader-chapter-records")
			?.getBoundingClientRect();
		check(
			compactBounds &&
				openBounds.top >= tabsBounds.bottom - 1 &&
				openBounds.bottom <= originalBounds.top + 1 &&
				openBounds.right > (compactBounds.left + compactBounds.right) / 2,
			"Open segment action must sit on the right below tabs and before original source",
		);
		const picker = h.container.querySelector<HTMLSelectElement>(
			".reader-study-preview-analysis select",
		);
		check(picker, "Long and short explanations must be selectable");
		picker.value = "preview-short";
		picker.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() =>
				markdown()?.textContent?.includes("短讲解正文。") === true &&
				!markdown()?.hasAttribute("data-clipped"),
			"Chapter explanation switch must retain full display",
		);
		check(
			getComputedStyle(markdown() as HTMLElement).maskImage === "none" &&
				(markdown()?.scrollHeight ?? 0) <= (markdown()?.clientHeight ?? 0) + 1,
			"Short explanation must fit completely without fading",
		);
		picker.value = "preview-long";
		picker.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() =>
				markdown()?.textContent?.includes("完整讲解终点。") === true &&
				!markdown()?.hasAttribute("data-clipped"),
			"Switching back must retain the complete chapter explanation",
		);
		check(
			!h.container.querySelector(
				".reader-chapter-records > header .reader-study-preview-actions [aria-expanded]",
			),
			"Chapter record header must omit expand and collapse actions",
		);
		button("关闭阅读记录").click();
		await h.until(
			() => !h.container.querySelector(".reader-chapter-records"),
			"Chapter list must close before testing contextual preview expansion",
		);
		const overlapLeaf = doc.querySelector('[data-locator-leaf="1"]');
		check(
			overlapLeaf?.firstChild,
			"Fixture needs overlapping segment and translation source",
		);
		const tapRange = doc.createRange();
		tapRange.setStart(overlapLeaf.firstChild, 1);
		tapRange.setEnd(overlapLeaf.firstChild, 2);
		const tapOverlap = () => {
			const tapRect = tapRange.getBoundingClientRect();
			for (const type of ["pointerdown", "pointerup"])
				overlapLeaf.dispatchEvent(
					new PointerEvent(type, {
						bubbles: true,
						cancelable: true,
						pointerId: 1,
						isPrimary: true,
						pointerType: "mouse",
						button: 0,
						clientX: tapRect.left + tapRect.width / 2,
						clientY: tapRect.top + tapRect.height / 2,
					}),
				);
		};
		tapOverlap();
		await h.until(
			() =>
				h.container.querySelector(".reader-record-title strong")
					?.textContent === "此处记录" &&
				markdown()?.dataset.clipped === "true",
			"Contextual record must open the long explanation preview",
		);
		const dragHeader = h.container.querySelector<HTMLElement>(
			".reader-chapter-records > header",
		);
		if (innerWidth > 600) {
			check(dragHeader, "Wide preview needs its movable header");
			dragHeader.focus();
			dragHeader.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowLeft",
					bubbles: true,
					cancelable: true,
				}),
			);
			await h.until(
				() =>
					h.container.querySelector<HTMLElement>(".reader-chapter-records")
						?.dataset.readerCardManual === "true",
				"Keyboard movement must set a manual preview position",
			);
		}
		const manualPosition = h.container.querySelector<HTMLElement>(
			".reader-chapter-records",
		)?.style.left;
		button("展开").click();
		await h.until(
			() => !!h.container.querySelector(".reader-chapter-records.expanded"),
			"Preview must expand for full explanation reading",
		);
		await h.until(
			() => getComputedStyle(markdown() as HTMLElement).maxHeight === "none",
			"Expanded explanation must remove the compact height limit",
		);
		const expandedPanel = h.container.querySelector<HTMLElement>(
			".reader-chapter-records.expanded",
		);
		check(
			expandedPanel &&
				expandedPanel.getBoundingClientRect().height > innerHeight * 0.6 &&
				expandedPanel.getBoundingClientRect().height > 520,
			"Expanded sidebar must use available viewport height beyond former 520px and 60% caps",
		);
		const body = h.container.querySelector<HTMLElement>(".reader-record-body");
		check(
			body && body.scrollHeight > body.clientHeight,
			"Long explanation must produce a scrollable full-reading body",
		);
		body.scrollTop = body.scrollHeight;
		await h.until(
			() => body.scrollTop > 0,
			"Full explanation must scroll to its end",
		);
		const lastParagraph = markdown()?.querySelector(
			".analysis-markdown:last-child > :last-child",
		);
		check(
			lastParagraph?.textContent === "完整讲解终点。",
			"Expanded reading must retain the complete explanation ending",
		);
		const endingBounds = lastParagraph.getBoundingClientRect();
		const bodyBounds = body.getBoundingClientRect();
		check(
			endingBounds.top >= bodyBounds.top &&
				endingBounds.bottom <= bodyBounds.bottom + 1,
			"Explanation ending must be visible when scrolled to the bottom",
		);
		button("收起").click();
		await h.until(
			() =>
				!h.container.querySelector(".reader-chapter-records.expanded") &&
				markdown()?.dataset.clipped === "true",
			"Return must restore the compact explanation preview",
		);
		check(
			h.container.querySelector<HTMLSelectElement>(
				".reader-study-preview-analysis select",
			)?.value === "preview-long" &&
				h.container
					.querySelector('[role="tab"][aria-label="学习片段"]')
					?.getAttribute("aria-selected") === "true" &&
				(h.container
					.querySelector(".reader-study-preview-original")
					?.textContent?.includes(first.text) ??
					false) &&
				(innerWidth <= 600 ||
					h.container.querySelector<HTMLElement>(".reader-chapter-records")
						?.style.left === manualPosition),
			"Return must preserve selected segment, explanation, tab and manual position",
		);
		button("关闭阅读记录").click();
		await h.until(
			() => !h.container.querySelector(".reader-chapter-records"),
			"Close icon must dismiss the preview",
		);
		button("本章记录").click();
		await h.until(
			() => !!h.container.querySelector('[role="tab"]'),
			"Chapter records must reopen after close",
		);
		button("翻译").click();
		await h.until(
			() => !!h.container.querySelector(".reader-record-translation"),
			"Translation rows must return after preview checks",
		);
		const firstRowText = summaryButtons[0]?.textContent;
		const firstSummary = h.container.querySelector<HTMLButtonElement>(
			".reader-record-translation",
		);
		firstSummary?.focus();
		firstSummary?.click();
		await h.until(
			() =>
				h.container
					.querySelector(".translation-output")
					?.textContent?.includes(first.translation) ?? false,
			"Chapter row must open its specified latest result",
		);
		await h.until(
			() =>
				document.activeElement?.getAttribute("aria-label") === "返回翻译列表" &&
				h.container
					.querySelector(".reader-chapter-records > header")
					?.contains(document.activeElement) === true,
			"Keyboard activation of a translation row must focus its outer-header return control",
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		containedPanel();
		const backBounds = button("返回翻译列表").getBoundingClientRect();
		const heading = h.container.querySelector<HTMLElement>(
			".reader-chapter-records > header strong",
		);
		check(
			heading,
			"Record header must retain its title next to the return arrow",
		);
		const headingBounds = heading.getBoundingClientRect();
		check(
			Math.abs(
				(backBounds.top + backBounds.bottom) / 2 -
					(headingBounds.top + headingBounds.bottom) / 2,
			) <= 3,
			"Outer-header return arrow and record title must share one visual row",
		);
		check(
			!h.container.querySelector(".translation-card.embedded > header"),
			"Embedded translation details must share the record header without an extra toolbar",
		);
		const original = h.container.querySelector(".translation-original");
		check(
			original?.querySelector('[aria-label="朗读原文"][title="朗读原文"]'),
			"Original source must host its accessible speech icon",
		);
		document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		await h.until(
			() =>
				document.activeElement?.matches(".reader-record-translation") ===
					true && document.activeElement.textContent === firstRowText,
			"Escape from listed translation details must return and restore row focus",
		);
		(document.activeElement as HTMLButtonElement).click();
		await h.until(
			() =>
				document.activeElement?.getAttribute("aria-label") === "返回翻译列表",
			"Reopening the focused row must restore detail-header focus",
		);
		const history = [...h.container.querySelectorAll("details")].find((node) =>
			node.querySelector("summary")?.textContent?.includes("历史翻译"),
		);
		if (history) history.open = true;
		await h.until(
			() =>
				[
					...h.container.querySelectorAll<HTMLButtonElement>(
						".translation-history-item",
					),
				].some((node) => node.textContent?.includes(historical.translation)),
			"Exact-source history must remain reachable",
		);
		const historicalButton = [
			...h.container.querySelectorAll<HTMLButtonElement>(
				".translation-history-item",
			),
		].find((node) => node.textContent?.includes(historical.translation));
		check(
			historicalButton && !historicalButton.querySelector('[lang="ja"]'),
			"Exact-source history rows must omit the original already shown in details",
		);
		historicalButton?.click();
		await h.until(
			() =>
				h.container
					.querySelector(".translation-output")
					?.textContent?.includes(historical.translation) ?? false,
			"History click must open the exact selected result",
		);
		check(
			generated.length === 0,
			"Reading latest or historical records must never generate",
		);
		const backToList = button("返回翻译列表");
		backToList.focus();
		backToList.click();
		await h.until(
			() =>
				document.activeElement?.matches(".reader-record-translation") ===
					true && document.activeElement.textContent === firstRowText,
			"Returning from translation details must restore focus to the original list row",
		);
		button("本章记录").click();
		await h.until(
			() => !h.container.querySelector('[role="tab"]'),
			"Chapter record panel must close before selecting fresh source",
		);

		tapOverlap();
		await h.until(
			() => h.container.querySelectorAll('[role="tab"]').length === 2,
			"One overlapping source tap must open a shared study/translation record entry",
		);
		button("学习片段").click();
		await h.until(
			() => h.container.textContent?.includes("保存的片段译文。") ?? false,
			"Shared entry must expose existing learning segment",
		);
		button("学习片段").focus();
		button("学习片段").dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "End",
				bubbles: true,
				cancelable: true,
			}),
		);
		await h.until(
			() =>
				h.container
					.querySelector(".translation-output")
					?.textContent?.includes(first.translation) ?? false,
			"Shared entry translation tab must expose latest result",
		);
		check(
			!h.container.querySelector('[aria-label="返回翻译列表"]'),
			"A single direct source translation must not offer a return to a list",
		);
		check(
			document.activeElement === button("翻译"),
			"End key on the segment tab must select and focus the translation tab",
		);
		h.container.querySelector(".translation-card.embedded")?.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		await h.until(
			() => !h.container.querySelector('[role="tab"]'),
			"Escape from single direct details must close the record entry",
		);
		const freshLeaf = doc.querySelector('[data-locator-leaf="4"]');
		check(freshLeaf, "Fixture needs unrecorded source paragraph");
		const selection = doc.getSelection();
		check(selection, "Reader frame needs native selection");
		const range = doc.createRange();
		range.selectNodeContents(freshLeaf);
		selection.removeAllRanges();
		selection.addRange(range);
		doc.dispatchEvent(new Event("selectionchange"));
		await h.until(
			() => !!h.container.querySelector('[aria-label="选区操作"]'),
			"Native selection must offer translation toolbar",
		);
		let pageRequestsBefore = pages.length;
		allowGeneration = true;
		const toolbar = h.container.querySelector('[aria-label="选区操作"]');
		check(toolbar, "Selection toolbar missing");
		button("翻译", toolbar).click();
		if (detached) {
			await h.until(
				() =>
					acceptedTask &&
					h.container
						.querySelector(
							".translation-card:not(.embedded) .translation-progress",
						)
						?.textContent?.trim() === "等待翻译",
				"Explicit selection must create a queued translation before leaving its target",
			);
			button("关闭翻译（任务继续）").click();
			const nextLeaf = doc.querySelector('[data-locator-leaf="2"]');
			check(nextLeaf, "Fixture needs another already translated target");
			range.selectNodeContents(nextLeaf);
			selection.removeAllRanges();
			selection.addRange(range);
			doc.dispatchEvent(new Event("selectionchange"));
			await h.until(
				() => !!h.container.querySelector('[aria-label="选区操作"]'),
				"Another exact source must offer translation after closing queued card",
			);
			const nextToolbar = h.container.querySelector('[aria-label="选区操作"]');
			check(nextToolbar, "Next target toolbar missing");
			button("翻译", nextToolbar).click();
			await h.until(
				() =>
					h.container
						.querySelector(".translation-output")
						?.textContent?.includes(results[1]?.translation ?? "MISSING") ??
					false,
				"Switching selection must remount card for existing second target without generation",
			);
			button("关闭翻译（任务继续）").click();
			if (evicted) {
				await h.until(
					() => pendingObserved,
					"Reader activity must first observe queued task before recent-window eviction",
				);
				hideFromRecent = true;
			}
			pageRequestsBefore = pages.length;
			finishTask();
		}
		await h.until(
			() => generatedResult && pages.length > pageRequestsBefore,
			detached
				? "Background success after leaving original target must refresh chapter record query"
				: "Successful new translation must refresh chapter record query",
		);
		await h.until(
			() =>
				intervals("folio-translation").some(
					(interval) => interval.end === text.length,
				),
			"New successful translation must gain a source underline without reopening reader",
		);
		check(
			Number(generated.length) === 1,
			"Only explicit selection action may generate once",
		);
		if (evicted)
			check(
				evictedTaskReads > 0,
				"Reader must recover evicted pending task through its task detail before refreshing marks",
			);
		const generationsBeforeSharedEdit = generated.length;
		const sharedLeaf = doc.querySelector('[data-locator-leaf="2"]');
		const sharedSelection = doc.getSelection();
		check(
			sharedLeaf && sharedSelection,
			"Fixture needs an already translated selectable paragraph",
		);
		const sharedRange = doc.createRange();
		sharedRange.selectNodeContents(sharedLeaf);
		const selectSharedTarget = async () => {
			sharedSelection.removeAllRanges();
			sharedSelection.addRange(sharedRange);
			doc.dispatchEvent(new Event("selectionchange"));
			await h.until(
				() => !!h.container.querySelector('[aria-label="选区操作"]'),
				"Existing source selection must expose translation action",
			);
			const actions = h.container.querySelector('[aria-label="选区操作"]');
			check(actions, "Existing source actions must render");
			button("翻译", actions).click();
			await h.until(
				() =>
					h.container.querySelector(".translation-output")?.textContent ===
					results[1]?.translation,
				"Existing source selection must show its saved translation",
			);
		};
		await selectSharedTarget();
		const floatingEditor = h.container.querySelector<HTMLTextAreaElement>(
			".translation-card textarea",
		);
		check(floatingEditor, "Original selection card must expose context editor");
		button("关闭翻译（任务继续）").click();
		button("本章记录").click();
		await h.until(
			() => !!h.container.querySelector('[role="tab"]'),
			"Chapter records must reopen",
		);
		button("翻译").click();
		const sharedRow = [
			...h.container.querySelectorAll<HTMLButtonElement>(
				".reader-record-translation",
			),
		].find((node) =>
			node.textContent?.includes(results[1]?.translation ?? "MISSING"),
		);
		check(sharedRow, "Chapter records must expose the same selected source");
		sharedRow.click();
		await h.until(
			() =>
				!!h.container.querySelector(
					".reader-chapter-records .translation-card textarea",
				),
			"Chapter record details must mount its own context editor",
		);
		const embeddedEditor = h.container.querySelector<HTMLTextAreaElement>(
			".reader-chapter-records .translation-card textarea",
		);
		check(
			embeddedEditor && embeddedEditor !== floatingEditor,
			"Record details must use a second real translation host",
		);
		h.inputValue(embeddedEditor, "真实阅读器共享语境");
		await h.until(
			() => embeddedEditor.value === "真实阅读器共享语境",
			"Embedded context edit must render",
		);
		button("返回翻译列表").click();
		button("本章记录").click();
		await h.until(
			() => !h.container.querySelector('[role="tab"]'),
			"Record details must close before returning to selection",
		);
		await selectSharedTarget();
		const reopenedEditor = h.container.querySelector<HTMLTextAreaElement>(
			".translation-card textarea",
		);
		check(
			reopenedEditor === floatingEditor,
			"Reader must retain the original floating translation host",
		);
		check(
			reopenedEditor?.value === "真实阅读器共享语境",
			`Reader selection must restore context edited through chapter records; saw ${JSON.stringify(reopenedEditor?.value)}`,
		);
		check(
			generated.length === generationsBeforeSharedEdit,
			"Reopening the same translated source must never generate",
		);
		button("关闭翻译（任务继续）").click();
		sharedSelection.removeAllRanges();
		doc.dispatchEvent(new Event("selectionchange"));
		await h.until(
			() => !h.container.querySelector('[aria-label="选区操作"]'),
			"Clearing the regression selection must restore native record tapping",
		);
		if (!inlineSuite) {
			button("阅读设置").click();
			await h.until(
				() =>
					!!h.container.querySelector('fieldset[aria-label="文字方向"] button'),
				"Reader settings must finish opening",
			);
			const writing = h.container.querySelector<HTMLFieldSetElement>(
				'fieldset[aria-label="文字方向"]',
			);
			check(writing, "Reader settings must expose writing direction");
			for (const mode of [
				"horizontal-tb",
				"vertical-rl",
				"horizontal-tb",
				direction,
			]) {
				button(mode === "horizontal-tb" ? "横排" : "竖排", writing).click();
				await h.until(
					() =>
						doc.defaultView?.getComputedStyle(doc.body).writingMode === mode &&
						Boolean(doc.querySelector("#folio-study-lines path")) ===
							(mode === "vertical-rl"),
					"Direction changes must repaint existing saved records",
				);
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				check(
					projectPart(doc, text, 0).raw === text &&
						doc.documentElement.lang === "ja",
					"Direction changes must preserve exact Japanese source",
				);
				const layer = doc.querySelector<SVGSVGElement>("#folio-study-lines");
				if (layer) {
					const extent = [
						doc.body.scrollWidth,
						doc.body.scrollHeight,
						doc.documentElement.scrollWidth,
						doc.documentElement.scrollHeight,
					];
					layer.style.display = "none";
					check(
						JSON.stringify(extent) ===
							JSON.stringify([
								doc.body.scrollWidth,
								doc.body.scrollHeight,
								doc.documentElement.scrollWidth,
								doc.documentElement.scrollHeight,
							]),
						"Vertical line painting must not change document scroll extent",
					);
					layer.style.removeProperty("display");
					const viewport =
						h.container.querySelector<HTMLElement>(".reader-viewport");
					check(viewport, "Vertical reader must retain its scroll viewport");
					viewport.scrollTop = 100;
					doc.defaultView?.scrollTo(0, 100);
					check(
						viewport.scrollTop === 0 &&
							(doc.scrollingElement?.scrollTop ?? 0) === 0,
						"Vertical record lines must not introduce upward or downward scrolling",
					);
				}
			}
		}
		return `chapter records ${direction} ${params.get("theme") ?? "light"} ${innerWidth}px${detached ? " detached completion" : ""}${evicted ? " evicted from recent" : ""}: chapter header without expand/collapse, clean record rows, minute dates, right-side segment action, measured long/short clipping, full-height reading reaches ending, return preserves segment/analysis/tab/manual position, close icon, selection→chapter record→selection shares edited context with floating host kept mounted, two-page completeness, source order, one identity row, exact latest/history, no generation, ruby projection, shared overlap tabs, disjoint solid/dashed marks, ${detached ? "background" : "immediate"} success refreshes source marks`;
	} finally {
		if (!preview) dispose();
	}
}
