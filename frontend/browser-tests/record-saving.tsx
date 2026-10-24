import type { components } from "../src/api/schema";
import { projectPart } from "../src/materials/dom";
import { captureNativeSelection } from "../src/materials/reader-selection";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];
const stamp = "2026-10-24T00:00:00Z";
const hash = "a".repeat(64);
const original = "\u2003猫 が歩く。\u00a0";
const paragraphs = [original, original, "猫が歩く。", "猫 が歩く！"];
const text = paragraphs.join("");
const fullTranslation = `${"完整译文超过摘要限制。".repeat(24)}最后一句必须保留。`;
const reference = (
	index: number,
	trim = false,
): Schema["MaterialProvenance"] => {
	const exact = paragraphs[index] ?? "";
	const start = paragraphs.slice(0, index).join("").length;
	return {
		contract_version: "1",
		material_id: "record-saving",
		version_id: "v1",
		ranges: [
			{
				resource_id: "r",
				spine_index: 0,
				start: start + (trim ? 1 : 0),
				end: start + exact.length - (trim ? 1 : 0),
				exact: trim ? exact.trim() : exact,
				text_sha256: hash,
				prefix: "",
				suffix: "",
			},
		],
	};
};

/** Real reader, iframe selection and local HTTP fixtures; no model or database. */
export async function recordSaving(h: BrowserHarness, preview = false) {
	const check: BrowserHarness["check"] = h.check;
	const sameSelection = (
		actual: Schema["MaterialProvenance"] | null | undefined,
		index: number,
	) => {
		const expected = reference(index);
		return (
			actual?.contract_version === expected.contract_version &&
			actual.material_id === expected.material_id &&
			actual.version_id === expected.version_id &&
			actual.ranges.length === expected.ranges.length &&
			actual.ranges.every((range, position) => {
				const wanted = expected.ranges[position];
				return (
					wanted &&
					range.resource_id === wanted.resource_id &&
					range.spine_index === wanted.spine_index &&
					range.start === wanted.start &&
					range.end === wanted.end &&
					range.exact === wanted.exact &&
					range.text_sha256 === wanted.text_sha256
				);
			})
		);
	};
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const { targetIdentity } = await import("../src/translation/state");
	const params = new URLSearchParams(location.search);
	const direction =
		params.get("direction") === "vertical-rl" ? "vertical-rl" : "horizontal-tb";
	const chapter: Schema["MaterialChapterResponse"] = {
		id: "chapter",
		material_id: "record-saving",
		version_id: "v1",
		title: "正文划选保存回归",
		level: 0,
		resources: [
			{
				id: "r",
				text,
				text_sha256: hash,
				href: "chapter.xhtml",
				css: "p{margin:0 0 1.5em;white-space:pre-wrap}",
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
				leaf_end: paragraphs.length,
				html: paragraphs
					.map(
						(value, index) =>
							`<p><span data-locator-leaf="${index}">${value}</span></p>`,
					)
					.join(""),
			},
		],
	};
	const book: Schema["MaterialResponse"] = {
		id: "record-saving",
		source_id: "source",
		title: chapter.title,
		version_id: "v1",
		contract_version: "1",
		product_sha256: hash,
		source_sha256: hash,
		created_at: stamp,
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
			updated_at: stamp,
			settings: { font_size: 22, line_height: 2, writing_mode: direction },
		},
	};
	const result = async (
		trim: boolean,
	): Promise<Schema["TranslationResultResponse"]> => ({
		id: "latest",
		task_id: "task",
		source_id: "source",
		material_id: book.id,
		material_deleted: false,
		material_provenance: reference(0, trim),
		identity_sha256: await targetIdentity(reference(0, trim)),
		text: trim ? original.trim() : original,
		translation: fullTranslation,
		context_before: "",
		context_after: "",
		target_language: "简体中文",
		scheme_name: "离线回归",
		model_id: "fixture",
		run_id: "run",
		created_at: stamp,
		adopted_segment_ids: [],
		chapter_id: "chapter",
		parts: [],
		scheme_id: "default",
		scheme_revision: 1,
		provider_name: "离线回归",
		protocol: "chat_completions",
		prompt_version: "v1",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: 1000,
	});
	const scenarios = preview
		? ["latest"]
		: [
				"latest",
				"edge",
				"other-place",
				"internal-space",
				"punctuation",
				"edit",
				"clear",
				"frozen",
				"history",
				"chapter-history-failure",
				"existing",
			];
	const completed: string[] = [];
	for (const scenario of scenarios) {
		localStorage.clear();
		localStorage.setItem(
			"folio-reader-ui-v1",
			JSON.stringify({
				focus: false,
				theme: params.get("theme") === "dark" ? "black" : "white",
			}),
		);
		const latest = await result(scenario === "edge");
		const historical = {
			...latest,
			id: "historical",
			translation: "手选历史译文应优先。",
			created_at: "2026-10-23T00:00:00Z",
		};
		const existing: Schema["SegmentResponse"] = {
			id: "existing",
			source_id: "source",
			text: original,
			translation: "已有译文保持不变。",
			transcription: "",
			context_before: "已有前文",
			context_after: "已有后文",
			note: "",
			source_ref: "",
			revision: 1,
			text_sha256: hash,
			text_locked_at: stamp,
			created_at: stamp,
			updated_at: stamp,
		};
		let releaseDetail: (() => void) | undefined;
		let releaseSave: (() => void) | undefined;
		let selectedExisting = false;
		let generated = 0;
		const submitted: Schema["SegmentCreate"][] = [];
		const delayed = ["edit", "clear", "frozen"].includes(scenario);
		h.mock(async (request) => {
			const url = new URL(request.url),
				path = url.pathname;
			if (path === `/api/materials/${book.id}` && request.method === "GET")
				return Response.json(book);
			if (path.endsWith("/opened") || path.endsWith("/usage"))
				return Response.json({
					material_id: book.id,
					status: "in_progress",
					revision: 1,
					last_opened_at: stamp,
					updated_at: stamp,
				});
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
			if (path.endsWith("/chapters/chapter")) return Response.json(chapter);
			if (path.endsWith("/chapters/chapter/segments"))
				return Response.json({
					items: [],
					next_cursor: null,
					unavailable_count: 0,
				});
			if (path.endsWith("/chapters/chapter/translations")) {
				if (scenario === "chapter-history-failure")
					return Response.json({ detail: "离线列表失败" }, { status: 503 });
				return Response.json({
					items: [
						{
							identity_sha256: latest.identity_sha256,
							result_id: latest.id,
							material_provenance: latest.material_provenance,
							excerpt: latest.text,
							translation_excerpt: fullTranslation.slice(0, 160),
							result_count: 2,
							target_language: latest.target_language,
							created_at: stamp,
						},
					],
					next_cursor: null,
					unavailable_count: 0,
				});
			}
			if (path.endsWith("/reading-position") && request.method === "PUT") {
				const update: Schema["ReadingPositionUpdate"] = await request.json();
				return Response.json({
					...update,
					progress: 0,
					revision: update.expected_revision + 1,
					updated_at: stamp,
				});
			}
			if (path === "/api/settings/segment-context")
				return Response.json({
					enabled: true,
					revision: 0,
					before_sentences: 0,
					after_sentences: 0,
					before_characters: 0,
					after_characters: 0,
				});
			if (path === "/api/settings/translation")
				return Response.json({
					id: "default",
					adapter: "llm",
					revision: 1,
					name: "离线回归",
					model_id: "fixture",
					target_language: "简体中文",
					before_sentences: 0,
					after_sentences: 0,
					before_characters: 0,
					after_characters: 0,
					max_context_characters: 2000,
					max_target_characters: 2000,
				});
			if (path === `/api/materials/${book.id}/translations`) {
				if (request.method === "POST") {
					generated++;
					throw new Error("Existing translations must not generate");
				}
				return Response.json({
					results: [latest, historical],
					tasks: [],
					next_offset: null,
				});
			}
			if (path === "/api/translation-results/latest") {
				if (delayed && !releaseDetail)
					return new Promise<Response>((resolve) => {
						releaseDetail = () => resolve(Response.json(latest));
					});
				return Response.json(latest);
			}
			if (path === "/api/translation-results/historical")
				return Response.json(historical);
			if (path.endsWith("/material-provenance/matches"))
				return Response.json({
					segments: scenario === "existing" ? [existing] : [],
					truncated: false,
				});
			if (path === "/api/segments/existing/material-provenance/select") {
				selectedExisting = true;
				check(
					sameSelection(await request.json(), 0),
					"Reuse must retain exact selected provenance",
				);
				return Response.json(existing);
			}
			if (
				path === "/api/sources/source/segments" &&
				request.method === "POST"
			) {
				const body: Schema["SegmentCreate"] = await request.json();
				submitted.push(body);
				if (scenario === "frozen" && submitted.length === 1)
					return new Promise<Response>((resolve) => {
						releaseSave = () =>
							resolve(Response.json({ detail: "响应丢失" }, { status: 503 }));
					});
				return Response.json({
					...existing,
					id: "saved",
					translation: body.translation ?? "",
					context_before: body.context_before ?? "",
					context_after: body.context_after ?? "",
				});
			}
			throw new Error(`Unexpected record-saving ${request.method} ${path}`);
		});
		const dispose = await h.mount(
			<MaterialReader />,
			"/materials/:id",
			`/materials/${book.id}`,
		);
		const button = (label: string, scope: ParentNode = h.container) => {
			const found = [...scope.querySelectorAll("button")].find(
				(node) =>
					(node.getAttribute("aria-label") ?? node.textContent?.trim()) ===
					label,
			);
			check(found && !found.disabled, `Missing enabled ${label} (${scenario})`);
			return found;
		};
		const select = async (index = 0) => {
			await new Promise((resolve) => setTimeout(resolve, 150));
			const frame = h.container.querySelector<HTMLIFrameElement>(
				"iframe.material-part",
			);
			const doc = frame?.contentDocument,
				native = doc?.getSelection();
			const leaf = doc?.querySelector(`[data-locator-leaf="${index}"]`);
			check(
				doc && native && leaf,
				"Real iframe must expose native selectable text",
			);
			const range = doc.createRange();
			range.selectNodeContents(leaf);
			native.removeAllRanges();
			native.addRange(range);
			const part = chapter.parts[0],
				resource = chapter.resources[0];
			check(part && resource, "Fixture requires canonical source");
			captureNativeSelection(
				doc,
				projectPart(doc, text, 0),
				part,
				resource,
				book.id,
				"v1",
			);
			doc.dispatchEvent(new Event("selectionchange"));
			await h.until(
				() => !!h.container.querySelector('[aria-label="选区操作"]'),
				`Native selection must expose toolbar (${scenario}, ${doc.readyState}, ${native.toString()})`,
			);
		};
		const textarea = () => {
			const found = h.container.querySelector<HTMLTextAreaElement>(
				".study-segment-panel textarea",
			);
			check(found, "Save dialog must expose translation field");
			return found;
		};
		try {
			await h.until(
				() =>
					!!h.container
						.querySelector<HTMLIFrameElement>("iframe.material-part")
						?.contentDocument?.querySelector('[data-locator-leaf="3"]'),
				"Reader iframe must load",
			);
			check(
				!h.container.querySelector('button[aria-label="最近翻译"]'),
				"Reader toolbar must omit the removed recent-translations entry",
			);
			if (scenario === "latest") {
				await select();
				button(
					"翻译",
					h.container.querySelector('[aria-label="选区操作"]') ?? h.container,
				).click();
				await h.until(
					() =>
						h.container.querySelector(".translation-output")?.textContent ===
						fullTranslation,
					"Translate same original must display existing complete result",
				);
				button("关闭翻译（任务继续）").click();
			}
			if (["history", "chapter-history-failure"].includes(scenario)) {
				await select();
				button(
					"翻译",
					h.container.querySelector('[aria-label="选区操作"]') ?? h.container,
				).click();
				await h.until(
					() =>
						h.container.querySelectorAll(".translation-history-item").length ===
						2,
					"Exact-source translation history must load",
				);
				const wanted =
					scenario === "history" ? historical.translation : latest.translation;
				const item = [
					...h.container.querySelectorAll<HTMLButtonElement>(
						".translation-history-item",
					),
				].find((node) => node.textContent?.includes(wanted));
				check(item, "History result must be selectable");
				item.click();
				await h.until(
					() =>
						h.container.querySelector(".translation-output")?.textContent ===
						wanted,
					"Chosen full result must load",
				);
				button("关闭翻译（任务继续）").click();
			}
			const index =
				scenario === "other-place"
					? 1
					: scenario === "internal-space"
						? 2
						: scenario === "punctuation"
							? 3
							: 0;
			await select(index);
			button("保存为学习片段").click();
			await h.until(
				() => !!h.container.querySelector(".study-segment-panel textarea"),
				"Selection save dialog must open",
			);
			const translationField = textarea().closest("label");
			const titleNode = [...(translationField?.childNodes ?? [])].find(
				(node) =>
					node.nodeType === Node.TEXT_NODE &&
					node.textContent?.includes("译文"),
			);
			check(
				translationField && titleNode,
				"Translation field must retain its visible label",
			);
			const titleRange = document.createRange();
			titleRange.selectNodeContents(titleNode);
			const inputBounds = textarea().getBoundingClientRect();
			const fieldBounds = translationField.getBoundingClientRect();
			check(
				inputBounds.top >= titleRange.getBoundingClientRect().bottom &&
					Math.abs(inputBounds.width - fieldBounds.width) <= 2,
				"Translation editor must fill its own row below the label",
			);
			if (delayed) {
				await h.until(
					() => !!releaseDetail,
					"Full translation detail must be pending",
				);
				if (scenario === "edit" || scenario === "clear") {
					h.inputValue(textarea(), "手工编辑");
					await h.until(
						() => textarea().value === "手工编辑",
						"Manual edit must update draft",
					);
					if (scenario === "clear") {
						h.inputValue(textarea(), "");
						await h.until(
							() => textarea().value === "",
							"Explicit clear must update draft",
						);
					}
					releaseDetail?.();
					await h.until(
						() => !h.container.textContent?.includes("正在读取已存译文"),
						"Late detail must settle",
					);
					check(
						textarea().value === (scenario === "edit" ? "手工编辑" : ""),
						"Late result must preserve edit or explicit clear",
					);
				} else {
					h.inputValue(textarea(), "首次提交固定值");
					await h.until(
						() => textarea().value === "首次提交固定值",
						"Frozen fixture edit must settle",
					);
					button("保存片段").click();
					await h.until(() => !!releaseSave, "First save must be pending");
					check(textarea().disabled, "Pending save must freeze fields");
					releaseDetail?.();
					releaseSave?.();
					await h.until(
						() =>
							h.container.textContent?.includes("保存结果尚未确认") === true,
						"Lost response must expose verification retry",
					);
					check(
						textarea().disabled && textarea().value === "首次提交固定值",
						"Uncertain save must freeze first value despite late detail",
					);
					button("核实本次保存").click();
				}
			} else if (
				["other-place", "internal-space", "punctuation"].includes(scenario)
			) {
				await new Promise((resolve) => setTimeout(resolve, 120));
				check(
					textarea().value === "",
					`${scenario}: different occurrence or text must not carry translation`,
				);
			} else {
				const wanted =
					scenario === "history" ? historical.translation : fullTranslation;
				await h.until(
					() => textarea().value === wanted,
					`${scenario}: full matching translation must prefill`,
				);
			}
			if (preview)
				return `record saving preview: ${innerWidth}px; real iframe source and full translation draft`;
			if (scenario === "existing") {
				h.inputValue(textarea(), "本次修改不得覆盖已有译文");
				await h.until(
					() => textarea().value === "本次修改不得覆盖已有译文",
					"Reuse fixture must contain unsaved manual changes",
				);
				const choose = [...h.container.querySelectorAll("button")].find(
					(node) => node.textContent?.startsWith("选用 "),
				);
				check(choose, "Same-source existing segment must be offered");
				choose.click();
				await h.until(
					() => h.container.textContent?.includes("选用已有片段？") === true,
					"Reuse must request abandoning draft before selecting existing segment",
				);
				button("选用并打开").click();
				await h.until(
					() => selectedExisting,
					"Existing selection must use provenance selection endpoint",
				);
				check(
					submitted.length === 0 &&
						existing.translation === "已有译文保持不变。",
					"Reuse must not create or overwrite a segment",
				);
			} else {
				if (scenario !== "frozen") button("保存片段").click();
				await h.until(
					() => !!h.container.querySelector('[data-segment-id="saved"]'),
					"Save must complete",
				);
				const body = submitted.at(-1);
				check(body, "Save request must be captured");
				check(
					sameSelection(body.material_provenance, index),
					"Save must preserve actual native selection including Unicode edge whitespace",
				);
				if (
					[
						"edit",
						"clear",
						"other-place",
						"internal-space",
						"punctuation",
						"frozen",
					].includes(scenario)
				)
					check(
						!body.translation_result_id,
						"Edited, cleared or unrelated draft must not associate old result",
					);
				else
					check(
						body.translation_result_id ===
							(scenario === "history" ? historical.id : latest.id),
						"Save must associate chosen matching full result",
					);
				if (scenario === "frozen")
					check(
						submitted.length === 2 &&
							JSON.stringify(submitted[0]) === JSON.stringify(submitted[1]),
						"Lost response retry must reuse identical first ID and payload",
					);
			}
			check(
				generated === 0,
				"Save and history browsing must not generate translations",
			);
			completed.push(scenario);
		} finally {
			if (!preview) dispose();
		}
	}
	return `record saving: ${innerWidth}px/${direction}/${params.get("theme") ?? "light"}; ${completed.join(", ")}; native iframe selection, offline API`;
}
