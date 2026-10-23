import { useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import type { components } from "../src/api/schema";
import type { StudyTarget } from "../src/materials/study-api";
import type { TranslationSession } from "../src/translation/state";
import type { BrowserHarness } from "./harness";

export async function translationRegression(h: BrowserHarness) {
	const { TranslationPanel } = await import(
		"../src/translation/TranslationPanel"
	);
	const { targetIdentity } = await import("../src/translation/state");
	const { container, mount, until, mock, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const reference: components["schemas"]["MaterialProvenance"] = {
		contract_version: "1",
		material_id: "book",
		version_id: "version",
		ranges: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 3,
				end: 6,
				exact: "猫だ。",
				text_sha256: "hash",
				prefix: "前文。",
				suffix: "後文。",
			},
		],
	};
	const target: StudyTarget = {
		reference,
		chapter: {
			id: "chapter",
			material_id: "book",
			version_id: "version",
			title: "章",
			level: 0,
			resources: [
				{
					id: "r",
					text: "前文。猫だ。後文。",
					text_sha256: "hash",
					href: "r.xhtml",
					css: "",
					body_attributes: {},
					html_attributes: {},
				},
			],
			parts: [
				{
					resource_id: "r",
					spine_index: 0,
					start: 0,
					end: 9,
					html: "",
					leaf_start: 0,
					leaf_end: 9,
				},
			],
		},
	};
	const result = {
		adopted_segment_ids: [],
		id: "a",
		task_id: "ta",
		source_id: "source",
		material_id: "book",
		material_deleted: false,
		material_provenance: reference,
		identity_sha256: await targetIdentity(reference),
		text: "猫だ。",
		translation: "这是一只猫。",
		context_before: "前文。",
		context_after: "",
		target_language: "简体中文",
		scheme_name: "独立翻译",
		model_id: "model",
		run_id: "run",
		created_at: "2026-10-23T01:00:00Z",
	};
	let generationCalls = 0;
	let releaseOld: ((response: Response) => void) | undefined;
	let selectedB = false;
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/settings/translation")
			return Response.json({
				id: "default",
				adapter: "llm",
				revision: 1,
				name: "独立翻译",
				model_id: "model",
				target_language: "简体中文",
				before_sentences: 3,
				after_sentences: 0,
				before_characters: 200,
				after_characters: 0,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (
			url.pathname === "/api/materials/book/translations" &&
			request.method === "POST"
		) {
			generationCalls++;
			throw new Error("Reading existing translations must never generate");
		}
		if (url.pathname === "/api/materials/book/translations")
			return Response.json({
				results: [
					selectedB
						? { ...result, id: "b", translation: "B 的现有译文。" }
						: result,
				],
				tasks: [],
				next_offset: null,
			});
		if (url.pathname === "/api/translation-results/a")
			return new Promise((resolve) => {
				releaseOld = resolve;
			});
		if (url.pathname === "/api/translation-results/b")
			return Response.json({
				...result,
				id: "b",
				translation: "B 的现有译文。",
			});
		throw new Error(
			`Unexpected translation request ${request.method} ${url.pathname}`,
		);
	});
	function Fixture() {
		const [key, setKey] = useState("a");
		return (
			<>
				<button
					type="button"
					onClick={() => {
						selectedB = true;
						setKey("b");
					}}
				>
					选择 B
				</button>
				<TranslationPanel
					key={key}
					sourceId="source"
					materialId="book"
					target={
						key === "a"
							? target
							: {
									...target,
									reference: {
										...reference,
										ranges: reference.ranges.map((r) => ({
											...r,
											spine_index: 1,
										})),
									},
								}
					}
					onClose={() => {}}
					onSaved={() => {}}
					onBackToOrigin={() => {}}
				/>
			</>
		);
	}
	const dispose = await mount(<Fixture />);
	try {
		await until(() => !!releaseOld, "A request must be in flight");
		[...container.querySelectorAll("button")]
			.find((b) => b.textContent === "选择 B")
			?.click();
		await until(
			() => container.textContent?.includes("B 的现有译文。") ?? false,
			"B should show its own existing result",
		);
		check(generationCalls === 0, "Reading existing result generated a task");
		releaseOld?.(Response.json(result));
		await new Promise((resolve) => setTimeout(resolve, 80));
		check(
			container.querySelector(".translation-output")?.textContent ===
				"B 的现有译文。",
			"Late A response replaced B",
		);
		const card = container.querySelector<HTMLElement>(".translation-card");
		check(card, "Card exists");
		check(
			card.getBoundingClientRect().right <= innerWidth,
			"Translation card overflows narrow screen",
		);
		check(
			card.getBoundingClientRect().width <= 430,
			"Translation card should stay compact",
		);
		// Continue with the atomic adoption and lost-response fixture after disposing this panel.
	} finally {
		dispose();
	}
	const { AdoptTranslation, createAdoptionSession } = await import(
		"../src/translation/AdoptTranslation"
	);
	const session = createAdoptionSession();
	const requests: components["schemas"]["TranslationAdopt"][] = [];
	let releaseAdoption: ((response: Response) => void) | undefined;
	const fullResult: components["schemas"]["TranslationResultResponse"] = {
		...result,
		chapter_id: "chapter",
		parts: [],
		scheme_id: "scheme",
		scheme_revision: 1,
		provider_name: "provider",
		protocol: "chat_completions",
		prompt_version: "translation-v1",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: 4000,
	};
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/material-provenance/matches"))
			return Response.json({ segments: [], truncated: false });
		if (url.pathname === "/api/translation-results/a/adopt") {
			const body =
				(await request.json()) as components["schemas"]["TranslationAdopt"];
			requests.push(body);
			if (requests.length === 1)
				return new Promise((resolve) => {
					releaseAdoption = resolve;
				});
			return Response.json({
				id: "adopt",
				result_id: "a",
				segment: {
					id: "saved",
					source_id: "source",
					text: result.text,
					translation: body.translation,
					revision: 1,
				},
			});
		}
		throw new Error(`Unexpected adoption request ${url.pathname}`);
	});
	let cleanup = await mount(
		<AdoptTranslation
			result={fullResult}
			session={session}
			onSaved={() => {}}
			onClose={() => {}}
		/>,
	);
	const click = (text: string) => {
		const button = [...container.querySelectorAll("button")].find(
			(node) => node.textContent === text,
		);
		check(button, `Missing ${text}`);
		button.click();
	};
	try {
		await until(
			() =>
				[...container.querySelectorAll("button")].some(
					(b) => b.textContent === "确认保存" && !b.disabled,
				),
			"Save form should load candidates",
		);
		const translation =
			container.querySelector<HTMLTextAreaElement>("textarea");
		check(translation, "Editable adoption copy exists");
		inputValue(translation, "编辑后的采用副本。");
		await new Promise((resolve) => setTimeout(resolve, 0));
		click("确认保存");
		await until(() => !!releaseAdoption, "Adoption request should be pending");
		cleanup();
		cleanup = await mount(
			<AdoptTranslation
				result={{ ...fullResult, adopted_segment_ids: ["server-associated"] }}
				session={session}
				onSaved={() => {}}
				onClose={() => {}}
			/>,
		);
		await until(
			() =>
				[...container.querySelectorAll("button")].some(
					(button) => button.textContent === "保存中…" && button.disabled,
				),
			"Reopened session must share pending state",
		);
		check(
			container.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
			"Pending adoption remount must keep editable copy locked",
		);
		releaseAdoption?.(Response.json({ detail: "响应未确认" }, { status: 500 }));
		await until(
			() => container.textContent?.includes("保存结果尚未核实") ?? false,
			"Late unknown response must notify reopened session",
		);
		await until(
			() =>
				[...container.querySelectorAll("button")].some(
					(b) => b.textContent === "核实保存" && !b.disabled,
				),
			"Reopened adoption keeps uncertain identity",
		);
		click("核实保存");
		await until(
			() => container.textContent?.includes("已保存学习片段。") ?? false,
			"Retry should recover saved destination",
		);
		check(
			requests.length === 2 &&
				requests[0]?.request_id === requests[1]?.request_id,
			"Lost-response retry changed request identity",
		);
		check(
			requests[1]?.translation === "编辑后的采用副本。",
			"Remount lost editable adoption copy",
		);
		check(
			result.translation === "这是一只猫。",
			"Adoption changed immutable result",
		);
		check(
			container.textContent?.includes("另存为新片段"),
			"Repeated save must first display destination and explicit separate-save action",
		);
	} finally {
		cleanup();
	}
	let releaseHistory: ((response: Response) => void) | undefined;
	let accepted: components["schemas"]["TranslationCreate"] | null = null;
	let starts = 0;
	let lookedUp = false;
	const queued = {
		id: "queued",
		source_id: "source",
		material_id: "book",
		status: "queued",
		result_id: null,
		run_id: null,
		error: null,
		text: "猫だ。",
		created_at: "2026-10-23T01:00:00Z",
		material_provenance: reference,
		context_before: "前文。",
		context_after: "",
	};
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/settings/translation")
			return Response.json({
				id: "default",
				adapter: "llm",
				revision: 1,
				name: "独立翻译",
				model_id: "model",
				target_language: "简体中文",
				before_sentences: 3,
				after_sentences: 0,
				before_characters: 200,
				after_characters: 0,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (
			url.pathname === "/api/materials/book/translations" &&
			request.method === "POST"
		) {
			starts++;
			accepted = await request.json();
			return Response.json(queued);
		}
		if (url.pathname === "/api/materials/book/translations") {
			if (!lookedUp) {
				lookedUp = true;
				return new Promise((resolve) => {
					releaseHistory = resolve;
				});
			}
			return Response.json({ results: [], tasks: [], next_offset: null });
		}
		if (url.pathname === "/api/translation-tasks/queued")
			return Response.json(queued);
		throw new Error(`Unexpected auto-start request ${url.pathname}`);
	});
	function AutoFixture() {
		const [visible, setVisible] = useState(true);
		return (
			<>
				<button type="button" onClick={() => setVisible((value) => !value)}>
					开关翻译卡
				</button>
				<div hidden={!visible}>
					<TranslationPanel
						autoStart
						visible={visible}
						materialId="book"
						sourceId="source"
						target={target}
						onClose={() => setVisible(false)}
						onSaved={() => {}}
						onBackToOrigin={() => {}}
					/>
				</div>
			</>
		);
	}
	cleanup = await mount(
		<StrictMode>
			<AutoFixture />
		</StrictMode>,
	);
	try {
		await until(
			() => !!releaseHistory,
			"Exact history lookup should precede generation",
		);
		check(starts === 0, "Generation must wait for history verification");
		releaseHistory?.(
			Response.json({ results: [], tasks: [], next_offset: null }),
		);
		await until(
			() => starts === 1,
			"Selection intent should automatically accept exactly one task",
		);
		check(
			(accepted as components["schemas"]["TranslationCreate"] | null)
				?.context_before === "前文。",
			"Auto-start raced context prefill",
		);
		click("开关翻译卡");
		await new Promise((resolve) => setTimeout(resolve, 0));
		click("开关翻译卡");
		await new Promise((resolve) => setTimeout(resolve, 60));
		check(
			Number(starts) === 1,
			"StrictMode/reopen repeated automatic generation",
		);
		check(
			!container.textContent?.includes("此处历史翻译（本页 0）"),
			"Empty history should not clutter card",
		);
	} finally {
		cleanup();
	}
	// One QueryClient survives target remounts, matching Reader's keyed card.
	for (const outcome of ["accepted", "lost"] as const) {
		const requests: components["schemas"]["TranslationCreate"][] = [];
		const sessions = new Map<string, TranslationSession>();
		const secondTarget: StudyTarget = {
			...target,
			chapter: {
				...target.chapter,
				parts: target.chapter.parts.map((part) => ({
					...part,
					spine_index: 1,
				})),
			},
			reference: {
				...reference,
				ranges: reference.ranges.map((range) => ({ ...range, spine_index: 1 })),
			},
		};
		const identityA = await targetIdentity(reference);
		let aReads = 0;
		let releaseRefresh: ((response: Response) => void) | undefined;
		let releaseSubmission: ((response: Response) => void) | undefined;
		let changedSettings = false;
		mock(async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/settings/translation")
				return Response.json({
					id: "default",
					adapter: "llm",
					revision: changedSettings ? 2 : 1,
					name: "独立翻译",
					model_id: "model",
					target_language: "简体中文",
					before_sentences: changedSettings ? 0 : 3,
					after_sentences: 0,
					before_characters: 200,
					after_characters: 0,
					max_context_characters: 2000,
					max_target_characters: 2000,
				});
			if (
				url.pathname === "/api/materials/book/translations" &&
				request.method === "POST"
			) {
				const body =
					(await request.json()) as components["schemas"]["TranslationCreate"];
				requests.push(body);
				if (outcome === "lost" && requests.length === 1)
					return new Promise((resolve) => {
						releaseSubmission = resolve;
					});
				return Response.json({
					...queued,
					id: `queued-${requests.length}`,
					material_provenance: body.material_provenance,
				});
			}
			if (url.pathname === "/api/materials/book/translations") {
				if (url.searchParams.get("identity_sha256") === identityA) {
					aReads++;
					if (aReads > 1 && outcome === "accepted")
						return new Promise((resolve) => {
							releaseRefresh = resolve;
						});
				}
				return Response.json({ results: [], tasks: [], next_offset: null });
			}
			if (url.pathname.startsWith("/api/translation-tasks/queued-"))
				return Response.json({ ...queued, id: url.pathname.split("/").at(-1) });
			throw new Error(
				`Unexpected session request ${request.method} ${url.pathname}`,
			);
		});
		function SessionFixture() {
			const [key, setKey] = useState("a");
			return (
				<>
					<button type="button" onClick={() => setKey("a")}>
						目标 A
					</button>
					<button type="button" onClick={() => setKey("b")}>
						目标 B
					</button>
					<TranslationPanel
						key={key}
						autoStart
						translationSessions={sessions}
						materialId="book"
						sourceId="source"
						target={key === "a" ? target : secondTarget}
						onClose={() => {}}
						onSaved={() => {}}
						onBackToOrigin={() => {}}
					/>
				</>
			);
		}
		cleanup = await mount(<SessionFixture />);
		try {
			await until(() => requests.length === 1, "A should submit once");
			if (outcome === "accepted")
				await until(
					() => !!releaseRefresh,
					"Accepted A should refresh history",
				);
			else
				await until(
					() => !!releaseSubmission,
					"First A submission should stay pending",
				);
			changedSettings = true;
			click("目标 B");
			await until(
				() => requests.length === 2,
				"B should have its own submission",
			);
			check(
				requests[1]?.material_provenance.ranges[0]?.spine_index === 1,
				"B submission used A's exact target",
			);
			click("目标 A");
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(
				requests.length === 2,
				`${outcome}: A→B→A created a duplicate request`,
			);
			if (outcome === "accepted") {
				releaseRefresh?.(
					Response.json({ results: [], tasks: [], next_offset: null }),
				);
				await new Promise((resolve) => setTimeout(resolve, 80));
				check(
					requests.length === 2,
					"Settled history refresh repeated accepted A",
				);
				check(
					container.textContent?.includes("等待翻译"),
					"A should restore its accepted task",
				);
			} else {
				check(
					container.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
					"Remounted pending A must keep inputs locked",
				);
				releaseSubmission?.(
					Response.json({ detail: "响应丢失" }, { status: 500 }),
				);
				await until(
					() => container.textContent?.includes("提交响应尚未核实") ?? false,
					"Late uncertain response must reach remounted A",
				);
				click("目标 B");
				await new Promise((resolve) => setTimeout(resolve, 20));
				click("目标 A");
				await until(
					() => container.textContent?.includes("提交响应尚未核实") ?? false,
					"Unknown identity must survive another target remount",
				);
				check(
					requests.length === 2,
					"Unknown submission retried without explicit verification",
				);
				click("核实原提交");
				await until(
					() => requests.length === 3,
					"Original A request should be verified explicitly",
				);
				check(
					JSON.stringify(requests[0]) === JSON.stringify(requests[2]),
					"Verification changed frozen UUID or input after settings update",
				);
				check(
					requests[0]?.request_id !== requests[1]?.request_id,
					"Targets shared a request identity",
				);
			}
		} finally {
			cleanup();
		}
	}
	let failedHistoryStarts = 0;
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/settings/translation")
			return Response.json({
				id: "default",
				adapter: "llm",
				revision: 1,
				name: "独立翻译",
				model_id: "model",
				target_language: "简体中文",
				before_sentences: 3,
				after_sentences: 0,
				before_characters: 200,
				after_characters: 0,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (request.method === "POST") {
			failedHistoryStarts++;
			return Response.json(queued);
		}
		return Response.json({ detail: "历史读取失败" }, { status: 503 });
	});
	const cachedIdentity = await targetIdentity(reference);
	function FailedHistoryFixture() {
		const client = useQueryClient();
		useState(() => {
			client.setQueryData(["translation-identity", reference], cachedIdentity);
			client.setQueryData(["translations", "book", cachedIdentity, 0], {
				results: [],
				tasks: [],
				next_offset: null,
			});
			return true;
		});
		return (
			<TranslationPanel
				autoStart
				materialId="book"
				sourceId="source"
				target={target}
				onClose={() => {}}
				onSaved={() => {}}
				onBackToOrigin={() => {}}
			/>
		);
	}
	cleanup = await mount(<FailedHistoryFixture />);
	try {
		await until(
			() => container.textContent?.includes("历史读取失败") ?? false,
			"History failure should remain visible",
		);
		await new Promise((resolve) => setTimeout(resolve, 60));
		check(
			failedHistoryStarts === 0,
			"Failed history must not create a translation",
		);
		check(
			![...container.querySelectorAll("button")].some(
				(button) => button.textContent === "开始翻译",
			),
			"Failed history exposed new generation",
		);
	} finally {
		cleanup();
	}
	for (const [firstPage, terminalStatus] of [
		["failed", "failed"],
		["succeeded", "failed"],
		["succeeded", "cancelled"],
	] as const) {
		let pagingPosts = 0;
		let lastOffset: number | null = null;
		mock(async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/settings/translation")
				return Response.json({
					id: "default",
					adapter: "llm",
					revision: 1,
					name: "独立翻译",
					model_id: "model",
					target_language: "简体中文",
					before_sentences: 3,
					after_sentences: 0,
					before_characters: 200,
					after_characters: 0,
					max_context_characters: 2000,
					max_target_characters: 2000,
				});
			if (
				url.pathname === "/api/materials/book/translations" &&
				request.method === "POST"
			) {
				pagingPosts++;
				return Response.json({ ...queued, status: "failed" });
			}
			if (url.pathname === "/api/materials/book/translations") {
				lastOffset = Number(url.searchParams.get("offset"));
				return Response.json(
					lastOffset === 0
						? {
								results: firstPage === "succeeded" ? [fullResult] : [],
								tasks:
									firstPage === "succeeded"
										? [{ ...queued, status: "succeeded", result_id: "a" }]
										: Array.from({ length: 15 }, (_, index) => ({
												...queued,
												id: `failed-${index}`,
												status: "failed",
											})),
								next_offset: 15,
							}
						: {
								results: [],
								tasks: [
									{ ...queued, id: "old-terminal", status: terminalStatus },
								],
								next_offset: null,
							},
				);
			}
			if (url.pathname === "/api/translation-results/a")
				return Response.json(fullResult);
			if (url.pathname.startsWith("/api/translation-tasks/"))
				return Response.json({ ...queued, status: "failed" });
			throw new Error(`Unexpected paging request ${url.pathname}`);
		});
		cleanup = await mount(
			<TranslationPanel
				autoStart
				materialId="book"
				sourceId="source"
				target={target}
				onClose={() => {}}
				onSaved={() => {}}
				onBackToOrigin={() => {}}
			/>,
		);
		try {
			await until(
				() =>
					[...container.querySelectorAll("button")].some(
						(button) => button.textContent === "下一页" && !button.disabled,
					),
				"Paged history should load",
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(
				pagingPosts === 0,
				`${firstPage}: incomplete first history page generated a translation`,
			);
			click("下一页");
			await until(
				() => lastOffset === 15,
				"Next page should read older history",
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(
				pagingPosts === 0,
				`${firstPage}→${terminalStatus}: browsing older history generated a translation`,
			);
			click("上一页");
			await until(
				() => lastOffset === 0,
				"Previous page should restore first history page",
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(
				pagingPosts === 0,
				"Returning to first history page generated a translation",
			);
		} finally {
			cleanup();
		}
	}
	const explicitRequests: components["schemas"]["TranslationCreate"][] = [];
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/settings/translation")
			return Response.json({
				id: "default",
				adapter: "llm",
				revision: 1,
				name: "独立翻译",
				model_id: "model",
				target_language: "简体中文",
				before_sentences: 3,
				after_sentences: 0,
				before_characters: 200,
				after_characters: 0,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (
			url.pathname === "/api/materials/book/translations" &&
			request.method === "POST"
		) {
			explicitRequests.push(await request.json());
			return Response.json({
				...queued,
				id: "failed-retranslation",
				status: "failed",
			});
		}
		if (url.pathname === "/api/materials/book/translations")
			return Response.json({
				results: [fullResult],
				tasks: [],
				next_offset: null,
			});
		if (url.pathname === "/api/translation-results/a")
			return Response.json(fullResult);
		if (url.pathname === "/api/translation-tasks/failed-retranslation")
			return Response.json({
				...queued,
				id: "failed-retranslation",
				status: "failed",
			});
		throw new Error(
			`Unexpected explicit retranslation request ${url.pathname}`,
		);
	});
	cleanup = await mount(
		<TranslationPanel
			autoStart
			materialId="book"
			sourceId="source"
			target={target}
			onClose={() => {}}
			onSaved={() => {}}
			onBackToOrigin={() => {}}
		/>,
	);
	try {
		await until(
			() => container.textContent?.includes(fullResult.translation) ?? false,
			"Existing result should load before explicit retranslation",
		);
		check(
			explicitRequests.length === 0,
			"Existing result automatically regenerated",
		);
		click("按当前语境重新翻译");
		await until(
			() => container.textContent?.includes("翻译失败") ?? false,
			"Explicit retranslation should settle",
		);
		await until(
			() =>
				[...container.querySelectorAll("button")].some(
					(button) =>
						button.textContent === "按当前语境重新翻译" && !button.disabled,
				),
			"Explicit retry should become available",
		);
		click("按当前语境重新翻译");
		await until(
			() => explicitRequests.length === 2,
			"Second explicit retranslation should be accepted",
		);
		check(
			explicitRequests[0]?.request_id !== explicitRequests[1]?.request_id,
			"Explicit retranslation reused a settled request identity",
		);
	} finally {
		cleanup();
	}
	const { TranslationSettingsSection } = await import(
		"../src/translation/TranslationSettings"
	);
	const { SettingsDraftProvider } = await import(
		"../src/settings/SettingsForms"
	);
	const defaults = {
		id: "default",
		adapter: "llm",
		revision: 1,
		name: "保留的方案名称",
		model_id: "model",
		target_language: "简体中文",
		before_sentences: 3,
		after_sentences: 0,
		before_characters: 200,
		after_characters: 0,
		max_context_characters: 2000,
		max_target_characters: 2000,
	};
	const newer = {
		...defaults,
		revision: 2,
		target_language: "韩语",
		before_sentences: 5,
		before_characters: 500,
	};
	const writes: components["schemas"]["TranslationSettingsUpdate"][] = [];
	let settingReads = 0;
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/providers")
			return Response.json([
				{
					id: "provider",
					name: "回归服务",
					enabled: true,
					models: [{ id: "model", model_id: "test-model", enabled: true }],
				},
			]);
		if (url.pathname === "/api/settings")
			return Response.json({ defaults: { chat_model_id: "model" } });
		if (
			url.pathname === "/api/settings/translation" &&
			request.method === "GET"
		) {
			settingReads++;
			if (settingReads === 1) return Response.json(defaults);
			if (settingReads === 2)
				return Response.json(
					{ detail: "当前设置读取失败，请重试。" },
					{ status: 503 },
				);
			return Response.json(newer);
		}
		if (
			url.pathname === "/api/settings/translation" &&
			request.method === "PUT"
		) {
			const body =
				(await request.json()) as components["schemas"]["TranslationSettingsUpdate"];
			writes.push(body);
			return writes.length === 1
				? Response.json({ detail: "翻译设置已更新" }, { status: 409 })
				: Response.json({ ...newer, ...body, revision: 3 });
		}
		throw new Error(
			`Unexpected settings request ${request.method} ${url.pathname}`,
		);
	});
	cleanup = await mount(
		<SettingsDraftProvider>
			<TranslationSettingsSection />
		</SettingsDraftProvider>,
	);
	try {
		await until(
			() => !!container.querySelector("form"),
			"Translation settings form should load",
		);
		check(
			!container.textContent?.includes("方案名称"),
			"Single default should not expose scheme naming",
		);
		await until(
			() => container.textContent?.includes("使用讨论模型") ?? false,
			"Available discussion model shortcut should show",
		);
		check(
			container
				.querySelector("option[value=model]")
				?.textContent?.includes("回归服务 / test-model"),
			"Model option must identify provider",
		);
		const language = [...container.querySelectorAll("label")]
			.find((label) => label.textContent?.includes("目标语言"))
			?.querySelector<HTMLInputElement>("input");
		check(language, "Language input exists");
		inputValue(language, "英语");
		await new Promise((resolve) => setTimeout(resolve, 0));
		click("保存翻译设置");
		await until(
			() =>
				container.textContent?.includes("翻译设置已在其他页面更新") ?? false,
			"409 should retain draft and require comparison",
		);
		check(language.value === "英语", "409 replaced local settings draft");
		click("读取当前设置（保留草稿）");
		await until(
			() =>
				container.textContent?.includes("当前设置读取失败，请重试。") ?? false,
			"Failed current-settings read should be visible and recoverable",
		);
		click("读取当前设置（保留草稿）");
		await until(
			() =>
				container.textContent?.includes("当前已保存配置（版本 2）") ?? false,
			"Current configuration must be visible before overwrite approval",
		);
		check(
			container.textContent?.includes("韩语") &&
				container.textContent?.includes("500 字符"),
			"Comparison should show current language and context",
		);
		check(
			language.value === "英语",
			"Reading current settings replaced the draft",
		);
		check(
			writes.length === 1,
			"Reading current revision must not submit a draft",
		);
		const regular = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "保存翻译设置",
		);
		check(
			regular?.disabled,
			"Normal save must stay blocked while conflict is unresolved",
		);
		click("按当前版本保存草稿");
		await until(
			() =>
				[...container.querySelectorAll('[role="status"]')].some(
					(node) => node.textContent === "已保存",
				),
			"Explicit overwrite should complete",
		);
		check(
			writes[1]?.expected_revision === 2 &&
				writes[1]?.target_language === "英语",
			"Explicit confirmation must submit the draft against shown current revision",
		);
		check(
			writes[1]?.name === "保留的方案名称",
			"Hidden scheme name must remain stored",
		);
	} finally {
		cleanup();
	}
	let restoredPosts = 0;
	const reopenedIds: string[] = [];
	const restoredResult = {
		...fullResult,
		adopted_segment_ids: ["saved-first", "saved-second"],
	};
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/settings/translation")
			return Response.json(defaults);
		if (url.pathname === "/api/materials/book/translations")
			return Response.json({
				results: [restoredResult],
				tasks: [],
				next_offset: null,
			});
		if (url.pathname === "/api/translation-results/a")
			return Response.json(restoredResult);
		if (url.pathname.endsWith("/material-provenance/matches"))
			return Response.json({ segments: [], truncated: false });
		if (url.pathname === "/api/translation-results/a/adopt") {
			restoredPosts++;
			const body = await request.json();
			return Response.json({
				id: "new-adoption",
				result_id: "a",
				segment: {
					id: "separate",
					source_id: "source",
					text: result.text,
					translation: body.translation,
					revision: 1,
				},
			});
		}
		throw new Error(
			`Unexpected restored-destination request ${request.method} ${url.pathname}`,
		);
	});
	const refreshed = () =>
		mount(
			<TranslationPanel
				materialId="book"
				sourceId="source"
				target={null}
				adoptionSessions={new Map()}
				onClose={() => {}}
				onSaved={() => {}}
				onOpenSegment={(id) => reopenedIds.push(id)}
				onBackToOrigin={() => {}}
			/>,
		);
	cleanup = await refreshed();
	try {
		await until(
			() => container.textContent?.includes("已保存到 2 个学习片段") ?? false,
			"Fresh reader session must recover exact result destinations",
		);
		check(
			![...container.querySelectorAll("button")].some(
				(button) => button.textContent === "保存为学习片段",
			),
			"Already adopted result should not offer immediate duplicate creation",
		);
		click("打开片段 2 →");
		check(
			reopenedIds[0] === "saved-second",
			"Multiple destinations should open the explicitly selected segment",
		);
		check(
			restoredPosts === 0,
			"Reading restored destinations must not adopt again",
		);
		cleanup();
		cleanup = await refreshed();
		await until(
			() => container.textContent?.includes("已保存到 2 个学习片段") ?? false,
			"Second refresh must preserve destination recovery without local session",
		);
		check(restoredPosts === 0, "New map refresh must not submit an adoption");
		click("另存为新片段");
		await until(
			() =>
				[...container.querySelectorAll("button")].some(
					(button) => button.textContent === "确认保存" && !button.disabled,
				),
			"Explicit separate-save should open an editable new draft",
		);
		click("确认保存");
		await until(
			() => container.textContent?.includes("已保存学习片段。") ?? false,
			"Explicit separate-save should persist a new destination",
		);
		check(
			Number(restoredPosts) === 1,
			"Only explicit separate-save may create a new segment",
		);
	} finally {
		cleanup();
	}
	return "translation: late isolation/history/no-generation; responsive layout; pending/lost adoption identity; automatic intent once under StrictMode/reopen and A→B→A with delayed history; pending/unknown translation UUID and frozen-input recovery; cached-history failure blocks generation; explicit retranslation uses new UUID; successful/failed/cancelled history paging and partial first page never generate; settings conflict comparison; fresh-map exact-result destination recovery without POST and explicit separate-save";
}
