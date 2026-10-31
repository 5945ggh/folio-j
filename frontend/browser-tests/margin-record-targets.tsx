import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

type Schema = components["schemas"];

/** Separate physical first anchors still belong to one transitive provenance group. */
export function marginRecordFixture(base: Schema["MaterialChapterResponse"]) {
	const paragraphs = [
		"春の風が静かな庭を通り抜ける。",
		"猫は縁側でゆっくりと目を開けた。",
		"遠くの空には淡い光が残っている。",
		"風が木の葉を揺らし、小さな音を立てた。",
		"庭の石には雨の跡がまだ残っていた。",
		"小鳥が枝から枝へ飛び移っていった。",
		"やがて家の明かりが静かに灯った。",
	];
	const text = paragraphs.join("");
	const provenance = (
		start: number,
		end = start,
		trim = 0,
	): Schema["MaterialProvenance"] => {
		const from = paragraphs.slice(0, start).join("").length + trim;
		const to = paragraphs.slice(0, end + 1).join("").length;
		return {
			contract_version: "1",
			material_id: base.material_id,
			version_id: base.version_id,
			ranges: [
				{
					resource_id: "r",
					spine_index: 0,
					start: from,
					end: to,
					exact: text.slice(from, to),
					text_sha256: "a".repeat(64),
					prefix: "",
					suffix: "",
				},
			],
		};
	};
	const references = [
		provenance(0, 2),
		provenance(1),
		provenance(4),
		provenance(4, 4, 2),
		provenance(6),
	];
	const segments = [
		["margin-main", provenance(2, 6)],
		["margin-second", provenance(3)],
		["margin-group-a", provenance(5)],
		["margin-group-b", provenance(5, 5, 2)],
		["margin-mixed", provenance(6)],
	].map(([id, reference]) => {
		const material_provenance = reference as Schema["MaterialProvenance"];
		return {
			segment_id: String(id),
			excerpt: material_provenance.ranges[0]?.exact ?? "",
			material_provenance,
			created_at: "2026-10-23T00:00:00Z",
		};
	});
	const chapter: Schema["MaterialChapterResponse"] = {
		...base,
		title: "页边具体记录回归",
		resources: base.resources.map((resource) => ({
			...resource,
			text,
			css: "p{margin:0;margin-block-end:2em}",
		})),
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
						(paragraph, index) =>
							`<p><span data-locator-leaf="${index}">${paragraph}</span></p>`,
					)
					.join(""),
			},
		],
	};
	return { chapter, references, segments };
}

export async function marginRecordTargets(
	h: BrowserHarness,
	segments: readonly Schema["MaterialChapterSegment"][],
	translations: readonly Schema["TranslationResultResponse"][],
	preview: boolean,
) {
	const check: BrowserHarness["check"] = h.check;
	const button = (label: string, scope: ParentNode = h.container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) =>
				(item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
		);
		check(found && !found.disabled, `Missing enabled ${label}`);
		return found;
	};
	const panel = () =>
		h.container.querySelector<HTMLElement>(".reader-chapter-records");
	const margins = () => [
		...h.container.querySelectorAll<HTMLButtonElement>(".reader-study-margin"),
	];
	const matchingMargins = (label: string) =>
		margins()
			.filter((item) => item.getAttribute("aria-label") === label)
			.sort((a, b) =>
				new URLSearchParams(location.search).get("direction") === "vertical-rl"
					? b.getBoundingClientRect().left - a.getBoundingClientRect().left
					: a.getBoundingClientRect().top - b.getBoundingClientRect().top,
			);
	const selectedTab = (label: string) =>
		h.container
			.querySelector(`[role="tab"][aria-label="${label}"]`)
			?.getAttribute("aria-selected") === "true";
	const segmentRows = () => [
		...h.container.querySelectorAll<HTMLButtonElement>(
			".reader-study-preview-candidates [data-segment-id]",
		),
	];
	const translationRows = () => [
		...h.container.querySelectorAll<HTMLButtonElement>(
			".reader-record-translation",
		),
	];
	const assertGroupCounts = () => {
		check(
			button("学习片段").querySelector("span")?.textContent ===
				String(segments.length) &&
				button("翻译").querySelector("span")?.textContent ===
					String(translations.length),
			"Every margin entry must retain the entire transitive record group in both tabs",
		);
	};
	const assertHeaderReturn = () => {
		const back = button("返回此处记录");
		check(
			panel()?.querySelector(":scope > header")?.contains(back) &&
				back.title === "返回此处记录",
			"Direct margin details need an accessible host-header return to the associated record group",
		);
	};
	const translationDetail = async (index: number) => {
		const target = translations[index];
		check(target, "Fixture requires a saved translation");
		await h.until(
			() =>
				selectedTab("翻译") &&
				h.container
					.querySelector(".translation-output")
					?.textContent?.includes(target.translation) === true,
			"A translation margin must directly show its own saved result despite related segments/translations",
		);
		check(
			!translationRows().length,
			"Direct translation entry must not stop at a list",
		);
		assertHeaderReturn();
		assertGroupCounts();
	};
	const segmentDetail = async (index: number) => {
		const target = segments[index];
		check(target, "Fixture requires a saved segment");
		await h.until(
			() =>
				selectedTab("学习片段") &&
				h.container
					.querySelector(".reader-study-preview-original p")
					?.textContent?.trim() === target.excerpt,
			"A segment margin must directly show its exact segment despite related records",
		);
		check(
			!segmentRows().length &&
				!!h.container.querySelector(".reader-study-preview-open"),
			"Direct segment entry must expose details and its open action",
		);
		assertHeaderReturn();
		assertGroupCounts();
	};
	const panelPosition = async () => {
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		const bounds = panel()?.getBoundingClientRect();
		check(bounds, "Preview must exist while measuring its physical anchor");
		return { left: bounds.left, top: bounds.top };
	};
	const assertRepositioned = async (before: { left: number; top: number }) => {
		await h.until(() => {
			const bounds = panel()?.getBoundingClientRect();
			return (
				!!bounds &&
				(Math.abs(bounds.left - before.left) > 1 ||
					Math.abs(bounds.top - before.top) > 1)
			);
		}, "A different physical button in the same associated group must re-anchor the preview");
	};
	const close = async (trigger: HTMLButtonElement) => {
		trigger.click();
		await h.until(
			() => !panel() && trigger.getAttribute("aria-expanded") === "false",
			"Clicking the same physical margin button must close its preview",
		);
	};
	const list = async (kind: "segment" | "translation") => {
		const label = kind === "segment" ? "学习片段" : "翻译";
		await h.until(
			() =>
				selectedTab(label) &&
				(kind === "segment"
					? segmentRows().length === segments.length
					: translationRows().length === translations.length),
			"A numeric entry must show the complete associated group list in the correct initial tab",
		);
		check(
			!h.container.querySelector(".reader-study-preview-open") &&
				!h.container.querySelector(".reader-record-back"),
			"Group lists must omit detail navigation actions",
		);
		assertGroupCounts();
	};
	await h.until(
		() => margins().length === 7,
		"Fixture must paint seven independently positioned real margin buttons",
	);
	const singlesTranslation = matchingMargins("打开此处翻译");
	const singlesSegment = matchingMargins("打开此处学习片段");
	const numeric = matchingMargins("查看此处 2 条记录");
	check(
		singlesTranslation.length === 2 &&
			singlesSegment.length === 2 &&
			numeric.length === 3,
		"Fixture must retain pure translation, pure segment, and numeric physical entries within one overlap group",
	);
	const firstTranslation = singlesTranslation[0];
	const secondTranslation = singlesTranslation[1];
	const firstSegment = singlesSegment[0];
	const secondSegment = singlesSegment[1];
	const pureTranslationGroup = numeric[0];
	const pureSegmentGroup = numeric[1];
	const mixedGroup = numeric[2];
	check(
		firstTranslation &&
			secondTranslation &&
			firstSegment &&
			secondSegment &&
			pureTranslationGroup &&
			pureSegmentGroup &&
			mixedGroup,
		"All physical margin entrances must exist",
	);
	firstTranslation.click();
	await translationDetail(0);
	if (preview)
		return "margin record target preview: real pure translation icon, exact saved result, return to complete mixed associated group";
	button("返回此处记录").click();
	await list("translation");
	await h.until(
		() =>
			document.activeElement?.getAttribute("data-translation-id") ===
			translations[0]?.identity_sha256,
		"Returning from direct translation details must focus that translation in the full associated list",
	);
	button("学习片段").click();
	await list("segment");
	check(
		segmentRows()
			.map((row) => row.dataset.segmentId)
			.join() === segments.map((item) => item.segment_id).join(),
		"Direct translation's return must preserve every associated learning segment",
	);
	await close(firstTranslation);

	firstTranslation.click();
	await translationDetail(0);
	const translationPosition = await panelPosition();
	secondTranslation.click();
	await translationDetail(1);
	await assertRepositioned(translationPosition);
	check(
		firstTranslation.getAttribute("aria-expanded") === "false" &&
			secondTranslation.getAttribute("aria-expanded") === "true",
		"Switching physical buttons within the same overlap group must replace the target and expanded state",
	);
	await close(secondTranslation);

	firstSegment.click();
	await segmentDetail(0);
	button("返回此处记录").click();
	await list("segment");
	await h.until(
		() =>
			document.activeElement?.getAttribute("data-segment-id") ===
			segments[0]?.segment_id,
		"Returning from direct segment details must focus the clicked segment in its full associated list",
	);
	button("翻译").click();
	await list("translation");
	await close(firstSegment);
	firstSegment.click();
	await segmentDetail(0);
	const segmentPosition = await panelPosition();
	secondSegment.click();
	await segmentDetail(1);
	await assertRepositioned(segmentPosition);
	await close(secondSegment);

	pureTranslationGroup.click();
	await list("translation");
	button("学习片段").click();
	await list("segment");
	segmentRows()[1]?.click();
	await h.until(
		() =>
			h.container.querySelector(".reader-study-preview-original p")
				?.textContent === segments[1]?.excerpt,
		"Selecting a segment from the alternate tab must open that exact item",
	);
	button("翻译").click();
	await list("translation");
	translationRows()[1]?.click();
	await h.until(
		() =>
			h.container
				.querySelector(".translation-output")
				?.textContent?.includes(translations[1]?.translation ?? "MISSING") ===
			true,
		"Selecting a translation must open that exact alternate-tab item",
	);
	button("学习片段").click();
	await h.until(
		() =>
			h.container.querySelector(".reader-study-preview-original p")
				?.textContent === segments[1]?.excerpt,
		"Switching tabs must preserve the explicitly selected segment",
	);
	button("翻译").click();
	await h.until(
		() =>
			h.container
				.querySelector(".translation-output")
				?.textContent?.includes(translations[1]?.translation ?? "MISSING") ===
			true,
		"Switching tabs must preserve the explicitly selected translation",
	);
	await close(pureTranslationGroup);
	pureSegmentGroup.click();
	await list("segment");
	await close(pureSegmentGroup);
	mixedGroup.click();
	await list("segment");
	button("翻译").click();
	await list("translation");
	await close(mixedGroup);
	return `margin record targets ${new URLSearchParams(location.search).get("direction") ?? "horizontal-tb"}: real physical buttons, exact translation and segment direct details, associated full-group return with row focus, pure translation/segment and mixed numeric initial tabs, same-button close and same-group target replacement/repositioning`;
}
