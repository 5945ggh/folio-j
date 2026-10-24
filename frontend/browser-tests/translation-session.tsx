import { useState } from "react";
import type { components } from "../src/api/schema";
import type { StudyTarget } from "../src/materials/study-api";
import type { BrowserHarness } from "./harness";

/** A hidden floating card stays mounted while chapter records opens another host. */
export async function translationSessionRegression(h: BrowserHarness) {
	const { TranslationPanel } = await import(
		"../src/translation/TranslationPanel"
	);
	const { useTranslationSessions } = await import(
		"../src/translation/session-react"
	);
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
	for (const editedBefore of ["双宿主独特草稿", ""]) {
		const submissions: components["schemas"]["TranslationCreate"][] = [];
		h.mock(async (request) => {
			const url = new URL(request.url);
			const path = url.pathname;
			if (path === "/api/settings/translation")
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
				path === "/api/materials/book/translations" ||
				path === "/api/translation-tasks/dual-host-task"
			) {
				if (
					request.method === "POST" ||
					path === "/api/translation-tasks/dual-host-task"
				) {
					if (request.method === "POST") submissions.push(await request.json());
					return Response.json({
						id: "dual-host-task",
						source_id: "source",
						material_id: "book",
						material_provenance: reference,
						text: "猫だ。",
						context_before: editedBefore,
						context_after: "",
						created_at: "2026-10-24T00:00:00Z",
						status: "failed",
						result_id: null,
						run_id: null,
						error: "离线回归不执行模型",
					});
				}
				return Response.json({ results: [], tasks: [], next_offset: null });
			}
			throw new Error(`Unexpected dual-host request ${request.method} ${path}`);
		});
		function Fixture() {
			const sessions = useTranslationSessions();
			const [mode, setMode] = useState("floating");
			const props = {
				materialId: "book",
				sourceId: "source",
				target,
				translationSessions: sessions,
				onClose: () => {},
				onSaved: () => {},
				onBackToOrigin: () => {},
			};
			return (
				<>
					<button type="button" onClick={() => setMode("embedded")}>
						打开嵌入翻译
					</button>
					<button type="button" onClick={() => setMode("floating")}>
						重开浮动翻译
					</button>
					<div data-host="floating" hidden={mode !== "floating"}>
						<TranslationPanel {...props} visible={mode === "floating"} />
					</div>
					{mode === "embedded" && (
						<div data-host="embedded">
							<TranslationPanel {...props} embedded visible />
						</div>
					)}
				</>
			);
		}
		const dispose = await h.mount(<Fixture />);
		const before = (host: string) =>
			h.container.querySelector<HTMLTextAreaElement>(
				`[data-host="${host}"] textarea`,
			);
		const click = (text: string) => {
			const button = [...h.container.querySelectorAll("button")].find(
				(node) => node.textContent === text,
			);
			check(button && !button.disabled, `Missing enabled button ${text}`);
			button.click();
		};
		try {
			await h.until(
				() => before("floating")?.value === "前文。",
				"Original floating host must initialize context",
			);
			const originalField = before("floating");
			click("打开嵌入翻译");
			await h.until(
				() => before("embedded")?.value === "前文。",
				"Second host must initialize the same exact target",
			);
			const editable = before("embedded");
			check(editable, "Embedded context editor must exist");
			const embeddedDetails = editable.closest("details");
			if (embeddedDetails) embeddedDetails.open = true;
			h.inputValue(editable, editedBefore);
			await h.until(
				() => before("floating")?.value === editedBefore,
				"Embedded edit must update the mounted hidden host immediately",
			);
			const embeddedAfter = h.container.querySelectorAll<HTMLTextAreaElement>(
				'[data-host="embedded"] textarea',
			)[1];
			const embeddedBudget = h.container.querySelector<HTMLInputElement>(
				'[data-host="embedded"] input[type="number"]',
			);
			check(
				embeddedAfter && embeddedBudget,
				"Embedded host must expose after context and budget",
			);
			h.inputValue(embeddedAfter, "共享后文");
			h.inputValue(embeddedBudget, "2");
			await h.until(
				() =>
					h.container.querySelectorAll<HTMLTextAreaElement>(
						'[data-host="floating"] textarea',
					)[1]?.value === "共享后文" &&
					h.container.querySelector<HTMLInputElement>(
						'[data-host="floating"] input[type="number"]',
					)?.value === "2",
				"Both context sides and budget must propagate to the mounted hidden host",
			);
			check(
				editable.value === editedBefore,
				"Changing budget must preserve the manually edited context",
			);
			click("重开浮动翻译");
			await h.until(
				() =>
					!h.container.querySelector<HTMLElement>('[data-host="floating"]')
						?.hidden,
				"Original floating host must reopen",
			);
			check(
				before("floating") === originalField,
				"Reopening must retain the original mounted host",
			);
			check(
				before("floating")?.value === editedBefore,
				`Reopened floating host must show latest shared context ${JSON.stringify(editedBefore)}; saw ${JSON.stringify(before("floating")?.value)}`,
			);
			const floatingDetails = originalField?.closest("details");
			if (floatingDetails) floatingDetails.open = true;
			click("开始翻译");
			await h.until(
				() => submissions.length === 1,
				"Reopened host must submit once",
			);
			check(
				submissions[0]?.context_before === editedBefore,
				"Submission must use the latest shared context, including an explicit empty edit",
			);
			check(
				submissions[0]?.context_after === "共享后文",
				"Submission must read the shared after context",
			);
		} finally {
			dispose();
		}
	}
	await translationHostSelectionRegression(h, target);
}

async function translationHostSelectionRegression(
	h: BrowserHarness,
	target: StudyTarget,
) {
	const { TranslationPanel } = await import(
		"../src/translation/TranslationPanel"
	);
	const { useTranslationSessions } = await import(
		"../src/translation/session-react"
	);
	const { targetIdentity } = await import("../src/translation/state");
	const check: BrowserHarness["check"] = h.check;
	const latest: components["schemas"]["TranslationResultResponse"] = {
		id: "host-latest",
		task_id: "host-original-task",
		source_id: "source",
		material_id: "book",
		material_deleted: false,
		material_provenance: target.reference,
		identity_sha256: await targetIdentity(target.reference),
		text: "猫だ。",
		translation: "现有译文。",
		context_before: "前文。",
		context_after: "",
		target_language: "简体中文",
		scheme_name: "独立翻译",
		model_id: "model",
		run_id: "run",
		created_at: "2026-10-24T00:00:00Z",
		adopted_segment_ids: [],
		chapter_id: "chapter",
		parts: [],
		scheme_id: "default",
		scheme_revision: 1,
		provider_name: "离线回归",
		protocol: "chat_completions",
		prompt_version: "translation-v1",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: 1000,
	};
	const old = {
		...latest,
		id: "host-old",
		translation: "显式选择的旧译文。",
		created_at: "2026-10-23T00:00:00Z",
	};
	const newResult = {
		...latest,
		id: "host-new",
		task_id: "host-new-task",
		translation: "重新生成的新译文。",
	};
	for (const changeInitiatorSelection of [false, true]) {
		let releaseSubmission: ((response: Response) => void) | undefined;
		let posts = 0;
		const succeeded = {
			id: "host-new-task",
			source_id: "source",
			material_id: "book",
			material_provenance: target.reference,
			text: "猫だ。",
			context_before: "前文。",
			context_after: "",
			created_at: "2026-10-24T00:00:00Z",
			status: "succeeded",
			result_id: newResult.id,
			run_id: "new-run",
			error: null,
		};
		h.mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/settings/translation")
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
			if (path === "/api/materials/book/translations") {
				if (request.method === "POST") {
					posts++;
					return new Promise((resolve) => {
						releaseSubmission = resolve;
					});
				}
				const olderPage =
					new URL(request.url).searchParams.get("offset") === "15";
				return Response.json({
					results: olderPage ? [old] : [latest, old],
					tasks: [],
					next_offset: olderPage ? null : 15,
				});
			}
			if (path === "/api/translation-tasks/host-new-task")
				return Response.json(succeeded);
			const result = [latest, old, newResult].find(
				(item) => path === `/api/translation-results/${item.id}`,
			);
			if (result) return Response.json(result);
			throw new Error(
				`Unexpected independent-host request ${request.method} ${path}`,
			);
		});
		function Fixture() {
			const sessions = useTranslationSessions();
			const props = {
				materialId: "book",
				sourceId: "source",
				target,
				translationSessions: sessions,
				onClose: () => {},
				onSaved: () => {},
				onBackToOrigin: () => {},
			};
			return (
				<>
					<div data-host="initiator">
						<TranslationPanel {...props} />
					</div>
					<div data-host="observer">
						<TranslationPanel {...props} embedded />
					</div>
				</>
			);
		}
		const dispose = await h.mount(<Fixture />);
		const host = (name: string) => {
			const node = h.container.querySelector<HTMLElement>(
				`[data-host="${name}"]`,
			);
			check(node, `Missing translation host ${name}`);
			return node;
		};
		const output = (name: string) =>
			h.container.querySelector(`[data-host="${name}"] .translation-output`)
				?.textContent;
		const chooseOld = (name: string) => {
			const scope = host(name);
			const button = [
				...scope.querySelectorAll<HTMLButtonElement>(
					".translation-history-item",
				),
			].find((item) => item.textContent?.includes(old.translation));
			check(button, `Host ${name} must expose old result history`);
			const details = button.closest("details");
			if (details) details.open = true;
			button.click();
		};
		try {
			await h.until(
				() =>
					output("initiator") === latest.translation &&
					output("observer") === latest.translation,
				"Both hosts must load existing latest translation without generation",
			);
			chooseOld("observer");
			await h.until(
				() => output("observer") === old.translation,
				"Observer must explicitly select old result",
			);
			const translate = [
				...host("initiator").querySelectorAll<HTMLButtonElement>("button"),
			].find((item) => item.textContent === "按当前语境重新翻译");
			check(
				translate && !translate.disabled,
				"Initiating host must expose retranslation",
			);
			const details = translate.closest("details");
			if (details) details.open = true;
			translate.click();
			await h.until(
				() => !!releaseSubmission,
				"Retranslation must stay in flight while history remains selectable",
			);
			check(
				host("initiator").querySelector<HTMLTextAreaElement>("textarea")
					?.disabled,
				"Pending retranslation must lock its shared context draft",
			);
			check(
				posts === 1,
				"Two mounted hosts must issue only the initiating explicit request",
			);
			if (changeInitiatorSelection) {
				chooseOld("initiator");
				await h.until(
					() => output("initiator") === old.translation,
					"Initiator must be able to change viewed result during submission",
				);
			}
			releaseSubmission?.(Response.json(succeeded));
			if (!changeInitiatorSelection)
				await h.until(
					() => output("initiator") === newResult.translation,
					"Unchanged initiating view must follow its newly accepted task",
				);
			else {
				await h.until(
					() =>
						host("initiator").querySelector<HTMLTextAreaElement>("textarea")
							?.disabled === false,
					"Retranslation response must settle and unlock its shared context draft",
				);
				check(
					output("initiator") === old.translation,
					"Late accepted task must preserve initiator's newer explicit history choice",
				);
			}
			check(
				output("observer") === old.translation,
				"Another host's accepted task must preserve the observer's explicit old result",
			);
			check(
				posts === 1,
				"Choosing history during submission must never generate another task",
			);
			if (!changeInitiatorSelection) {
				const nextPage = [
					...host("initiator").querySelectorAll<HTMLButtonElement>("button"),
				].find((button) => button.textContent === "下一页");
				check(
					nextPage && !nextPage.disabled,
					"Accepted-task view must still expose history pagination",
				);
				nextPage.click();
				await h.until(
					() => output("initiator") === old.translation,
					"Browsing an older page must show that page's default result instead of the accepted task",
				);
				const observerTranslate = [
					...host("observer").querySelectorAll<HTMLButtonElement>("button"),
				].find((button) => button.textContent === "按当前语境重新翻译");
				check(
					observerTranslate && !observerTranslate.disabled,
					"Observer must be able to initiate its own explicit retranslation",
				);
				observerTranslate.click();
				await h.until(
					() => Number(posts) === 2,
					"Observer must submit exactly its new explicit retranslation",
				);
				releaseSubmission?.(Response.json(succeeded));
				await h.until(
					() => output("observer") === newResult.translation,
					"Second initiating host must follow its own accepted task",
				);
				check(
					output("initiator") === old.translation,
					"Another host's accepted task must not pull an older-page view away from its default result",
				);
			}
		} finally {
			dispose();
		}
	}
	await translationRecoveryViewRegression(h, target, latest, old);
}

async function translationRecoveryViewRegression(
	h: BrowserHarness,
	target: StudyTarget,
	latest: components["schemas"]["TranslationResultResponse"],
	old: components["schemas"]["TranslationResultResponse"],
) {
	const { TranslationPanel } = await import(
		"../src/translation/TranslationPanel"
	);
	const { useQueryClient } = await import("@tanstack/react-query");
	const check: BrowserHarness["check"] = h.check;
	const settings = {
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
	};
	const active: components["schemas"]["TranslationTaskResponse"] = {
		id: "view-active",
		source_id: "source",
		material_id: "book",
		material_provenance: target.reference,
		text: "猫だ。",
		context_before: "前文。",
		context_after: "",
		created_at: "2026-10-24T00:00:00Z",
		status: "queued",
		result_id: null,
		run_id: null,
		error: null,
	};
	const failed = {
		...active,
		id: "view-failed",
		status: "failed" as const,
		error: "旧任务失败",
	};
	const click = (label: string) => {
		const button = [
			...h.container.querySelectorAll<HTMLButtonElement>("button"),
		].find((item) => item.textContent === label);
		check(button && !button.disabled, `Missing enabled button ${label}`);
		const fold = button.closest("details");
		if (fold) fold.open = true;
		button.click();
	};
	let releaseFailed: ((response: Response) => void) | undefined;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings/translation") return Response.json(settings);
		if (path === "/api/materials/book/translations" && request.method === "GET")
			return Response.json({
				results: [],
				tasks: [active, failed],
				next_offset: null,
			});
		if (path === "/api/translation-tasks/view-active")
			return Response.json(active);
		if (path === "/api/translation-tasks/view-failed")
			return new Promise((resolve) => {
				releaseFailed = resolve;
			});
		throw new Error(`Unexpected recent-view request ${request.method} ${path}`);
	});
	let dispose = await h.mount(
		<TranslationPanel
			materialId="book"
			sourceId="source"
			target={null}
			onClose={() => {}}
			onSaved={() => {}}
			onBackToOrigin={() => {}}
		/>,
	);
	try {
		await h.until(
			() =>
				[...h.container.querySelectorAll("button")].some(
					(button) => button.textContent === "停止翻译",
				),
			"Recent list must initially expose the actual active task",
		);
		const failedChoice = [
			...h.container.querySelectorAll<HTMLButtonElement>(
				".translation-history-item",
			),
		].find((button) => button.textContent?.includes("failed"));
		check(failedChoice, "Recent history must expose the failed task choice");
		failedChoice.click();
		await h.until(
			() => !!releaseFailed,
			"Explicit failed-task detail must remain pending",
		);
		check(
			![...h.container.querySelectorAll("button")].some(
				(button) => button.textContent === "停止翻译",
			),
			"Pending selected failed task must not expose stop for a different active task",
		);
		check(
			!h.container.textContent?.includes("等待翻译…"),
			"Pending selected failed task must not fall back to another active task's status",
		);
		releaseFailed?.(
			Response.json({ detail: "旧任务读取失败" }, { status: 503 }),
		);
		await h.until(
			() => h.container.textContent?.includes("旧任务读取失败") ?? false,
			"Selected-task load failure must remain visible",
		);
		check(
			![...h.container.querySelectorAll("button")].some(
				(button) => button.textContent === "停止翻译",
			),
			"Failed selected-task read must not expose stop for another task",
		);
	} finally {
		dispose();
	}
	const requests: components["schemas"]["TranslationCreate"][] = [];
	let releaseOld: ((response: Response) => void) | undefined;
	let revealActive = false;
	let activeHistoryReads = 0;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings/translation") return Response.json(settings);
		if (path === "/api/materials/book/translations") {
			if (request.method === "POST") {
				requests.push(await request.json());
				return requests.length === 1
					? Response.json({ detail: "提交响应丢失" }, { status: 500 })
					: Response.json(failed);
			}
			if (revealActive) activeHistoryReads++;
			return Response.json({
				results: [latest, old],
				tasks: revealActive ? [active] : [],
				next_offset: null,
			});
		}
		if (path === `/api/translation-results/${latest.id}`)
			return Response.json(latest);
		if (path === `/api/translation-results/${old.id}`)
			return new Promise((resolve) => {
				releaseOld = resolve;
			});
		if (path === "/api/translation-tasks/view-failed")
			return Response.json(failed);
		if (path === "/api/translation-tasks/view-active")
			return Response.json(active);
		throw new Error(
			`Unexpected uncertain-view request ${request.method} ${path}`,
		);
	});
	function UncertainFixture() {
		const client = useQueryClient();
		return (
			<>
				<button
					type="button"
					onClick={() => {
						revealActive = true;
						void client.invalidateQueries({
							queryKey: ["translations", "book"],
						});
					}}
				>
					刷新活动事实
				</button>
				<TranslationPanel
					materialId="book"
					sourceId="source"
					target={target}
					onClose={() => {}}
					onSaved={() => {}}
					onBackToOrigin={() => {}}
				/>
			</>
		);
	}
	dispose = await h.mount(<UncertainFixture />);
	const verify = () =>
		[...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "核实原提交",
		);
	try {
		await h.until(
			() =>
				h.container.querySelector(".translation-output")?.textContent ===
				latest.translation,
			"Uncertain-view fixture must begin at a saved result",
		);
		click("按当前语境重新翻译");
		await h.until(
			() => h.container.textContent?.includes("提交响应尚未核实") ?? false,
			"Lost submission must expose verification",
		);
		const oldChoice = [
			...h.container.querySelectorAll<HTMLButtonElement>(
				".translation-history-item",
			),
		].find((button) => button.textContent?.includes(old.translation));
		check(
			oldChoice && !oldChoice.disabled,
			"Uncertain submission must allow browsing an old result",
		);
		oldChoice.click();
		await h.until(
			() => !!releaseOld,
			"Old result read must remain pending while submission is uncertain",
		);
		check(
			verify() && !verify()?.disabled,
			"Pending old result must not disable verification of a frozen submission",
		);
		releaseOld?.(Response.json({ detail: "旧译文读取失败" }, { status: 503 }));
		await h.until(
			() => h.container.textContent?.includes("旧译文读取失败") ?? false,
			"Old result read failure must remain visible",
		);
		check(
			verify() && !verify()?.disabled,
			"Failed old result read must not disable submission verification",
		);
		click("刷新活动事实");
		await h.until(
			() => activeHistoryReads > 0 && !!verify() && !verify()?.disabled,
			"A newly observed active task must not hide uncertain submission verification",
		);
		click("核实原提交");
		await h.until(
			() => requests.length === 2,
			"Verification must resend the original frozen request despite unavailable old result and active history",
		);
		check(
			JSON.stringify(requests[0]) === JSON.stringify(requests[1]),
			"Recovery from an unrelated old-result read failure must preserve complete frozen input and UUID",
		);
	} finally {
		dispose();
	}
}
