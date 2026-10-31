import { StrictMode } from "react";
import type { AnalysisDetail } from "../src/analysis/api";
import type { Job, JobInput, Thread } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeJob, makeThread, provider, settings } from "./workbench";

async function runExplanation(
	h: BrowserHarness,
	mode: "selected" | "default" | "choose",
) {
	const selected = mode === "selected";
	const { SegmentDetail } = await import("../src/SegmentPage");
	const { container, mount, mock, until } = h;
	const check: BrowserHarness["check"] = h.check;
	const segment = { ...materialSegment, material_provenance: null };
	const original: Thread = { ...makeThread(), selected_model_id: "model-two" };
	const threads = new Map<string, Thread>([[original.id, original]]);
	const jobs = new Map<string, Job>();
	const creations: Array<{ request_id: string; model_id?: string }> = [];
	const createdByRequest = new Map<string, Thread>();
	let loseNextCreationResponse = false;
	const lostCreationReleases: Array<() => void> = [];
	const submissions: Array<{ threadId: string; body: JobInput }> = [];
	let promptReads = 0;
	let holdCreations = false;
	const releases: Array<() => void> = [];
	let analysisWrites = 0;
	const savedAnalyses = new Map<string, AnalysisDetail>();
	const analysisReads: string[] = [];
	let failNextSubmission = false;
	const question =
		"后端预定问题：为当前片段创建并保存一份独立讲解，完成后报告保存结果。";
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings")
			return Response.json(
				mode === "choose"
					? {
							...settings,
							defaults: { ...settings.defaults, chat_model_id: null },
						}
					: settings,
			);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/chat/explanation-prompt") {
			promptReads++;
			return Response.json({ question });
		}
		if (path === "/api/segments/segment") return Response.json(segment);
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "测试来源",
				description: "",
				note: "",
				created_at: segment.created_at,
				updated_at: segment.updated_at,
			});
		if (path === "/api/segments/segment/analyses") {
			if (request.method !== "GET") analysisWrites++;
			return Response.json([...savedAnalyses.values()]);
		}
		if (path.startsWith("/api/analyses/")) {
			if (request.method !== "GET") analysisWrites++;
			const item = savedAnalyses.get(path.split("/").at(-1) ?? "");
			check(
				item,
				"Saved artifact must reference an existing independent explanation",
			);
			analysisReads.push(
				`${item.id}/${new URL(request.url).searchParams.get("revision_id")}`,
			);
			return Response.json(item);
		}
		if (path === "/api/segments/segment/translation-results")
			return Response.json([]);
		if (path === "/api/segments/segment/threads") {
			if (request.method === "POST") {
				const body: { request_id: string; model_id?: string } =
					await request.json();
				creations.push(body);
				const existing = createdByRequest.get(body.request_id);
				if (existing) return Response.json(existing);
				const item = {
					...makeThread(),
					id: `new-${creations.length}`,
					display_title: `讲解新对话${creations.length}`,
					selected_model_id: body.model_id ?? "model",
				};
				threads.set(item.id, item);
				createdByRequest.set(body.request_id, item);
				if (loseNextCreationResponse) {
					loseNextCreationResponse = false;
					await new Promise<void>((resolve) => {
						lostCreationReleases.push(resolve);
					});
					return Response.json({ detail: "并发创建响应丢失" }, { status: 503 });
				}
				if (holdCreations)
					await new Promise<void>((resolve) => releases.push(resolve));
				return Response.json(item);
			}
			return Response.json({ items: [...threads.values()], next_cursor: null });
		}
		const match = /^\/api\/threads\/([^/]+)(.*)$/.exec(path);
		if (match) {
			const threadId = match[1] ?? "";
			const thread = threads.get(threadId);
			check(thread, "Unknown explanation thread");
			if (!match[2]) return Response.json(thread);
			if (match[2] === "/messages")
				return Response.json({ items: [], next_cursor: null });
			if (match[2]?.startsWith("/jobs/by-request/")) {
				const requestId = match[2].split("/").at(-1);
				const found = [...jobs.values()].find(
					(item) =>
						item.thread_id === threadId && item.request_id === requestId,
				);
				return found
					? Response.json(found)
					: Response.json({ detail: "没有这个请求" }, { status: 404 });
			}
			if (match[2] === "/jobs" && request.method === "POST") {
				const body: JobInput = await request.json();
				submissions.push({ threadId, body });
				if (failNextSubmission) {
					failNextSubmission = false;
					return Response.json({ detail: "快捷问题离线拒绝" }, { status: 422 });
				}
				const id = `job-${submissions.length}`;
				savedAnalyses.set(`analysis-${id}`, {
					id: `analysis-${id}`,
					segment_id: segment.id,
					title: `AI 独立讲解 ${id}`,
					excerpt: "创建并保存的讲解摘要",
					current_revision_id: `revision-${id}`,
					revision_id: `revision-${id}`,
					parent_revision_id: null,
					origin: "ai",
					run_id: `run-${id}`,
					normalizer_version: 1,
					created_at: segment.created_at,
					updated_at: segment.updated_at,
					source_md: "独立讲解正文：文脈に応じて意味を考える。",
					warnings: [],
					sections: [],
				});
				const job: Job = {
					...makeJob("succeeded"),
					id,
					thread_id: threadId,
					request_id: body.request_id,
					question: body.question,
					kind: "chat",
					artifacts: [
						{ analysis_id: `analysis-${id}`, revision_id: `revision-${id}` },
					],
					assistant_message: {
						...makeJob("succeeded").assistant_message,
						id: `assistant-${id}`,
						job_id: id,
						thread_id: threadId,
						content: "已创建并保存一份独立讲解。",
					},
				};
				jobs.set(id, job);
				return Response.json(job);
			}
		}
		if (path.startsWith("/api/jobs/"))
			return Response.json(jobs.get(path.split("/").at(-1) ?? ""));
		throw new Error(`Unexpected explanation request ${request.method} ${path}`);
	});
	const action = (label: string) => {
		const button = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(item) =>
				item.textContent?.trim() === label ||
				item.getAttribute("aria-label") === label,
		);
		check(button && !button.disabled, `Missing explanation action ${label}`);
		return button;
	};
	const showCreationMenu = async () => {
		const back = container.querySelector<HTMLButtonElement>(
			"#analysis-list-return",
		);
		if (back) {
			back.click();
			await until(
				() => !container.querySelector("#analysis-list-return"),
				"Return to the independent explanation list",
			);
		}
		action("＋ 新建讲解").click();
	};
	const dispose = await mount(
		<StrictMode>
			<SegmentDetail />
		</StrictMode>,
		"/segments/:id",
		selected ? "/segments/segment?thread=thread&chat=1" : "/segments/segment",
	);
	try {
		await until(
			() =>
				selected
					? !!container.querySelector("#chat-question")
					: !!container.querySelector("#manual-analysis-create"),
			"Existing selected conversation must load",
		);
		for (let index = 1; index <= 2; index++) {
			if (
				innerWidth < 1000 &&
				!container
					.querySelector("#segment-conversation")
					?.hasAttribute("hidden")
			)
				action("返回阅读").click();
			await showCreationMenu();
			await until(
				() => !!container.querySelector(".segment-create-menu:popover-open"),
				"Creation menu must open",
			);
			action("创建 AI 讲解").click();
			if (mode === "choose" && index === 1) {
				await until(
					() => !!container.querySelector("#explanation-model"),
					"No chat default must wait for an explicit model choice",
				);
				check(
					creations.length === 0 && promptReads === 0,
					"Analysis default must not implicitly start an ordinary explanation",
				);
				const selector =
					container.querySelector<HTMLSelectElement>("#explanation-model");
				check(selector, "Missing explanation model selector");
				check(
					container.querySelector(".chat-first-generation h3")?.textContent ===
						"创建 AI 讲解" &&
						container.textContent?.includes(
							"选择模型后，在新对话中创建并保存一份独立讲解。",
						),
					"Model choice must explain creation and saving with the same action title",
				);
				selector.value = "model";
				selector.dispatchEvent(new Event("change", { bubbles: true }));
				await until(
					() => selector.value === "model",
					"Chosen model must be visible",
				);
				const create = container.querySelector<HTMLButtonElement>(
					".chat-first-generation .button.primary",
				);
				check(
					create && !create.disabled,
					"Chosen model must enable AI explanation creation",
				);
				create.click();
			}
			await until(
				() =>
					submissions.length === index &&
					container.textContent?.includes("已创建并保存一份独立讲解") === true,
				"Shortcut must report the saved explanation in a newly created ordinary conversation",
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			check(
				creations.length === index && submissions.length === index,
				"StrictMode and rerenders must not duplicate a click",
			);
			const submitted = submissions[index - 1];
			check(
				submitted &&
					submitted.threadId === `new-${index}` &&
					submitted.threadId !== original.id,
				"Each explanation click must use a fresh thread",
			);
			check(
				submitted.body.question === question &&
					!Object.hasOwn(submitted.body, "action") &&
					!Object.hasOwn(submitted.body, "additional_instructions"),
				"Shortcut must submit only the frozen backend question through normal JobCreate",
			);
			check(
				creations[index - 1]?.model_id === (selected ? "model-two" : "model"),
				"Fresh conversation must retain the selected model",
			);
			await until(
				() => !!container.querySelector(".chat-artifact-button"),
				"Saved result must expose an exact revision entry",
			);
			container
				.querySelector<HTMLButtonElement>(".chat-artifact-button")
				?.click();
			await until(
				() =>
					analysisReads.includes(
						`analysis-job-${index}/revision-job-${index}`,
					) &&
					container.textContent?.includes(
						"独立讲解正文：文脈に応じて意味を考える。",
					) === true,
				"Saved artifact must open its exact persisted explanation revision",
			);
			check(
				analysisWrites === 0 && !container.querySelector(".analysis-draft"),
				"Frontend must not directly write an Analysis or open a draft",
			);
		}
		holdCreations = true;
		for (let index = 3; index <= 4; index++) {
			if (
				innerWidth < 1000 &&
				!container
					.querySelector("#segment-conversation")
					?.hasAttribute("hidden")
			)
				action("返回阅读").click();
			await showCreationMenu();
			await until(
				() => !!container.querySelector(".segment-create-menu:popover-open"),
				"Rapid explanation menu must open",
			);
			action("创建 AI 讲解").click();
			await until(
				() => creations.length === index,
				"Both rapid clicks must begin fresh thread creation",
			);
			check(
				container.textContent?.includes("正在准备新的讲解对话…") &&
					!container.querySelector("#explanation-model"),
				"Accepted shortcut preparation must show its actual phase without an actionable model selector",
			);
		}
		check(
			submissions.length === 2 && releases.length === 2,
			"Neither held thread has submitted yet",
		);
		releases[1]?.();
		releases[0]?.();
		await until(
			() => submissions.length === 4,
			"Both out-of-order creations must submit without visiting their panels",
		);
		await new Promise((resolve) => setTimeout(resolve, 80));
		check(
			Number(submissions.length) === 4 &&
				new Set(submissions.map((item) => item.threadId)).size === 4,
			"Each rapid intent must have exactly one ordinary Job in a different fresh thread",
		);
		check(
			submissions.every(
				(item) =>
					item.body.question === question &&
					!Object.hasOwn(item.body, "action"),
			) && analysisWrites === 0,
			"Concurrent creation requests use ordinary chats without direct frontend Analysis writes",
		);

		check(
			new Set(creations.map((item) => item.request_id)).size === 4 &&
				promptReads === 4,
			"Separate clicks must have separate idempotent identities and backend questions",
		);
		holdCreations = false;
		failNextSubmission = true;
		if (innerWidth < 1000) action("返回阅读").click();
		await showCreationMenu();
		await until(
			() => !!container.querySelector(".segment-create-menu:popover-open"),
			"Failure scenario menu must open",
		);
		action("创建 AI 讲解").click();
		await until(
			() => container.textContent?.includes("快捷问题离线拒绝") === true,
			"Definite ordinary submission rejection must be visible",
		);
		const input =
			container.querySelector<HTMLTextAreaElement>("#chat-question");
		check(
			input?.value === question && creations.length === 5,
			"Rejected shortcut must preserve its question in the same fresh thread",
		);
		await until(
			() =>
				[...container.querySelectorAll<HTMLButtonElement>("button")].some(
					(button) =>
						(button.textContent?.trim() === "发送问题" ||
							button.getAttribute("aria-label") === "发送问题") &&
						!button.disabled,
				),
			"Rejected question must become sendable after fresh thread history loads",
		);
		action("发送问题").click();
		await until(
			() =>
				submissions.length === 6 &&
				container.textContent?.includes("已创建并保存一份独立讲解") === true,
			"Normal send must retry the retained question",
		);
		check(
			submissions.at(-1)?.threadId === "new-5" && creations.length === 5,
			"Retry must not create another conversation",
		);
		check(
			!container.textContent?.includes("快捷问题离线拒绝"),
			"Successful retry must clear the rejection",
		);
		const chooseThread = async (title: string) => {
			action("返回对话列表").click();
			await until(
				() =>
					[...container.querySelectorAll(".chat-thread-title")].some(
						(node) => node.textContent === title,
					),
				"Thread must remain in the list",
			);
			const button = [
				...container.querySelectorAll<HTMLButtonElement>(".chat-thread"),
			].find(
				(node) =>
					node.querySelector(".chat-thread-title")?.textContent === title,
			);
			check(button, "Missing thread choice");
			button.click();
			await until(
				() => !!container.querySelector("#chat-question"),
				"Chosen thread must load",
			);
		};
		await chooseThread("回归讨论");
		await chooseThread("讲解新对话5");
		check(
			!container.textContent?.includes("快捷问题离线拒绝"),
			"Returning to the retried conversation must not resurrect the parent error",
		);
		check(
			analysisWrites === 0,
			"Failure recovery must not directly write Analysis content from the frontend",
		);

		const creationsBeforeLoss = creations.length;
		const submissionsBeforeLoss = submissions.length;
		const promptsBeforeLoss = promptReads;
		loseNextCreationResponse = true;
		for (let index = 1; index <= 2; index++) {
			if (innerWidth < 1000) action("返回阅读").click();
			await showCreationMenu();
			await until(
				() => !!container.querySelector(".segment-create-menu:popover-open"),
				"Concurrent recovery menu must open",
			);
			action("创建 AI 讲解").click();
			await until(
				() => creations.length === creationsBeforeLoss + index,
				"Both recovery intents must create separate threads",
			);
		}
		await until(
			() => submissions.length === submissionsBeforeLoss + 1,
			"The later creation must succeed before the earlier failure",
		);
		check(
			lostCreationReleases.length === 1,
			"Missing delayed creation response",
		);
		lostCreationReleases[0]?.();
		await until(
			() => container.textContent?.includes("并发创建响应丢失") === true,
			"An earlier creation failure must remain recoverable after a later success",
		);
		const lostRequest = creations[creationsBeforeLoss];
		check(lostRequest, "Missing frozen failed creation request");
		const lostThread = createdByRequest.get(lostRequest.request_id);
		check(lostThread, "The lost response must leave a persisted thread");
		action("重试新建讲解对话").click();
		await until(
			() => submissions.length === submissionsBeforeLoss + 2,
			"Retry must finish the earlier intent with its original identity",
		);
		check(
			creations.length === creationsBeforeLoss + 3 &&
				threads.size === creationsBeforeLoss + 3 &&
				creations.at(-1)?.request_id === lostRequest.request_id &&
				creations.at(-1)?.model_id === lostRequest.model_id &&
				promptReads === promptsBeforeLoss + 2 &&
				submissions.filter((item) => item.threadId === lostThread.id).length ===
					1 &&
				submissions.at(-1)?.body.request_id === lostRequest.request_id &&
				submissions.at(-1)?.body.question === question,
			"Recovery must reuse the frozen token, model, question and persisted thread and submit once",
		);
		await until(
			() => !container.textContent?.includes("并发创建响应丢失"),
			"Recovered intent must clear only its own error",
		);

		return `explanation ${innerWidth}px: real Segment shortcut; four fresh ordinary chats including concurrent out-of-order creation; ${mode} model; backend question; StrictMode no duplicates; 4xx retry same thread and no resurrected error; earlier lost creation response remains retryable after later success; save result artifact and report; no action/additional fields or direct frontend Analysis writes`;
	} finally {
		dispose();
	}
}

export async function explanationRegression(h: BrowserHarness) {
	return `${await runExplanation(h, "selected")}; ${await runExplanation(h, "default")}; ${await runExplanation(h, "choose")}`;
}
