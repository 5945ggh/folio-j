import { useState } from "react";
import type { components } from "../src/api/schema";
import type { Job, JobInput } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeJob, makeThread, provider, settings } from "./workbench";

export async function modelSetup(h: BrowserHarness): Promise<string> {
	const { Workbench } = await import("../src/chat/Workbench");
	const { check, until, container, inputValue } = h;
	const verify: BrowserHarness["check"] = check;
	const params = new URLSearchParams(location.search);
	let providers: components["schemas"]["ProviderResponse"][] = [
		{ ...provider, enabled: false },
	];
	let generated = 0;
	let failRead = false;
	let defaultsWrites = 0;
	let thread = makeThread();
	let createdThreads = 0;
	let submittedJobs = 0;
	let job: Job | null = null;
	let submitted: JobInput | null = null;
	let createdModel: unknown;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings") {
			if (request.method !== "GET") defaultsWrites++;
			return Response.json(settings);
		}
		if (path === "/api/providers")
			return failRead
				? Response.json({ detail: "服务读取失败" }, { status: 503 })
				: Response.json(providers);
		if (path === "/api/providers/provider" && request.method === "PATCH") {
			const body = (await request.json()) as { enabled: boolean };
			providers = providers.map((item) => ({ ...item, enabled: body.enabled }));
			return Response.json(providers[0]);
		}
		if (path === "/api/segments/segment/threads") {
			if (request.method === "POST") {
				generated++;
				createdThreads++;
				const input = (await request.json()) as Record<string, unknown>;
				createdModel = input.model_id;
				return Response.json(thread);
			}
			return Response.json({ items: [thread], next_cursor: null });
		}
		if (path.includes("/jobs/by-request/"))
			return Response.json({ detail: "尚无任务" }, { status: 404 });
		if (path === "/api/threads/thread/jobs" && request.method === "POST") {
			submittedJobs++;
			submitted = (await request.json()) as JobInput;
			job = {
				...makeJob("running"),
				request_id: submitted.request_id,
				question: submitted.question,
			};
			thread = {
				...thread,
				active_job_id: job.id,
				revision: thread.revision + 1,
			};
			return Response.json(job);
		}
		if (path === "/api/jobs/job") return Response.json(job);
		if (path === "/api/threads/thread/messages")
			return Response.json({ items: [], next_cursor: null });
		if (path === "/api/threads/thread") return Response.json(thread);
		if (path === "/api/chat/explanation-prompt") {
			generated++;
			return Response.json({ question: "明确生成讲解", prompt_version: "v1" });
		}
		throw new Error(`Unexpected model-setup request ${request.method} ${path}`);
	});
	function action(label: string, scope: ParentNode = container) {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) ===
					label && node.getClientRects().length > 0,
		);
		verify(found && !found.disabled, `Missing model setup action ${label}`);
		return found;
	}
	function Screen({ explanation = false }: { explanation?: boolean }) {
		const [selected, setSelected] = useState<string | null>(
			explanation ? null : thread.id,
		);
		return (
			<div style={{ height: "min(760px, 95dvh)", maxWidth: "720px" }}>
				<Workbench
					segment={materialSegment}
					explainToken={explanation ? "configure-explanation" : null}
					selectedThreadId={selected}
					onSelectThread={setSelected}
					onSubmissionStarted={() => {
						generated++;
					}}
					onJobAccepted={() => {}}
					onOpenArtifact={() => {}}
				/>
			</div>
		);
	}
	const enableProvider = async () => {
		await until(
			() => !!container.querySelector(".provider-service-summary"),
			"Setup must expose the existing service list",
		);
		container
			.querySelector<HTMLButtonElement>(".provider-service-summary")
			?.click();
		await until(
			() => !!container.querySelector(".provider-detail-dialog"),
			"Existing service details must open inside setup",
		);
		action("连接设置").click();
		await until(
			() =>
				!!container.querySelector(
					".provider-connection-view input[role=switch]",
				),
			"Connection settings must render before enabling the service",
		);
		const enabled = container.querySelector<HTMLInputElement>(
			".provider-connection-view input[role=switch]",
		);
		verify(enabled, "Service enable control must be available");
		enabled.click();
		await until(
			() => providers[0]?.enabled === true,
			"Service must become enabled",
		);
		action("关闭服务详情").click();
	};
	let dispose = await h.mount(
		<Screen />,
		"*",
		"/segments/segment?thread=thread",
	);
	try {
		await until(
			() => !!container.querySelector(".chat-composer textarea"),
			"Discussion must mount before setup",
		);
		const question = container.querySelector<HTMLTextAreaElement>(
			".chat-composer textarea",
		);
		verify(question, "Discussion input must remain available without a model");
		inputValue(question, "保留这个未发送的问题");
		action("选择模型").click();
		await until(
			() => !!container.querySelector(".chat-setting-popover:popover-open"),
			"Model selector must open",
		);
		action("配置模型与服务 →").click();
		await until(
			() => !!container.querySelector(".model-setup-dialog[open]"),
			"Configuration must open without leaving the discussion",
		);
		if (params.has("preview") && params.get("scene") === "chat")
			return "model setup preview";
		action("添加服务").click();
		await until(
			() => !!container.querySelector(".provider-editor-dialog"),
			"Service editor must open inside setup",
		);
		const editor = container.querySelector<HTMLElement>(
			".provider-editor-dialog",
		);
		const name = editor?.querySelector<HTMLInputElement>("input[required]");
		verify(editor && name, "Service editor must expose its name");
		inputValue(name, "尚未保存的服务");
		action("关闭", editor).click();
		await until(
			() => !!container.querySelector(".settings-leave-dialog"),
			"Closing an edited service must preserve its existing draft protection",
		);
		verify(
			!!container.querySelector(".model-setup-dialog[open]"),
			"Closing the nested editor must not close setup",
		);
		action("继续编辑").click();
		await until(
			() => !container.querySelector(".settings-leave-dialog"),
			"Continuing must return to the same service draft",
		);
		verify(
			name.value === "尚未保存的服务",
			"Service draft must survive the confirmation",
		);
		action("关闭", editor).click();
		await until(
			() => !!container.querySelector(".settings-leave-dialog"),
			"Discard confirmation must reopen",
		);
		action("放弃修改").click();
		await until(
			() => !container.querySelector(".provider-editor-dialog"),
			"Discard must close only the unsaved editor",
		);
		await enableProvider();
		action("返回讨论").click();
		await until(
			() => !container.querySelector(".model-setup-dialog"),
			"Setup must close",
		);
		verify(
			question.isConnected && question.value === "保留这个未发送的问题",
			"Setup must preserve the same input and draft",
		);
		verify(
			document.activeElement?.getAttribute("aria-label") === "选择模型",
			"Setup close must return focus to the model selector",
		);
		action("选择模型").click();
		await until(
			() =>
				!!container.querySelector(
					'.chat-setting-popover:popover-open [data-model-id="model"]',
				),
			"Updated provider models must be available for explicit selection",
		);
		verify(
			generated === 0 && defaultsWrites === 0,
			"Configuring models must not generate or change global defaults",
		);
	} finally {
		if (!params.has("preview") || params.get("scene") !== "chat") dispose();
	}
	providers = [{ ...provider, enabled: false }];
	dispose = await h.mount(
		<Screen explanation />,
		"*",
		"/segments/segment?chat=1",
	);
	try {
		await until(
			() => !!container.querySelector(".chat-model-guide"),
			"AI explanation must guide unavailable-model setup",
		);
		verify(
			!container.querySelector("#explanation-model"),
			"No-model explanation must not offer an empty select",
		);
		if (params.has("preview")) return "explanation setup preview";
		action("配置模型与服务").click();
		await enableProvider();
		await until(
			() =>
				!!container.querySelector('#explanation-model option[value="model"]'),
			"Enabling the old default must refresh model choices",
		);
		verify(
			generated === 0,
			"Restoring an old default while setup is open must not create an explanation",
		);
		action("返回讨论").click();
		await until(
			() => !container.querySelector(".model-setup-dialog"),
			"AI setup must close",
		);
		verify(
			generated === 0 && defaultsWrites === 0,
			"Returning from setup must still require explicit explanation creation",
		);
		verify(
			document.activeElement?.id === "explanation-model",
			"Replacing the empty-state entry must restore focus to the newly available model select",
		);
		action("创建 AI 讲解");
		// Read failures must stay distinguishable from an empty service library.
		failRead = true;
		action("配置模型与服务 →").click();
		await until(
			() => container.textContent?.includes("服务读取失败") ?? false,
			"Setup must show provider read errors",
		);
		failRead = false;
		action("重试模型服务").click();
		await until(
			() => !container.querySelector(".model-setup-dialog .inline-error"),
			"Provider read retry must recover",
		);
		action("返回讨论").click();
		await until(
			() => !container.querySelector(".model-setup-dialog"),
			"Retry setup must finish closing before continuation",
		);
		verify(
			generated === 0,
			"Setup errors and retries must not trigger generation",
		);
		action("创建 AI 讲解").click();
		await until(
			() => submittedJobs === 1 && !!container.querySelector(".chat-composer"),
			"Explicit continuation must create one explanation request",
		);
		verify(
			createdThreads === 1 && createdModel === "model",
			"Continuation must create one thread with the explicitly displayed model",
		);
		verify(
			(submitted as JobInput | null)?.request_id === "configure-explanation",
			"Continuation must preserve the explanation request identity",
		);
		await until(
			() =>
				!!container.querySelector(
					'.chat-setting-button[aria-label="选择模型"]',
				),
			"Running explanation must expose its model configuration entry",
		);
		action("选择模型").click();
		await until(
			() => !!container.querySelector(".chat-setting-popover:popover-open"),
			"Running discussion model options must open",
		);
		action("配置模型与服务 →").click();
		await until(
			() => !!container.querySelector(".model-setup-dialog[open]"),
			"Running task must allow service configuration without leaving the thread",
		);
		action("返回讨论").click();
		await until(
			() => !container.querySelector(".model-setup-dialog"),
			"Task setup must close back to the running discussion",
		);
		verify(
			createdThreads === 1 && submittedJobs === 1 && defaultsWrites === 0,
			"Opening setup during a task must neither resubmit nor change defaults",
		);
		return `model setup ${innerWidth}px: same draft/focus; nested editor draft guard; disabled service repair; read retry; no automatic calls; explicit AI request once with original identity; running task preserved`;
	} finally {
		if (!params.has("preview")) dispose();
	}
}
