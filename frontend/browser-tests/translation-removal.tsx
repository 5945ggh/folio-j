import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "../src/api/schema";
import { projectPart } from "../src/materials/dom";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
type Result = Schema["TranslationResultResponse"];

/** A persistent, entirely local server: no translation or learning content is generated. */
export function translationRemovalFixture(
	h: BrowserHarness,
	results: Result[],
	historical: Result,
	summaries: Schema["MaterialChapterTranslation"][],
) {
	const check: BrowserHarness["check"] = h.check;
	const target = results[1],
		repeated = results[4];
	check(
		target && repeated,
		"Removal fixture needs same-text targets at different offsets",
	);
	check(
		target.text === repeated.text &&
			target.identity_sha256 !== repeated.identity_sha256,
		"Repeated source must retain a distinct exact identity",
	);
	const history = [
		...results,
		historical,
		{
			...target,
			id: "result-target-history",
			task_id: "task-target-history",
			translation: "猫的旧版完整译文。",
		},
	];
	summaries.push({
		identity_sha256: repeated.identity_sha256,
		result_id: repeated.id,
		material_provenance: repeated.material_provenance,
		excerpt: repeated.text,
		translation_excerpt: repeated.translation,
		result_count: 1,
		target_language: repeated.target_language,
		created_at: repeated.created_at,
	});
	const removed = new Set<string>();
	const deletions: string[] = [];
	let failNext = true;
	let heldId: string | undefined;
	let held = false;
	let release: (() => void) | undefined;
	return {
		removed,
		deletions,
		history,
		holdDetail(id: string) {
			heldId = id;
		},
		detailHeld: () => held,
		releaseDetail: () => release?.(),
		async respond(request: Request): Promise<Response | undefined> {
			const url = new URL(request.url),
				path = url.pathname;
			if (path === "/api/settings/context-copy" && request.method === "GET")
				return Response.json(defaultContextCopySettings);
			if (
				request.method === "DELETE" &&
				path.startsWith("/api/materials/chapter-records/translations/")
			) {
				const identity = path.split("/").at(-1) ?? "";
				check(
					results.some((item) => item.identity_sha256 === identity),
					"DELETE must carry an existing exact target identity",
				);
				deletions.push(identity);
				if (failNext) {
					failNext = false;
					return Response.json(
						{ detail: "本地删除失败，请重试" },
						{ status: 503 },
					);
				}
				removed.add(identity);
				const matching = history.filter(
					(item) => item.identity_sha256 === identity,
				);
				return Response.json({
					identity_sha256: identity,
					task_ids: [...new Set(matching.map((item) => item.task_id))],
					result_ids: matching.map((item) => item.id),
					cancelled_task_ids: [],
				} satisfies Schema["TranslationRemovalResponse"]);
			}
			if (
				request.method === "GET" &&
				path === "/api/materials/chapter-records/translations"
			) {
				const identity = url.searchParams.get("identity_sha256");
				const visible = history.filter(
					(item) =>
						!removed.has(item.identity_sha256) &&
						(!identity || item.identity_sha256 === identity),
				);
				return Response.json({
					results: visible,
					tasks: visible.map(
						(item) =>
							({
								id: item.task_id,
								source_id: item.source_id,
								material_id: item.material_id,
								status: "succeeded",
								result_id: item.id,
								run_id: item.run_id,
								error: null,
								text: item.text,
								material_provenance: item.material_provenance,
								context_before: item.context_before,
								context_after: item.context_after,
								created_at: item.created_at,
							}) satisfies Schema["TranslationTaskResponse"],
					),
					next_offset: null,
				});
			}
			if (path === "/api/segments/saved/translation-results")
				return Response.json(
					history
						.filter((item) => item.adopted_segment_ids.includes("saved"))
						.map((item) => ({
							...item,
							reader_deleted: removed.has(item.identity_sha256),
						})),
				);
			const result = history.find(
				(item) => path === `/api/translation-results/${item.id}`,
			);
			if (result && request.method === "GET") {
				const snapshot = {
					...result,
					reader_deleted: removed.has(result.identity_sha256),
				};
				if (heldId === result.id) {
					heldId = undefined;
					held = true;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					// Intentionally ignore AbortSignal and return the pre-delete response.
					return Response.json(snapshot);
				}
				return removed.has(result.identity_sha256) &&
					!result.adopted_segment_ids.length
					? Response.json({ detail: "翻译不存在" }, { status: 404 })
					: Response.json(snapshot);
			}
			return undefined;
		},
	};
}

type Fixture = ReturnType<typeof translationRemovalFixture>;

export async function translationRemoval(
	h: BrowserHarness,
	doc: Document,
	text: string,
	results: readonly Result[],
	fixture: Fixture,
	reader: {
		chapter: Schema["MaterialChapterResponse"];
		releaseReader: () => void;
		remountReader: () => Promise<Document>;
	},
) {
	const check: BrowserHarness["check"] = h.check;
	const first = results[0],
		target = results[1],
		other = results[2],
		repeated = results[4];
	check(
		first && target && other && repeated,
		"Removal requires four independent targets",
	);
	const button = (label: string, scope: ParentNode = h.container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
		);
		check(found && !found.disabled, `Missing enabled button ${label}`);
		return found;
	};
	const listEntry = (id: string) =>
		h.container.querySelector<HTMLButtonElement>(
			`.reader-record-translation[data-translation-id="${id}"]`,
		);
	const modal = () =>
		h.container.querySelector<HTMLDialogElement>("dialog[open]");
	const frames = () =>
		new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
	const inline = () =>
		doc.querySelector<HTMLElement>("[data-reader-inline-translation]");
	const tap = () => {
		const leaf = doc.querySelector<HTMLElement>('[data-locator-leaf="2"]');
		check(leaf?.firstChild, "Removal must tap real source text");
		const range = doc.createRange();
		range.setStart(leaf.firstChild, 5);
		range.setEnd(leaf.firstChild, 6);
		const rect = range.getBoundingClientRect();
		for (const type of ["pointerdown", "pointerup"])
			leaf.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 71,
					isPrimary: true,
					pointerType: "mouse",
					button: 0,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				}),
			);
	};
	const marked = (
		kind: "folio-study" | "folio-translation",
		result: Result,
	) => {
		const projection = projectPart(doc, text, 0);
		const registry = (
			doc.defaultView as unknown as {
				CSS: { highlights: Map<string, Set<Range>> };
			}
		).CSS.highlights;
		const start = result.material_provenance.ranges[0]?.start;
		check(start !== undefined, "Saved mark requires an exact offset");
		return [...(registry.get(kind) ?? [])].some((range) => {
			const entry = projection.entries.find(
				(entry) => entry.node === range.startContainer,
			);
			const end = projection.entries.find(
				(entry) => entry.node === range.endContainer,
			);
			return (
				entry &&
				end &&
				entry.start + range.startOffset <= start &&
				end.start + range.endOffset > start
			);
		});
	};
	const openList = async () => {
		if (!h.container.querySelector(".reader-chapter-records"))
			button("本章记录").click();
		await h.until(
			() => !!h.container.querySelector(".reader-record-tabs"),
			"Chapter tabs must mount before choosing translations",
		);
		button("翻译").click();
		const back = h.container.querySelector<HTMLButtonElement>(
			'button[aria-label="返回翻译列表"]',
		);
		back?.click();
		await h.until(
			() => !!listEntry(other.identity_sha256),
			"Remaining chapter translations must be available",
		);
	};
	button("关闭阅读记录").click();
	await h.until(
		() => !h.container.querySelector(".reader-chapter-records"),
		"Close list before source tap",
	);
	tap();
	const vertical = getComputedStyle(doc.body).writingMode === "vertical-rl";
	await h.until(
		() =>
			vertical
				? !!h.container
						.querySelector(".reader-chapter-records")
						?.textContent?.includes(target.translation)
				: inline()?.textContent === target.translation,
		"Real dashed source tap must open saved complete translation",
	);
	check(
		marked("folio-translation", target),
		"Target must start with a real dashed mark",
	);
	if (vertical) {
		button("关闭阅读记录").click();
		await h.until(
			() => !h.container.querySelector(".reader-chapter-records"),
			"Vertical source card must close before reopening chapter list",
		);
	}
	await openList();
	const removeFromList = () => {
		const entry = listEntry(target.identity_sha256);
		check(
			entry?.parentElement,
			"Target row must remain available before deletion",
		);
		button(`删除此处翻译：${target.text}`, entry.parentElement).click();
	};
	removeFromList();
	await h.until(
		() => !!modal(),
		"List trash opens a native confirmation dialog",
	);
	check(
		modal()?.textContent?.includes("已另存的学习片段及关联译文快照保留"),
		"Confirmation states exact deletion and retention scope",
	);
	button("取消", modal() ?? undefined).click();
	await h.until(() => !modal(), "Cancel closes confirmation");
	check(
		Number(fixture.deletions.length) === 0 &&
			listEntry(target.identity_sha256) &&
			marked("folio-translation", target),
		"Cancel must leave the row and mark unchanged without DELETE",
	);
	removeFromList();
	await h.until(() => !!modal(), "Retry opens the same confirmation");
	button("确认删除翻译", modal() ?? undefined).click();
	await h.until(
		() => !!modal()?.textContent?.includes("本地删除失败，请重试"),
		"DELETE failure remains in the modal for retry",
	);
	check(
		Number(fixture.deletions.length) === 1 &&
			listEntry(target.identity_sha256) &&
			marked("folio-translation", target),
		"Failed DELETE must preserve row and source mark",
	);
	button("确认删除翻译", modal() ?? undefined).click();
	await h.until(
		() => !modal() && !listEntry(target.identity_sha256) && !inline(),
		"Successful retry removes target list entry and any inline output",
	);
	await h.until(
		() => !marked("folio-translation", target),
		"Successful DELETE clears the permanent dashed range",
	);
	check(
		Number(fixture.deletions.length) === 2 &&
			fixture.deletions.every((id) => id === target.identity_sha256),
		"One request per confirmed attempt must use the exact selected identity",
	);
	check(
		marked("folio-study", first) &&
			marked("folio-translation", other) &&
			marked("folio-translation", repeated),
		"Independent target, same-text other location and saved study mark must survive",
	);
	check(
		fixture.history.filter(
			(item) => item.identity_sha256 === target.identity_sha256,
		).length === 2,
		"Removal exercises both target histories",
	);
	await openList();
	fixture.holdDetail(first.id);
	const adoptedEntry = listEntry(first.identity_sha256);
	check(
		adoptedEntry,
		"Adopted target must still be available for title deletion",
	);
	adoptedEntry.click();
	await h.until(
		fixture.detailHeld,
		"Adopted detail GET must remain in flight before deletion",
	);
	await h.until(
		() => !!h.container.querySelector('button[aria-label="删除此处翻译"]'),
		"Detail history must expose title removal control while output is pending",
	);
	button("删除此处翻译").click();
	await h.until(
		() => !!modal(),
		"Detail title trash opens the same confirmation",
	);
	button("确认删除翻译", modal() ?? undefined).click();
	await h.until(
		() => !modal() && fixture.removed.has(first.identity_sha256),
		"Title deletion completes while stale detail remains pending",
	);
	fixture.releaseDetail();
	await frames();
	await openList();
	check(
		!listEntry(first.identity_sha256) && !listEntry(target.identity_sha256),
		"Late successful GET must not restore removed target histories",
	);
	check(
		Number(fixture.deletions.length) === 3 &&
			fixture.deletions[2] === first.identity_sha256,
		"Title deletion submits exactly one request for the adopted target",
	);
	await h.until(
		() => marked("folio-study", first) && !marked("folio-translation", target),
		"Removing translation must preserve saved study underline",
	);
	button("学习片段").click();
	await h.until(
		() =>
			!!h.container.querySelector(".reader-study-preview-candidates button"),
		"Saved study list entry must remain available",
	);
	h.container
		.querySelector<HTMLButtonElement>(".reader-study-preview-candidates button")
		?.click();
	await h.until(
		() => !!h.container.textContent?.includes("保存的片段译文。"),
		"Saved fragment current translation remains readable",
	);
	check(
		h.container.textContent?.includes("完整长讲解"),
		"Saved Analysis remains available in study preview",
	);
	reader.releaseReader();
	const { SegmentTranslations } = await import(
		"../src/translation/SegmentTranslations"
	);
	const disposeSegment = await h.mount(
		<SegmentTranslations segmentId="saved" translation="保存的片段译文。" />,
	);
	try {
		await h.until(
			() => !!h.container.querySelector(".segment-translations"),
			"Segment must retain associated saved snapshots",
		);
		check(
			h.container.querySelector(".segment-current-translation")?.textContent ===
				"保存的片段译文。",
			"Reader deletion cannot rewrite current Segment translation",
		);
		for (const details of h.container.querySelectorAll("details"))
			details.setAttribute("open", "");
		check(
			h.container.textContent?.includes(
				"此处阅读翻译已删除；关联译文快照保留。",
			) && h.container.textContent.includes(first.translation),
			"Segment explains retained snapshots and preserves original result text",
		);
	} finally {
		disposeSegment();
	}
	doc = await reader.remountReader();
	await openList();
	await h.until(
		() => marked("folio-study", first) && marked("folio-translation", repeated),
		"Remount restores only surviving server marks",
	);
	check(
		!listEntry(first.identity_sha256) &&
			!listEntry(target.identity_sha256) &&
			!marked("folio-translation", target) &&
			!inline(),
		"Fresh reader must not resurrect deleted histories, source mark or inline output",
	);
	check(
		listEntry(other.identity_sha256) && listEntry(repeated.identity_sha256),
		"Fresh reader preserves independent and same-text other-location translations",
	);
	reader.releaseReader();
	await studyDraftRemoval(h, other, reader.chapter);
	return `translation removal ${vertical ? "vertical" : "horizontal"} ${innerWidth}px: source tap, cancel, failed DELETE retry, all histories/mark/inline cleanup, exact identity, late detail rejection, same-text location isolation, adopted title deletion, Segment/Analysis retention and fresh mount`;
}

/** Actual draft panel keeps edited text and fences uncertain saves after source removal. */
async function studyDraftRemoval(
	h: BrowserHarness,
	source: Result,
	chapter: Schema["MaterialChapterResponse"],
) {
	const check: BrowserHarness["check"] = h.check;
	const [{ StudySegmentPanel }, { ReaderLeaveProvider }] = await Promise.all([
		import("../src/materials/StudySegmentPanel"),
		import("../src/materials/ReaderLeaveProvider"),
	]);
	for (const mode of ["deleted", "unavailable", "uncertain"] as const) {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		const submitted: Schema["SegmentCreate"][] = [];
		let failDetail = false;
		let releaseSave: (() => void) | undefined;
		let saved = false;
		const original = { ...source, reader_deleted: false };
		const detailKey = ["translation-result", source.id];
		h.mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === `/api/translation-results/${source.id}`)
				return failDetail
					? Response.json({ detail: "译文读取失败" }, { status: 503 })
					: Response.json(original);
			if (path === "/api/settings/segment-context")
				return Response.json({
					enabled: false,
					before_sentences: 3,
					after_sentences: 0,
					before_characters: 200,
					after_characters: 0,
					revision: 1,
				});
			if (path.endsWith("/segments/material-provenance/matches"))
				return Response.json({ segments: [], truncated: false });
			if (
				path === "/api/sources/source/segments" &&
				request.method === "POST"
			) {
				const body: Schema["SegmentCreate"] = await request.json();
				submitted.push(body);
				if (mode === "uncertain" && submitted.length === 1) {
					await new Promise<void>((resolve) => {
						releaseSave = resolve;
					});
					return Response.json(
						{ detail: "本地保存响应不确定" },
						{ status: 503 },
					);
				}
				return Response.json({
					id: "draft-saved",
					source_id: "source",
					text: source.text,
					translation: body.translation,
					context_before: body.context_before,
					context_after: body.context_after,
					material_provenance: source.material_provenance,
					revision: 1,
					text_sha256: "a".repeat(64),
					text_locked_at: null,
					transcription: "",
					source_ref: "",
					note: "",
					created_at: source.created_at,
					updated_at: source.created_at,
				} satisfies Schema["SegmentResponse"]);
			}
			throw new Error(`Unmocked draft removal ${request.method} ${path}`);
		});
		const dispose = await h.mount(
			<QueryClientProvider client={client}>
				<ReaderLeaveProvider active>
					<StudySegmentPanel
						target={{ reference: source.material_provenance, chapter }}
						sourceId="source"
						sourceTitle="测试来源"
						preferredResultId={source.id}
						onCancel={() => {}}
						onSaved={() => {
							saved = true;
						}}
					/>
				</ReaderLeaveProvider>
			</QueryClientProvider>,
		);
		const button = (label: string) => {
			const result = [
				...h.container.querySelectorAll<HTMLButtonElement>("button"),
			].find((node) => node.textContent?.trim() === label);
			check(result, `Missing draft button ${label}`);
			return result;
		};
		try {
			await h.until(
				() =>
					h.container.querySelector<HTMLTextAreaElement>(
						".study-translation-field textarea",
					)?.value === source.translation,
				"Draft must prefill its exact saved reading translation",
			);
			const field = h.container.querySelector<HTMLTextAreaElement>(
				".study-translation-field textarea",
			);
			check(field, "Draft translation textarea required");
			const edited = `保留的手动改写 ${mode}`;
			h.inputValue(field, edited);
			await h.until(
				() => field.value === edited,
				"Draft edit must reach React state",
			);
			if (mode === "deleted") {
				client.setQueryData(detailKey, { ...original, reader_deleted: true });
				await h.until(
					() =>
						!!h.container.textContent?.includes(
							"原阅读翻译已删除，草稿文字仍保留，可独立保存为片段",
						),
					"Deleted source must detach and explain that the draft survives",
				);
				check(
					field.value === edited,
					"Automatic detach must retain edited draft text",
				);
				button("保存片段").click();
			} else if (mode === "unavailable") {
				failDetail = true;
				await client.invalidateQueries({ queryKey: detailKey, exact: true });
				await h.until(
					() => !!h.container.textContent?.includes("保留草稿并解除译文关联"),
					"Failed result read must offer explicit detach",
				);
				check(
					!h.container.textContent?.includes("已解除译文关联，草稿文字仍保留"),
					"Read failure alone must not silently detach",
				);
				button("保留草稿并解除译文关联").click();
				await h.until(
					() =>
						!!h.container.textContent?.includes(
							"已解除译文关联，草稿文字仍保留",
						),
					"Explicit detach must retain draft and explain the result",
				);
				check(
					field.value === edited,
					"Explicit unavailable detach must retain edited text",
				);
				button("保存片段").click();
			} else {
				button("保存片段").click();
				await h.until(
					() => !!releaseSave && submitted.length === 1 && field.disabled,
					"Pending save must freeze its first request and lock draft edits",
				);
				client.setQueryData(detailKey, { ...original, reader_deleted: true });
				await new Promise((resolve) => setTimeout(resolve, 30));
				check(
					!h.container.textContent?.includes(
						"草稿文字仍保留，可独立保存为片段",
					),
					"Pending save must not detach its frozen association",
				);
				releaseSave?.();
				await h.until(
					() => !!h.container.textContent?.includes("保存结果尚未确认"),
					"503 keeps the original save uncertain",
				);
				failDetail = true;
				await client.invalidateQueries({ queryKey: detailKey, exact: true });
				await h.until(
					() => !!h.container.textContent?.includes("保留草稿并解除译文关联"),
					"Uncertain save can show failed-read recovery but keeps it disabled",
				);
				check(
					button("保留草稿并解除译文关联").disabled && field.disabled,
					"Uncertain save must disable detach and preserve original frozen request",
				);
				button("核实本次保存").click();
			}
			await h.until(
				() => saved,
				"Draft save must complete with the intended association policy",
			);
			check(
				submitted.every((body) => body.translation === edited),
				"Detach cannot alter saved edited text",
			);
			if (mode === "uncertain") {
				check(
					submitted.length === 2 &&
						JSON.stringify(submitted[0]) === JSON.stringify(submitted[1]) &&
						submitted[1]?.translation_result_id === source.id,
					"Uncertain retry must preserve the exact request identity, text and translation association",
				);
			} else {
				check(
					submitted.length === 1 &&
						!("translation_result_id" in (submitted[0] ?? {})),
					"Detached draft saves once without the removed result identity",
				);
			}
		} finally {
			releaseSave?.();
			dispose();
			client.clear();
		}
	}
}
