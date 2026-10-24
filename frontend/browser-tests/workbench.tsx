import { useState } from "react";
import type { components } from "../src/api/schema";
import type { Job, JobInput, Thread } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";

type Schema = components["schemas"];
const timestamp = "2026-10-23T00:00:00Z";
export const settings: Schema["SettingsResponse"] = {
	defaults: {
		analysis_model_id: "model",
		chat_model_id: "model",
		extraction_model_id: null,
		permission_mode: "review",
		style_id: "style",
	},
	profile: {
		explain_language: "中文",
		native_language: "中文",
		level_note: "N2",
	},
	styles: [
		{
			id: "style",
			name: "回归预设",
			body_md: "简洁说明",
			created_at: timestamp,
			updated_at: timestamp,
		},
	],
};
export const provider: Schema["ProviderResponse"] = {
	id: "provider",
	name: "离线提供商",
	protocol: "responses",
	base_url: "https://example.invalid",
	enabled: true,
	has_api_key: true,
	created_at: timestamp,
	updated_at: timestamp,
	revision: 1,
	discovered_models: [],
	discovery_status: "never",
	discovery_error: null,
	last_discovered_at: null,
	models: ["model", "model-two", "disabled-model"].map((id) => ({
		id,
		provider_id: "provider",
		model_id:
			id === "model"
				? "offline-model"
				: id === "model-two"
					? "second-model"
					: "disabled-model",
		enabled: id !== "disabled-model",
		effective_protocol: "responses",
		revision: 1,
		stream_status: "succeeded",
		text_status: "succeeded",
		stream_verification: null,
		text_verification: null,
	})),
};
export const makeThread = (): Thread => ({
	id: "thread",
	segment_id: "segment",
	display_title: "回归讨论",
	selected_model_id: "model",
	permission_mode: "review",
	revision: 3,
	active_job_id: null,
	created_at: timestamp,
	updated_at: timestamp,
});
export function makeJob(status: Job["status"]): Job {
	return {
		id: "job",
		thread_id: "thread",
		request_id: "request",
		kind: "chat",
		question: "原问题",
		additional_instructions: "原补充",
		permission_mode: "review",
		version: 1,
		status,
		user_message_id: "user",
		assistant_message: {
			id: "assistant",
			thread_id: "thread",
			job_id: "job",
			ordinal: 2,
			role: "assistant",
			status:
				status === "failed"
					? "failed"
					: status === "succeeded"
						? "complete"
						: "streaming",
			content: "助手的完整离线回答。",
			created_at: timestamp,
			updated_at: timestamp,
		},
		created_at: timestamp,
		started_at: timestamp,
		finished_at: null,
		stop_requested_at: null,
		run_id: "run",
		error: status === "failed" ? "离线模拟生成失败" : null,
		error_code: null,
		artifacts: [],
		model: {
			provider_id: "provider",
			provider_name: "离线提供商",
			provider_revision: 1,
			model_id: "model",
			model_revision: 1,
			provider_model_id: "offline-model",
			protocol: "responses",
			stream: true,
			max_output_tokens: null,
			reasoning_effort: null,
			temperature: null,
		},
	};
}

export async function workbenchRegression(h: BrowserHarness, refreshed = true) {
	const { Workbench } = await import("../src/chat/Workbench");
	const { container, mount, until, inputValue, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const find = <T extends Element>(selector: string): T => {
		const node = container.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const button = (label: string) => {
		const node = [...container.querySelectorAll("button")].find(
			(node) =>
				node.textContent?.trim() === label ||
				node.getAttribute("aria-label") === label,
		);
		check(node, `Missing button ${label}`);
		return node;
	};
	const popover = (label: string) =>
		find<HTMLElement>(`.chat-setting-popover[aria-label="${label}"]`);
	const modelChoice = (id: string) =>
		find<HTMLInputElement>(`input[type="radio"][data-model-id="${id}"]`);
	const permissionChoice = (mode: Thread["permission_mode"]) =>
		find<HTMLInputElement>(
			`input[type="radio"][data-permission-mode="${mode}"]`,
		);
	const openSetting = async (trigger: string, label: string) => {
		const composerHeight =
			find<HTMLElement>(".chat-composer").getBoundingClientRect().height;
		const historyHeight =
			find<HTMLElement>(".chat-history").getBoundingClientRect().height;
		button(trigger).focus();
		button(trigger).click();
		await until(
			() => popover(label).matches(":popover-open"),
			`${label} must open from its own button`,
		);
		check(
			container.querySelectorAll(".chat-setting-popover:popover-open")
				.length === 1,
			"Only one setting popover may be open",
		);
		check(
			Math.abs(
				find<HTMLElement>(".chat-composer").getBoundingClientRect().height -
					composerHeight,
			) < 1,
			"Opening settings must not enlarge the composer",
		);
		check(
			Math.abs(
				find<HTMLElement>(".chat-history").getBoundingClientRect().height -
					historyHeight,
			) < 1,
			"Opening settings must not squeeze message history",
		);
		const rect = popover(label).getBoundingClientRect();
		check(
			rect.left >= -1 &&
				rect.right <= window.innerWidth + 1 &&
				rect.width <= 322,
			`${label} must fit the narrow viewport`,
		);
		check(
			popover(label).scrollWidth <= popover(label).clientWidth + 1,
			`${label} must not have horizontal overflow`,
		);
	};
	const closeSetting = async (trigger: string, label: string) => {
		button(trigger).click();
		await until(
			() => !popover(label).matches(":popover-open"),
			`${label} must close from its button`,
		);
		await until(
			() => document.activeElement === button(trigger),
			`${label} must return focus to its trigger when closed`,
		);
	};
	let thread = makeThread();
	let job: Job | null = null;
	let submitted: JobInput | undefined;
	let submissionCount = 0;
	let patched: Record<string, unknown>[] = [];
	let decision: Schema["JobDecision"] | undefined;
	let openedArtifact = "";
	let stopCount = 0;
	let failSubmission = true;
	const setupMock = () =>
		mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/settings") return Response.json(settings);
			if (path === "/api/providers") return Response.json([provider]);
			if (path === "/api/segments/segment/threads")
				return Response.json({ items: [thread], next_cursor: null });
			if (path === "/api/threads/thread" && request.method === "PATCH") {
				const body: Record<string, unknown> = await request.json();
				patched.push(body);
				thread = {
					...thread,
					revision: thread.revision + 1,
					...(typeof body.model_id === "string"
						? { selected_model_id: body.model_id }
						: {}),
					...(body.permission_mode === "full_access"
						? { permission_mode: "full_access" }
						: {}),
				};
				return Response.json(thread);
			}
			if (path === "/api/threads/thread") return Response.json(thread);
			if (path === "/api/threads/thread/messages")
				return Response.json({
					items: job
						? [
								{
									id: "user",
									thread_id: "thread",
									job_id: "job",
									ordinal: 1,
									role: "user",
									status: "complete",
									content: job.question,
									created_at: timestamp,
									updated_at: timestamp,
								},
								{
									...job.assistant_message,
									job_summary: {
										artifacts: job.artifacts,
										error: job.error,
										retry: {
											question: job.question,
											additional_instructions: job.additional_instructions,
										},
									},
								},
							]
						: [],
					next_cursor: null,
				});
			if (path === "/api/threads/thread/jobs" && request.method === "POST") {
				submissionCount++;
				submitted = await request.json();
				if (failSubmission)
					return Response.json({ detail: "离线拒绝提交" }, { status: 422 });
				job = {
					...makeJob("running"),
					question: submitted?.question ?? "",
					additional_instructions: submitted?.additional_instructions ?? "",
					request_id: submitted?.request_id ?? "",
				};
				thread = {
					...thread,
					revision: thread.revision + 1,
					active_job_id: job.id,
				};
				return Response.json(job);
			}
			if (path === "/api/jobs/job/stop") {
				stopCount++;
				check(job, "Stop requires a job");
				job = { ...job, status: "stopping", version: job.version + 1 };
				return Response.json(job);
			}
			if (path === "/api/jobs/job/decision") {
				decision = await request.json();
				check(job, "Decision requires a job");
				job = {
					...job,
					status: "running",
					version: job.version + 1,
					review_proposal: null,
				};
				return Response.json(job);
			}
			if (path === "/api/jobs/job" && job) return Response.json(job);
			if (path === "/api/analyses/analysis")
				return Response.json({
					id: "analysis",
					segment_id: "segment",
					title: "已有讲解",
					revision_id: "base-revision",
					current_revision_id: "base-revision",
					parent_revision_id: null,
					source_md: "旧开头",
					sections: [],
					excerpt: "",
					normalizer_version: 1,
					origin: "manual",
					run_id: null,
					warnings: [],
					created_at: timestamp,
					updated_at: timestamp,
				} satisfies Schema["AnalysisDetail"]);
			throw new Error(`Unexpected Workbench request ${request.method} ${path}`);
		});
	function Screen() {
		const [selected, setSelected] = useState<string | null>("thread");
		return (
			<div style={{ height: "700px", background: "#fff", maxWidth: "100%" }}>
				<Workbench
					segment={materialSegment}
					generateToken={null}
					selectedThreadId={selected}
					onSelectThread={setSelected}
					onGenerationAccepted={() => {}}
					onSubmissionStarted={() => {}}
					onJobAccepted={() => {}}
					onOpenArtifact={(analysis, revision) => {
						openedArtifact = `${analysis}/${revision}`;
					}}
				/>
			</div>
		);
	}
	setupMock();
	let dispose = await mount(<Screen />);
	try {
		await until(
			() =>
				!!container.querySelector("#chat-question") &&
				button("选择模型").textContent?.includes("offline-model") === true,
			"Discussion must load settings and model",
		);
		const pressEnter = (options: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
				...options,
			});
			find("#chat-question").dispatchEvent(event);
			return event;
		};
		check(pressEnter().defaultPrevented, "Empty Enter must not add a newline");
		check(submissionCount === 0, "Empty Enter must not submit a job");
		inputValue(find("#chat-question"), "请解释这个语气");
		await until(
			() =>
				find<HTMLTextAreaElement>("#chat-question").value === "请解释这个语气",
			"Question edit must settle",
		);
		for (const options of [
			{ shiftKey: true },
			{ ctrlKey: true },
			{ altKey: true },
			{ metaKey: true },
			{ isComposing: true },
			{ keyCode: 229 },
		])
			check(
				!pressEnter(options).defaultPrevented,
				"Modified Enter and IME confirmation must retain native input behavior",
			);
		check(
			pressEnter({ repeat: true }).defaultPrevented,
			"Held Enter must not insert a newline or repeatedly send",
		);
		check(
			submissionCount === 0 &&
				find<HTMLTextAreaElement>("#chat-question").value === "请解释这个语气",
			"Line breaks, IME confirmation and held Enter must preserve the draft without submitting",
		);
		check(
			find(".chat-config").tagName !== "DETAILS",
			"Composer settings must be independent buttons, not one disclosure",
		);
		check(
			container.querySelectorAll(".chat-setting-popover[popover='auto']")
				.length === 2,
			"Only model and permission controls should remain in the composer",
		);
		check(
			button("选择模型").textContent?.includes("offline-model") &&
				button("设置审核模式").textContent?.includes("审核模式"),
			"Current model and permission must remain visible before opening settings",
		);
		check(
			!container.querySelector(
				'#chat-additional, .chat-setting-popover[aria-label="本轮要求"]',
			),
			"Round requirements controls must be removed",
		);
		check(
			!container.querySelector('button[aria-label="本轮要求"]'),
			"Round requirements button must be removed",
		);
		inputValue(find("#chat-question"), "请解释这个语气，保留日语例句");
		await until(
			() =>
				find<HTMLTextAreaElement>("#chat-question").value ===
				"请解释这个语气，保留日语例句",
			"Inline instructions must remain in the visible question",
		);
		await openSetting("选择模型", "模型设置");
		check(
			!popover("模型设置").querySelector("select"),
			"Model popover must show options directly without a nested select",
		);
		check(
			modelChoice("model").checked && !modelChoice("model-two").checked,
			"Opening model choices must show the selected model directly",
		);
		for (const id of ["model", "model-two"]) {
			const choice = modelChoice(id);
			const label = choice.closest("label.chat-choice");
			check(
				label &&
					label.getBoundingClientRect().height > 0 &&
					label.textContent?.includes("离线提供商"),
				`Model ${id} must be visible with its provider`,
			);
		}
		const disabled = popover("模型设置").querySelector<HTMLInputElement>(
			'input[data-model-id="disabled-model"]',
		);
		check(
			!disabled || disabled.disabled,
			"Disabled models must not be selectable",
		);
		if (disabled) {
			disabled.click();
			check(
				patched.length === 0,
				"Disabled model choice must not patch thread",
			);
		}
		await openSetting("设置审核模式", "审核模式");
		check(
			!popover("审核模式").querySelector("select"),
			"Permission popover must show options directly without a nested select",
		);
		check(
			permissionChoice("review").checked &&
				!permissionChoice("full_access").checked &&
				permissionChoice("full_access").getBoundingClientRect().height > 0,
			"Opening permissions must directly show both choices and the selected mode",
		);
		check(
			!popover("模型设置").matches(":popover-open"),
			"Switching to permissions must close the model popover",
		);
		await closeSetting("设置审核模式", "审核模式");
		button("返回对话列表").click();
		await until(
			() => !find<HTMLElement>(".chat-list-view").hidden,
			"Back action must show list",
		);
		check(
			container.textContent?.includes("有草稿"),
			"List must mark saved local drafts",
		);
		const newThread = button("新建对话");
		check(
			newThread.classList.contains("chat-icon-button") &&
				newThread.title === "新建对话" &&
				newThread.dataset.tooltip === "新建对话" &&
				!newThread.textContent?.includes("新建对话"),
			"New discussion must use an accessible icon button with its tooltip",
		);
		find<HTMLButtonElement>(".chat-thread").click();
		await until(
			() => !find<HTMLElement>(".chat-detail-view").hidden,
			"Thread must reopen",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question").value ===
				"请解释这个语气，保留日语例句",
			"List/detail switch lost the visible question and inline instructions",
		);
		await openSetting("选择模型", "模型设置");
		modelChoice("model-two").click();
		await until(
			() =>
				patched.length === 1 &&
				modelChoice("model-two").checked &&
				!modelChoice("model-two").disabled &&
				!popover("模型设置").matches(":popover-open"),
			"One model click must persist selection and close its popover",
		);
		await openSetting("选择模型", "模型设置");
		modelChoice("model-two").click();
		await until(
			() => !popover("模型设置").matches(":popover-open"),
			"Selecting the current model must close its popover",
		);
		check(
			Number(patched.length) === 1,
			"Selecting the current model must not patch thread again",
		);
		await openSetting("设置审核模式", "审核模式");
		permissionChoice("full_access").click();
		await until(
			() =>
				patched.length === 2 &&
				permissionChoice("full_access").checked &&
				!permissionChoice("full_access").disabled &&
				!popover("审核模式").matches(":popover-open"),
			"One permission click must persist selection and close its popover",
		);
		await openSetting("设置审核模式", "审核模式");
		permissionChoice("full_access").click();
		await until(
			() => !popover("审核模式").matches(":popover-open"),
			"Selecting current permissions must close its popover",
		);
		check(
			Number(patched.length) === 2,
			"Selecting current permissions must not patch thread again",
		);
		check(
			patched[0]?.expected_revision === 3 &&
				patched[0]?.model_id === "model-two",
			"Model patch lost expected revision",
		);
		check(
			patched[1]?.expected_revision === 4 &&
				patched[1]?.permission_mode === "full_access",
			"Permission patch lost expected revision",
		);
		await openSetting("选择模型", "模型设置");
		find<HTMLInputElement>(".chat-stream-choice input").click();
		await until(
			() => !find<HTMLInputElement>(".chat-stream-choice input").checked,
			"Stream choice must update",
		);
		await closeSetting("选择模型", "模型设置");
		button("发送问题").click();
		await until(
			() => container.textContent?.includes("离线拒绝提交") === true,
			"Rejected submission must be visible",
		);
		check(
			submitted?.question === "请解释这个语气，保留日语例句" &&
				submitted.additional_instructions === "" &&
				!Object.hasOwn(submitted, "style_id") &&
				submitted.stream === false &&
				submitted.expected_thread_revision === 5 &&
				submitted.expected_segment_revision === 7 &&
				!!submitted.request_id,
			"Job payload changed question, additional instructions, settings or optimistic revisions",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question").value ===
				"请解释这个语气，保留日语例句",
			"Definite submission failure lost draft",
		);
		failSubmission = false;
		check(pressEnter().defaultPrevented, "Enter must send without a newline");
		await until(
			() => !!job && permissionChoice("full_access").disabled,
			"Accepted running job must lock permission controls",
		);
		check(
			modelChoice("model").disabled &&
				modelChoice("model-two").disabled &&
				permissionChoice("review").disabled &&
				find<HTMLInputElement>(".chat-stream-choice input").disabled &&
				button("发送问题").disabled,
			"Busy job must prevent settings mutation and duplicate submission",
		);
		inputValue(find("#chat-question"), "下一轮草稿");
		await until(
			() => find<HTMLTextAreaElement>("#chat-question").value === "下一轮草稿",
			"Busy discussion must allow the next draft",
		);
		const countBeforeBusyEnter = submissionCount;
		check(pressEnter().defaultPrevented, "Busy Enter must not add a newline");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		check(
			submissionCount === countBeforeBusyEnter &&
				find<HTMLTextAreaElement>("#chat-question").value === "下一轮草稿",
			"Busy Enter must preserve the draft without submitting another job",
		);
		if (refreshed) {
			check(
				popover("模型设置").contains(modelChoice("model")) &&
					popover("模型设置").contains(find(".chat-stream-choice input")),
				"Model settings must include stream choice",
			);
			check(
				popover("审核模式").contains(permissionChoice("review")),
				"Permission must have its own popover",
			);
			check(
				button("选择模型").textContent?.includes("second-model") &&
					button("设置审核模式").textContent?.includes("Full access"),
				"Independent buttons must expose current model and permission",
			);
			const reference = find<HTMLDetailsElement>(".chat-reference");
			check(!reference.open, "Saved context must start collapsed");
			reference.open = true;
			check(
				reference.textContent?.includes(materialSegment.text) &&
					reference.textContent.includes(materialSegment.context_before) &&
					reference.textContent.includes(materialSegment.context_after),
				"Context disclosure must preserve original and both contexts",
			);
			reference.open = false;

			const assistant = find<HTMLElement>(
				'.chat-message[aria-label="助手消息"]',
			);
			const user = find<HTMLElement>('.chat-message[aria-label="你的消息"]');
			check(
				(() => {
					let node: HTMLElement | null = assistant;
					while (node) {
						const background = getComputedStyle(node).backgroundColor;
						if (
							background !== "rgba(0, 0, 0, 0)" &&
							background !== "transparent"
						)
							return background === "rgb(255, 255, 255)";
						node = node.parentElement;
					}
					return false;
				})(),
				"Assistant must use plain white background",
			);
			check(
				assistant.getBoundingClientRect().width >
					user.getBoundingClientRect().width / 0.9,
				"Assistant must be wider than 85% user bubbles",
			);
			check(
				user.getBoundingClientRect().width <=
					assistant.getBoundingClientRect().width * 0.86,
				"User bubble must be at most 85% assistant width",
			);
			check(
				find<HTMLElement>(".chat-history").getBoundingClientRect().height >=
					160,
				"Narrow view must retain usable message height",
			);
			check(
				find<HTMLElement>(".workbench").scrollWidth <=
					find<HTMLElement>(".workbench").clientWidth + 1,
				"Narrow discussion has horizontal overflow",
			);
			const host = find<HTMLElement>(".workbench").parentElement;
			check(host, "Missing constrained discussion host");
			host.style.width = "320px";
			host.style.height = "500px";
			await until(
				() => find<HTMLElement>(".workbench").clientWidth === 320,
				"Discussion must adapt to 320px host",
			);
			for (const selector of [".workbench", ".chat-history", ".chat-composer"])
				check(
					find<HTMLElement>(selector).scrollWidth <=
						find<HTMLElement>(selector).clientWidth + 1,
					`${selector} overflows its 320px host`,
				);
			check(
				find<HTMLElement>(".chat-history").getBoundingClientRect().height >=
					160,
				"320px discussion must retain usable message height",
			);
			for (const [trigger, label] of [
				["选择模型", "模型设置"],
				["设置审核模式", "审核模式"],
			] as const) {
				await openSetting(trigger, label);
				await closeSetting(trigger, label);
			}
			for (const label of container.querySelectorAll(".chat-config > button")) {
				const textRect = label.getBoundingClientRect();
				for (const action of container.querySelectorAll(
					".chat-composer-footer button",
				)) {
					const actionRect = action.getBoundingClientRect();
					check(
						textRect.right <= actionRect.left + 1 ||
							textRect.left >= actionRect.right - 1 ||
							textRect.bottom <= actionRect.top + 1 ||
							textRect.top >= actionRect.bottom - 1,
						"320px independent settings buttons must not overlap stop or send controls",
					);
				}
			}
		}
		button("停止本轮").click();
		await until(
			() =>
				stopCount === 1 &&
				container.textContent?.includes("正在停止本轮") === true,
			"Stop must display stopping state",
		);
		check(
			button("停止中…").disabled,
			"Stopping must disable repeated stop action",
		);
	} finally {
		dispose();
	}

	thread = { ...makeThread(), active_job_id: "job" };
	job = {
		...makeJob("waiting_review"),
		review_proposal: {
			analysis_id: "analysis",
			base_revision_id: "base-revision",
			title: "已有讲解",
			before: "旧开头",
			after: "新开头",
			operation: { kind: "update_preamble", body: "新开头" },
			source_run_id: "run",
			tool_call_id: "tool",
			tool_name: "update_analysis_preamble",
		},
	};
	patched = [];
	setupMock();
	dispose = await mount(<Screen />);
	try {
		await until(
			() =>
				!!container.querySelector(".chat-review-card") &&
				!button("同意修改").disabled,
			"Review must load proposal and base",
		);
		check(
			find(".chat-review-card").textContent?.includes("旧开头") &&
				find(".chat-review-card").textContent?.includes("新开头"),
			"Review must show before and after",
		);
		inputValue(find("#review-instructions"), "请保留例句");
		await until(
			() =>
				find<HTMLTextAreaElement>("#review-instructions").value ===
				"请保留例句",
			"Review instructions must update",
		);
		button("同意修改").click();
		await until(() => !!decision, "Review decision must submit");
		check(
			decision?.decision === "approve" &&
				decision.expected_version === 1 &&
				decision.additional_instructions === "请保留例句",
			"Approval lost optimistic version or extra instructions",
		);
	} finally {
		dispose();
	}

	thread = makeThread();
	job = {
		...makeJob("failed"),
		artifacts: [{ analysis_id: "analysis", revision_id: "saved-revision" }],
	};
	setupMock();
	dispose = await mount(<Screen />);
	try {
		await until(
			() =>
				container.textContent?.includes("离线模拟生成失败") === true &&
				!!container.querySelector(".chat-artifact-button"),
			"Failed reply must retain error and saved artifact",
		);
		find<HTMLButtonElement>(".chat-artifact-button").click();
		check(
			openedArtifact === "analysis/saved-revision",
			"Saved artifact must open its persisted revision",
		);
		button("把原问题放回输入框").click();
		await until(
			() =>
				find<HTMLTextAreaElement>("#chat-question").value ===
				"原问题\n\n补充要求：\n原补充",
			"Retry must restore legacy instructions visibly in the single question field",
		);
		if (refreshed) {
			let copied = "";
			const descriptor = Object.getOwnPropertyDescriptor(
				navigator,
				"clipboard",
			);
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (text: string) => {
						copied = text;
					},
				},
			});
			try {
				button("复制助手消息").click();
				await until(
					() => copied === "助手的完整离线回答。",
					"Copy must write full assistant text",
				);
				await until(
					() =>
						!!container.querySelector('button[aria-label="已复制助手消息"]'),
					"Copy must announce success",
				);
				Object.defineProperty(navigator, "clipboard", {
					configurable: true,
					value: {
						writeText: async () => {
							throw new Error("Clipboard unavailable");
						},
					},
				});
				button("已复制助手消息").click();
				await until(
					() =>
						container.textContent?.includes(
							"复制失败，请选择回复文字复制。",
						) === true,
					"Clipboard failure must leave visible recovery guidance",
				);
			} finally {
				if (descriptor)
					Object.defineProperty(navigator, "clipboard", descriptor);
				else Reflect.deleteProperty(navigator, "clipboard");
			}
			for (const icon of container.querySelectorAll("button"))
				if (!icon.textContent?.trim())
					check(
						icon.getAttribute("aria-label"),
						"Icon-only button requires accessible label",
					);
		}
	} finally {
		dispose();
	}
	thread = { ...makeThread(), selected_model_id: "removed-model" };
	job = null;
	setupMock();
	dispose = await mount(<Screen />);
	try {
		await until(
			() =>
				container
					.querySelector('[aria-label="选择模型"]')
					?.textContent?.includes("模型不可用") === true,
			"Unavailable selected model must remain visible",
		);
		await openSetting("选择模型", "模型设置");
		check(
			!popover("模型设置").querySelector(
				'input[data-model-id="removed-model"]:not(:disabled)',
			),
			"Unavailable model must not become a selectable option",
		);
		inputValue(find("#chat-question"), "模型失效时的问题");
		await until(
			() => button("发送问题").disabled,
			"Unavailable selected model must prevent submission",
		);
	} finally {
		dispose();
	}
	return "workbench: drafts survive navigation; revisioned settings/job payload; failure drafts, busy gates, stop, review decision, saved artifact and retry";
}
