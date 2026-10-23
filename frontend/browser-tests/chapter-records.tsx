import type { components } from "../src/api/schema";
import { projectPart } from "../src/materials/dom";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];
const timestamp = "2026-10-23T00:00:00Z";
const hash = "a".repeat(64);
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
			html_attributes: {},
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
			text: paragraphs[index] ?? "",
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
			translation_excerpt: result.translation,
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
			{ id: "chapter", title: chapter.title, level: 0, part_count: 1 },
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
			return Response.json(chapter);
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
		if (path === "/api/segments/saved/analyses") return Response.json([]);
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
				results: [
					...results.slice(0, generatedResult && !omitFromRecent ? 4 : 3),
					historical,
				].filter((result) => !identity || result.identity_sha256 === identity),
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
		const firstRowText = summaryButtons[0]?.textContent;
		summaryButtons[0]?.focus();
		summaryButtons[0]?.click();
		await h.until(
			() =>
				h.container
					.querySelector(".translation-output")
					?.textContent?.includes(first.translation) ?? false,
			"Chapter row must open its specified latest result",
		);
		await h.until(
			() =>
				document.activeElement?.textContent?.includes("返回翻译列表") ===
					true &&
				h.container
					.querySelector(".translation-card")
					?.contains(document.activeElement) === true,
			"Keyboard activation of a translation row must move focus into its details return control",
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		containedPanel();
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
		const backToList = button("← 返回翻译列表");
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
		const overlapLeaf = doc.querySelector('[data-locator-leaf="1"]');
		check(
			overlapLeaf?.firstChild,
			"Fixture needs overlapping segment and translation source",
		);
		const tapRange = doc.createRange();
		tapRange.setStart(overlapLeaf.firstChild, 1);
		tapRange.setEnd(overlapLeaf.firstChild, 2);
		const tapRect = tapRange.getBoundingClientRect();
		const tapOverlap = () => {
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
			() => h.container.querySelectorAll('[role="tab"]').length === 2,
			"One overlapping source tap must open a shared study/translation record entry",
		);
		button("学习片段").click();
		await h.until(
			() => h.container.textContent?.includes("保存的片段译文。") ?? false,
			"Shared entry must expose existing learning segment",
		);
		button("翻译").click();
		await h.until(
			() =>
				h.container
					.querySelector(".translation-output")
					?.textContent?.includes(first.translation) ?? false,
			"Shared entry translation tab must expose latest result",
		);
		button("关闭阅读记录").click();
		await h.until(
			() => !h.container.querySelector('[role="tab"]'),
			"Shared entry must close before selecting new source",
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
				() => acceptedTask && h.container.textContent?.includes("等待翻译…"),
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
		return `chapter records ${direction} ${params.get("theme") ?? "light"} ${innerWidth}px${detached ? " detached completion" : ""}${evicted ? " evicted from recent" : ""}: two-page completeness, source order, one identity row, exact latest/history, no generation, ruby projection, shared overlap tabs, disjoint solid/dashed marks, ${detached ? "background" : "immediate"} success refreshes source marks`;
	} finally {
		if (!preview) dispose();
	}
}
