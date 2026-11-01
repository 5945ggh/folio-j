import type { components } from "../src/api/schema";
import type { SegmentFields } from "../src/content";
import type { BrowserHarness } from "./harness";
import { segmentOriginStability } from "./segment-origin-stability";

/** Keep this regression isolated from installed voices and the real device. */
function segmentSpeech() {
	const utterances: SpeechSynthesisUtterance[] = [];
	class Utterance extends EventTarget {
		voice: SpeechSynthesisVoice | null = null;
		lang = "";
		rate = 1;
		onstart: (() => void) | null = null;
		onend: (() => void) | null = null;
		onerror: ((event: { error: string }) => void) | null = null;
		constructor(public text: string) {
			super();
		}
	}
	const synthesis = new EventTarget();
	Object.assign(synthesis, {
		getVoices: () => [
			{
				voiceURI: "segment-fixture",
				name: "片段回归日语声音",
				lang: "ja-JP",
				localService: true,
			},
		],
		cancel: () => {},
		speak: (utterance: SpeechSynthesisUtterance) => utterances.push(utterance),
	});
	Object.defineProperty(window, "speechSynthesis", {
		configurable: true,
		value: synthesis,
	});
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		configurable: true,
		value: Utterance,
	});
	return utterances;
}

export const materialSegment: components["schemas"]["SegmentResponse"] = {
	id: "segment",
	source_id: "source",
	text: "目標原文。",
	translation: "完整译文。",
	context_before: "完全な前文。",
	context_after: "完全な後文。",
	transcription: "もくひょうげんぶん。",
	source_ref: "第 3 章补充",
	note: "个人管理备注内容",
	revision: 7,
	text_sha256: "a".repeat(64),
	text_locked_at: "2026-10-23T00:00:00Z",
	created_at: "2026-10-23T00:00:00Z",
	updated_at: "2026-10-23T00:00:00Z",
	material_provenance: {
		contract_version: "1",
		material_id: "book",
		version_id: "version",
		ranges: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 3,
				end: 9,
				exact: "目標原文。",
				text_sha256: "b".repeat(64),
				prefix: "前文。",
				suffix: "後文。",
			},
		],
	},
};

export async function segmentMaterials(h: BrowserHarness, refreshed = true) {
	const speech = segmentSpeech();
	if (new URLSearchParams(location.search).has("segment-content-preview")) {
		await segmentContentAggregation(h, speech, true);
		return "segment content preview: saved current translation and distinct historical result";
	}
	const originStability = await segmentOriginStability(h, materialSegment);
	const { SegmentForm } = await import("../src/Forms");
	const { OriginalCard } = await import("../src/segments/OriginalCard");
	const { ConfirmDialog } = await import("../src/Shared");
	const { container, mount, until, inputValue, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method !== "GET")
			throw new Error(
				`Material viewing must stay read-only: ${request.method} ${path}`,
			);
		if (path === "/api/segments/segment/translation-results")
			return Response.json([]);
		if (path === "/api/segments/segment/material-provenance")
			return Response.json({
				segment_id: "segment",
				status: "resolved",
				assembly_rule: "concat-nfc-v1",
				chapter_id: "chapter",
				title: "回归书籍",
				chapter_title: "第三章",
				display: "回归书籍 · 第三章 · 第 4—9 字",
				material_provenance: materialSegment.material_provenance ?? null,
				parts: [],
			} satisfies components["schemas"]["SegmentProvenanceResponse"]);
		throw new Error(
			`Unexpected material request ${request.method} ${request.url}`,
		);
	});
	let saved: SegmentFields | undefined;
	let dispose = await mount(
		<SegmentForm
			initial={materialSegment}
			pending={false}
			error={null}
			submitLabel="保存资料"
			onCancel={() => {}}
			onSave={(fields) => {
				saved = fields;
			}}
		/>,
	);
	try {
		await until(
			() => !!container.querySelector("form"),
			"Segment form must mount",
		);
		for (const removed of [
			"目标原文已固定，不能修改。可继续维护附带资料。",
			"前后文会提供给模型作为语境，不扩大目标原文范围。",
			"译文和听写会随问题提供给模型。",
			"文字出处会随问题提供给模型。",
			"仅用于自己管理，不提供给模型。",
		])
			check(
				!container.textContent?.includes(removed),
				`Removed field guidance remains: ${removed}`,
			);
		const byLabel = (text: string) => {
			const label = [...container.querySelectorAll("label")].find((node) =>
				node.textContent?.includes(text),
			);
			const control = label?.querySelector<
				HTMLInputElement | HTMLTextAreaElement
			>("input,textarea");
			check(control, `Missing editable field ${text}`);
			return control;
		};
		const original = [...container.querySelectorAll("label")]
			.find((node) => node.textContent?.includes("目标原文"))
			?.querySelector("textarea");
		if (refreshed) {
			check(
				!original,
				"Locked target must use readable static text instead of a disabled textarea",
			);
			check(
				container.querySelector(".segment-fixed-text")?.textContent ===
					materialSegment.text,
				"Fixed target text must remain complete",
			);
			const groups = [...container.querySelectorAll("fieldset legend")].map(
				(node) => node.textContent,
			);
			check(
				groups.join("|") === "原文与语境|译文与听写|出处与备注",
				"Editor must group original/context, translation/transcription and provenance/notes consistently",
			);
			const contexts = [
				...container.querySelectorAll<HTMLDetailsElement>(
					".segment-context-editor",
				),
			];
			check(
				contexts.length === 2 && contexts.every((node) => node.open),
				"Saved contexts must start expanded",
			);
			const fixed = container.querySelector(".segment-fixed-text");
			check(
				fixed &&
					contexts[0] &&
					contexts[1] &&
					Boolean(
						contexts[0].compareDocumentPosition(fixed) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					) &&
					Boolean(
						fixed.compareDocumentPosition(contexts[1]) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					),
				"Locked target must appear between before/after contexts",
			);
			const labels = [...container.querySelectorAll("label")]
				.filter((node) => node.querySelector("input,textarea"))
				.map((node) => node.querySelector("span")?.textContent?.trim());
			check(
				labels.join("|") === "前文|后文|译文|听写|出处补充|个人管理备注",
				`Edit field order changed: ${labels.join("|")}`,
			);
			await until(
				() =>
					container.textContent?.includes("回归书籍") === true &&
					container.textContent?.includes("第三章") === true,
				"Editing must display exact material origin",
			);
		}
		check(
			!original || original.disabled || original.readOnly,
			"Locked target must be protected",
		);
		const updates = [
			["前文", "修改前文"],
			["后文", "修改后文"],
			["译文", "修改译文"],
			["听写", "修改听写"],
			["出处补充", "修改出处"],
			["个人管理备注", "修改备注"],
		] as const;
		for (const [label, value] of updates) {
			const control = byLabel(label);
			check(
				!control.disabled && !control.readOnly,
				`${label} must remain editable when target is locked`,
			);
			inputValue(control, value);
			await until(() => control.value === value, `${label} edit must settle`);
		}
		container.querySelector<HTMLFormElement>("form")?.requestSubmit();
		await until(() => !!saved, "Segment form must submit");
		check(
			saved?.text === materialSegment.text,
			"Saving supplementary fields changed the locked target",
		);
		for (const [key, value] of Object.entries({
			context_before: "修改前文",
			context_after: "修改后文",
			translation: "修改译文",
			transcription: "修改听写",
			source_ref: "修改出处",
			note: "修改备注",
		}))
			check(saved?.[key as keyof SegmentFields] === value, `Save lost ${key}`);
	} finally {
		dispose();
	}
	let edited = false;
	dispose = await mount(
		<>
			<div id="segment-overlays" />
			<OriginalCard
				segment={materialSegment}
				onEdit={() => {
					edited = true;
				}}
			/>
		</>,
	);
	try {
		await until(
			() => !!container.querySelector(".segment-original-card"),
			"Original card must mount",
		);
		container
			.querySelector<HTMLButtonElement>("#segment-original-trigger")
			?.click();
		await until(
			() => !!container.querySelector("dialog[open]"),
			"Original card must open full material dialog",
		);
		const body = container.querySelector(".segment-material-body");
		check(body, "Missing complete materials body");
		for (const key of [
			"context_before",
			"text",
			"context_after",
			"translation",
			"transcription",
			"source_ref",
			"note",
		] as const)
			check(
				body.textContent?.includes(materialSegment[key]),
				`Full dialog omitted ${key}`,
			);
		if (refreshed) {
			const groups = [...body.querySelectorAll(".segment-material-group")].map(
				(node) => node.getAttribute("aria-label"),
			);
			check(
				groups.join("|") === "原文与语境|译文与听写|出处与备注",
				"Reader and editor groups must match",
			);
			const labels = [
				...body.querySelectorAll(".segment-material-field h4"),
			].map((node) => node.textContent);
			check(
				labels.join("|") ===
					"前文|目标原文|后文|译文|听写|出处补充|个人管理备注",
				`Read field order changed: ${labels.join("|")}`,
			);
			await until(
				() =>
					body.textContent?.includes("回归书籍") === true &&
					body.textContent?.includes("第三章") === true,
				"Viewing must display exact material origin",
			);
		}
		const edit = [...container.querySelectorAll("button")].find(
			(node) => node.textContent?.trim() === "编辑片段资料",
		);
		check(edit, "Missing edit materials action");
		edit.click();
		await until(
			() => edited && !container.querySelector("dialog[open]"),
			"Edit action must close reading dialog and hand off to editor",
		);
	} finally {
		dispose();
	}
	dispose = await mount(
		<>
			<div id="segment-overlays" />
			<OriginalCard
				segment={{
					...materialSegment,
					context_before: "",
					context_after: "",
					translation: "",
					transcription: "",
					source_ref: "",
					note: "",
					material_provenance: null,
				}}
				onEdit={() => {}}
			/>
		</>,
	);
	try {
		await until(
			() => !!container.querySelector(".segment-original-card"),
			"Minimal original card must mount",
		);
		container
			.querySelector<HTMLButtonElement>("#segment-original-trigger")
			?.click();
		await until(
			() => !!container.querySelector("dialog[open]"),
			"Minimal materials must open",
		);
		check(
			container.querySelectorAll(".segment-material-field").length === 1,
			"Empty optional fields must stay hidden",
		);
		check(
			container.querySelectorAll(".segment-material-group").length === 1,
			"Empty optional groups must stay hidden",
		);
	} finally {
		dispose();
	}
	dispose = await mount(
		<ConfirmDialog titleId="edit-materials-title" onClose={() => {}}>
			<h2 id="edit-materials-title">编辑片段资料</h2>
			<SegmentForm
				initial={{
					...materialSegment,
					context_before: "",
					context_after: "",
					material_provenance: null,
				}}
				pending={false}
				error={null}
				submitLabel="保存资料"
				onCancel={() => {}}
				onSave={() => {}}
			/>
		</ConfirmDialog>,
	);
	try {
		await until(
			() => !!container.querySelector("dialog[open]"),
			"Materials editor must open modal",
		);
		const first = container.querySelector<HTMLElement>(
			".segment-context-editor summary",
		);
		const last = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].at(-1);
		check(
			first && last && last.textContent?.trim() === "取消",
			"Expected collapsed before-context summary and final cancel button",
		);
		last.focus();
		const tab = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		last.dispatchEvent(tab);
		check(
			tab.defaultPrevented && document.activeElement === first,
			"Modal Tab must wrap from cancel to collapsed before-context summary",
		);
		const shiftTab = new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		first.dispatchEvent(shiftTab);
		check(
			shiftTab.defaultPrevented && document.activeElement === last,
			"Modal Shift+Tab must wrap from before-context summary to cancel",
		);
	} finally {
		dispose();
	}
	await segmentContentAggregation(h, speech);
	await segmentEditConflicts(h);
	return `segment materials: original/context/current translation/history aggregate; empty/retry/read-only/speech/provenance/narrow layout; seven-field dialog; sparse edits preserve concurrent fields; conflicts require fresh readable content and explicit confirmation; ${originStability}`;
}

async function segmentContentAggregation(
	h: BrowserHarness,
	utterances: SpeechSynthesisUtterance[],
	preview = false,
) {
	const { OriginalCard } = await import("../src/segments/OriginalCard");
	const { getSpeechController } = await import("../src/speech/browser");
	const { container, mount, until, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const provenance = materialSegment.material_provenance;
	check(provenance, "Translation fixture requires material provenance");
	const history: components["schemas"]["TranslationResultResponse"] = {
		id: "saved-history",
		task_id: "task",
		source_id: "source",
		material_id: "book",
		material_deleted: false,
		reader_deleted: false,
		material_provenance: provenance,
		identity_sha256: "c".repeat(64),
		text: materialSegment.text,
		translation: "历史机器译文，与人工采用文不同。",
		context_before: "历史前文。",
		context_after: "历史后文。",
		target_language: "简体中文",
		scheme_name: "历史翻译方案",
		model_id: "fixture-model",
		run_id: "fixture-run",
		created_at: materialSegment.created_at,
		adopted_segment_ids: [materialSegment.id],
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
	};
	const current = "  人工采用的 **字面文本**。\n第二行保留。  ";
	const scenarios = [
		{ name: "current-and-history", translation: current, records: true },
		{ name: "current-only", translation: current, records: false },
		{ name: "history-only", translation: "", records: true },
		{ name: "empty", translation: "", records: false },
		{ name: "whitespace", translation: " \n\t ", records: false },
		{ name: "read-failure", translation: current, records: true },
		{ name: "history-only-read-failure", translation: "", records: true },
		{ name: "manual", translation: current, records: false },
		{ name: "material-deleted", translation: current, records: true },
		{ name: "snapshot-mismatch", translation: current, records: true },
		{ name: "long-narrow", translation: current.repeat(20), records: true },
	];
	for (const scenario of scenarios) {
		getSpeechController().dismiss();
		const segment = {
			...materialSegment,
			translation: scenario.translation,
			...(scenario.name === "manual" ? { material_provenance: null } : {}),
			...(scenario.name === "long-narrow"
				? {
						text: "長い目標原文を最後まで確認する。".repeat(50),
						context_before: "長い前文。".repeat(40),
						context_after: "長い後文。".repeat(40),
						note: "長い個人管理備考。".repeat(80),
					}
				: {}),
		};
		let translationReads = 0;
		let failReads = scenario.name.includes("read-failure");
		const requests: Request[] = [];
		mock(async (request) => {
			requests.push(request);
			const path = new URL(request.url).pathname;
			check(
				request.method === "GET",
				`Reading ${scenario.name} must not write or generate: ${request.method} ${path}`,
			);
			if (path === "/api/segments/segment/translation-results") {
				translationReads++;
				return failReads
					? Response.json({ detail: "历史读取失败" }, { status: 500 })
					: Response.json(scenario.records ? [history] : []);
			}
			if (path === "/api/segments/segment/material-provenance")
				return Response.json({
					segment_id: "segment",
					status:
						scenario.name === "material-deleted"
							? "material_deleted"
							: scenario.name === "snapshot-mismatch"
								? "snapshot_mismatch"
								: "resolved",
					assembly_rule: "concat-nfc-v1",
					chapter_id: "chapter",
					title: "回归书籍",
					chapter_title: "第三章",
					display: "回归书籍 · 第三章 · 第 4—9 字",
					material_provenance: provenance,
					parts: [],
				} satisfies components["schemas"]["SegmentProvenanceResponse"]);
			throw new Error(`Unexpected aggregation request ${path}`);
		});
		const dispose = await mount(
			<div
				className="app-shell segment-study-shell"
				style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
			>
				<div style={{ width: preview ? 760 : 320, maxWidth: "100%" }}>
					<div id="segment-overlays" />
					<OriginalCard segment={segment} onEdit={() => {}} />
				</div>
			</div>,
		);
		try {
			check(
				translationReads === 0,
				`${scenario.name}: main card must not request associated translations`,
			);
			if (preview) return;
			const card = container.querySelector<HTMLElement>(
				".segment-original-card",
			);
			const trigger = container.querySelector<HTMLButtonElement>(
				"#segment-original-trigger",
			);
			check(
				card && trigger,
				`${scenario.name}: missing card or material trigger`,
			);
			check(
				card.tagName !== "BUTTON" && !card.hasAttribute("role"),
				"Original card must be a noninteractive content container",
			);
			check(
				(trigger.getAttribute("aria-label") ?? trigger.textContent?.trim()) ===
					"查看完整原文与资料" &&
					!trigger.querySelector("button") &&
					!card.querySelector("button button"),
				"Full materials and speech must have independent accessible buttons",
			);
			check(
				card.querySelector(".segment-original-focus")?.textContent ===
					segment.text &&
					card
						.querySelector(".segment-context-before")
						?.textContent?.includes(segment.context_before) &&
					card
						.querySelector(".segment-context-after")
						?.textContent?.includes(segment.context_after),
				`${scenario.name}: target/context preview lost saved text`,
			);
			const before = card.querySelector('[aria-label="已保存前文"]');
			const target = card.querySelector('[aria-label="目标原文"]');
			const after = card.querySelector('[aria-label="已保存后文"]');
			check(
				before &&
					target &&
					after &&
					Boolean(
						before.compareDocumentPosition(target) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					) &&
					Boolean(
						target.compareDocumentPosition(after) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					),
				"Saved contexts must be separately named before and after the target",
			);
			check(
				before.textContent === segment.context_before &&
					after.textContent === segment.context_after,
				"Context previews must show only saved text while retaining their accessible names",
			);
			const translation = card.querySelector(".segment-current-translation");
			check(
				Boolean(translation) === Boolean(scenario.translation.trim()),
				`${scenario.name}: current translation visibility must match saved content`,
			);
			if (translation) {
				check(
					(translation.querySelector("p") ?? translation).textContent ===
						scenario.translation,
					"Current manual translation must preserve whitespace and literal Markdown",
				);
				check(
					!translation.querySelector("strong"),
					"Current translation must stay plain text",
				);
			}
			check(
				!card.querySelector(".segment-translations"),
				"Main card must not display associated translation records",
			);
			if (!scenario.translation.trim())
				check(
					!card.querySelector(".segment-translation-area"),
					"Empty current translation must not leave a blank area in the card",
				);
			const speak = card.querySelector<HTMLButtonElement>(
				".device-speech-icon[aria-label='朗读原文']",
			);
			check(
				speak && !speak.disabled,
				"Card header speech must be reachable as an icon button",
			);
			const spoken = utterances.length;
			speak.click();
			await until(
				() => utterances.length === spoken + 1,
				"Card speech must reach mocked device",
			);
			check(
				utterances.at(-1)?.text === segment.text,
				"Speech must read only Segment target text",
			);
			check(
				!container.querySelector("dialog[open]"),
				"Speech must not open full materials",
			);
			getSpeechController().dismiss();
			trigger.focus();
			trigger.click();
			await until(
				() => !!container.querySelector("dialog[open]"),
				"Independent trigger must open full materials",
			);
			const body = container.querySelector<HTMLElement>(
				".segment-material-body",
			);
			check(body, "Complete materials body must exist");
			await until(
				() =>
					translationReads > 0 &&
					!body.querySelector(".segment-translation-area [role='status']"),
				`${scenario.name}: complete materials must read associated translations on demand`,
			);
			let records = body.querySelector<HTMLDetailsElement>(
				".segment-translations",
			);
			if (failReads) {
				check(
					Boolean(translation) === Boolean(scenario.translation.trim()),
					"History read failure must preserve the current translation state",
				);
				const retry = [...body.querySelectorAll("button")].find(
					(node) => node.textContent?.trim() === "重试读取",
				);
				check(retry, "History read failure must offer retry");
				if (records) records.open = true;
				failReads = false;
				retry.click();
				await until(
					() =>
						translationReads === 2 &&
						body.textContent?.includes(history.scheme_name) === true,
					"History read retry must recover associated results",
				);
				records = body.querySelector<HTMLDetailsElement>(
					".segment-translations",
				);
			}
			check(
				Boolean(records) === scenario.records,
				`${scenario.name}: associated history visibility must match saved records`,
			);
			if (records) {
				records.open = true;
				const item = records.querySelector<HTMLDetailsElement>("details");
				check(item, "Associated historical result must remain expandable");
				item.open = true;
				check(
					item.textContent?.includes(history.translation),
					"Opening history lost saved translation",
				);
				check(
					!item.querySelector("button") &&
						(translation?.querySelector("p") ?? translation)?.textContent ===
							(scenario.translation.trim() ? scenario.translation : undefined),
					"Reading historical result must preserve the current manual translation",
				);
			}
			check(
				body?.textContent?.includes(segment.text) &&
					body.textContent.includes(segment.note),
				"Full dialog must preserve complete target and notes",
			);
			if (scenario.name === "manual") {
				check(
					body.textContent?.includes(segment.source_ref),
					"Manual origin must remain readable",
				);
				check(
					!body.querySelector("a[href*='/materials/']"),
					"Manual origin must not invent a material destination",
				);
				check(
					!requests.some((request) =>
						request.url.endsWith("material-provenance"),
					),
					"Manual origin must not request material provenance",
				);
			}
			if (scenario.name === "current-and-history") {
				await until(
					() =>
						body.querySelector(".segment-material-origin-title")
							?.textContent === "回归书籍" &&
						body.querySelector(".segment-material-origin-chapter")
							?.textContent === "第三章",
					"Material origin must use separate structured title and chapter fields",
				);
				const origin = body.querySelector('[aria-label="材料出处"]');
				check(
					origin && !origin.textContent?.includes("第 4—9 字"),
					"Readable origin must not expose locator offsets from legacy display",
				);
				check(
					origin
						.querySelector(".segment-material-origin-link")
						?.textContent?.includes("在原文中定位"),
					"Material origin must retain its independent locate action",
				);
			}
			if (["material-deleted", "snapshot-mismatch"].includes(scenario.name)) {
				await until(
					() =>
						body.textContent?.includes(
							scenario.name === "material-deleted"
								? "原材料已删除"
								: "快照不一致",
						) === true,
					"Unavailable origin must explain the saved snapshot state",
				);
				check(
					!body.querySelector("a[href*='/materials/']"),
					"Unavailable provenance must not offer a false return link",
				);
			}
			if (scenario.name === "long-narrow") {
				const bounds = card.getBoundingClientRect();
				check(
					bounds.width <= 320 && card.scrollWidth <= card.clientWidth + 1,
					"Long original/current/history content must fit a narrow card",
				);
				check(
					body.scrollWidth <= body.clientWidth + 1,
					"Complete materials must wrap long text without horizontal scrolling",
				);
				body.scrollTop = body.scrollHeight;
				check(
					body.scrollTop > 0,
					"Long complete materials must remain vertically scrollable",
				);
			}
			container
				.querySelector<HTMLButtonElement>("[aria-label='关闭原文与资料']")
				?.click();
			await until(
				() =>
					!container.querySelector("dialog[open]") &&
					document.activeElement === trigger,
				"Closing complete materials must restore focus to its independent trigger",
			);
			check(
				requests.every((request) => request.method === "GET"),
				"Content browsing must not write or start a model call",
			);
		} finally {
			if (!preview) dispose();
			getSpeechController().dismiss();
		}
	}
}

async function segmentEditConflicts(h: BrowserHarness) {
	const { SegmentDetail } = await import("../src/SegmentPage");
	const { container, mount, until, inputValue, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const labels = {
		text: "目标原文",
		translation: "译文",
		context_before: "前文",
		context_after: "后文",
		transcription: "听写",
		source_ref: "出处说明",
		note: "个人管理备注",
	} as const;
	const button = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent?.trim() === label,
		);
	const field = (name: keyof typeof labels) => {
		const control = [...container.querySelectorAll("dialog label")]
			.find((node) => node.textContent?.trim().startsWith(labels[name]))
			?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
		check(control, `Missing draft field ${name}`);
		return control;
	};
	const confirmLabel = "已核对，允许按当前版本保存草稿";
	for (const scenario of ["preserve", "read-failure", ...Object.keys(labels)]) {
		let saved = {
			...materialSegment,
			material_provenance: null,
			text_locked_at:
				scenario === "preserve" || scenario === "text"
					? null
					: materialSegment.text_locked_at,
		};
		const patches: components["schemas"]["SegmentUpdate"][] = [];
		let readsFail = false;
		mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/segments/segment" && request.method === "PATCH") {
				const body: components["schemas"]["SegmentUpdate"] =
					await request.json();
				patches.push(body);
				if (body.expected_revision !== saved.revision)
					return Response.json(
						{ detail: "片段已改变，请核对当前内容" },
						{ status: 409 },
					);
				const { expected_revision: _revision, ...changes } = body;
				saved = { ...saved, ...changes, revision: saved.revision + 1 };
				return Response.json(saved);
			}
			if (path === "/api/segments/segment")
				return readsFail
					? Response.json({ detail: "无法读取当前内容" }, { status: 500 })
					: Response.json(saved);
			if (path === "/api/sources/source")
				return Response.json({
					id: "source",
					title: "来源",
					description: "",
					note: "",
					created_at: materialSegment.created_at,
					updated_at: materialSegment.updated_at,
				});
			if (
				path === "/api/segments/segment/analyses" ||
				path === "/api/segments/segment/translation-results"
			)
				return Response.json([]);
			throw new Error(
				`Unexpected segment edit request ${request.method} ${path}`,
			);
		});
		const dispose = await mount(
			<SegmentDetail />,
			"/segments/:id",
			"/segments/segment",
		);
		try {
			await until(
				() => !!container.querySelector("#segment-more-trigger"),
				"Segment detail must mount",
			);
			container
				.querySelector<HTMLButtonElement>("#segment-more-trigger")
				?.click();
			await until(() => !!button("编辑片段资料"), "Edit menu must open");
			button("编辑片段资料")?.click();
			await until(
				() => !!container.querySelector("dialog form"),
				"Segment detail editor must open",
			);
			const editedField =
				scenario === "preserve" || scenario === "read-failure"
					? "translation"
					: (scenario as keyof typeof labels);
			// Include explicit clearing: an empty changed field must remain present in PATCH.
			const draft = editedField === "text" ? "変更した原文。" : "";
			inputValue(field(editedField), draft);
			await until(
				() => field(editedField).value === draft,
				"Draft edit must settle",
			);
			saved = {
				...saved,
				note: "另一窗口的新备注",
				transcription: "另一窗口的新听写",
				source_ref: "另一窗口的新出处",
				revision: 8,
			};
			if (scenario === "preserve")
				saved = { ...saved, text: "另一窗口的新原文。" };
			if (scenario === "read-failure") readsFail = true;
			container.querySelector<HTMLFormElement>("dialog form")?.requestSubmit();
			await until(() => patches.length === 1, "First edit must reach API");
			check(
				Object.keys(patches[0] ?? {})
					.sort()
					.join("|") === [editedField, "expected_revision"].sort().join("|"),
				`Only changed ${editedField} may be submitted; got ${JSON.stringify(patches[0])}`,
			);
			if (scenario === "read-failure") {
				await until(
					() => !!button("重试读取当前内容"),
					"Failed current-content read must offer retry",
				);
				check(
					field(editedField).value === draft,
					"Current-content failure lost draft",
				);
				check(
					!button(confirmLabel) || button(confirmLabel)?.disabled,
					"Failed current-content read must not permit confirmation",
				);
				container
					.querySelector<HTMLFormElement>("dialog form")
					?.requestSubmit();
				await new Promise((resolve) => setTimeout(resolve, 40));
				check(
					patches.length === 1,
					"Unconfirmed conflict must not submit again",
				);
				readsFail = false;
				button("重试读取当前内容")?.click();
			}
			await until(
				() => !!button(confirmLabel) && !button(confirmLabel)?.disabled,
				"Fresh current content must enable confirmation",
			);
			const conflict = container.querySelector('[aria-label="当前已保存内容"]');
			check(conflict, "Conflict review must label the saved contents");
			for (const [name, label] of Object.entries(labels)) {
				if (name === "text" && saved.text_locked_at) continue;
				check(
					conflict.textContent?.includes(label),
					`Conflict review omitted ${label}`,
				);
				check(
					conflict.textContent?.includes(saved[name as keyof typeof labels]),
					`Conflict review omitted current ${name}`,
				);
			}
			button(confirmLabel)?.click();
			await until(
				() => !button(confirmLabel),
				"Confirmation must return to editable draft",
			);
			check(field(editedField).value === draft, "Confirmation lost draft");
			if (scenario === "preserve") {
				saved = { ...saved, note: "核对后再次更新的备注", revision: 9 };
				container
					.querySelector<HTMLFormElement>("dialog form")
					?.requestSubmit();
				await until(
					() => !!button(confirmLabel) && !button(confirmLabel)?.disabled,
					"Second concurrent edit must require another review",
				);
				await until(
					() =>
						container
							.querySelector('[aria-label="当前已保存内容"]')
							?.textContent?.includes(saved.note) === true,
					"Repeated conflict must display its new current contents",
				);
				button(confirmLabel)?.click();
				await until(
					() => !button(confirmLabel),
					"Second confirmation must settle",
				);
			}
			const beforeSave = { ...saved };
			container.querySelector<HTMLFormElement>("dialog form")?.requestSubmit();
			await until(
				() => !container.querySelector("dialog[open]"),
				"Confirmed edit must save and close",
			);
			check(
				saved[editedField] === draft,
				`Save lost explicit ${editedField} draft`,
			);
			for (const name of Object.keys(labels) as (keyof typeof labels)[])
				if (name !== editedField)
					check(
						saved[name] === beforeSave[name],
						`Save overwrote concurrent unedited ${name}`,
					);
			check(
				patches.at(-1)?.expected_revision === beforeSave.revision,
				"Retry must submit confirmed revision",
			);
		} finally {
			dispose();
		}
	}
}
