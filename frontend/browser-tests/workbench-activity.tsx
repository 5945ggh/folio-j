import {
	type InfiniteData,
	type QueryClient,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import type { Job, JobInput, listThreads, Thread } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeJob, makeThread, provider, settings } from "./workbench";

const settle = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);

export async function workbenchActivityRegression(h: BrowserHarness) {
	const { Workbench } = await import("../src/chat/Workbench");
	const { chatKeys } = await import("../src/chat/api");
	const { settingsKeys } = await import("../src/settings/api");
	const { container, mount, until, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	let queryClient: QueryClient | undefined;
	let scenario: "create" | "explanation" = "create";
	let releaseCreate = () => {};
	const createGate = new Promise<void>((resolve) => {
		releaseCreate = resolve;
	});
	let releaseModels = () => {};
	const modelsGate = new Promise<void>((resolve) => {
		releaseModels = resolve;
	});
	const originalThread = makeThread();
	const createdThread: Thread = {
		...originalThread,
		id: "late-created-thread",
		display_title: "暂离期间创建的对话",
	};
	let threads = [originalThread];
	let createRequests = 0;
	let promptRequests = 0;
	let jobRequests = 0;
	let providerRequests = 0;
	let submittedInput: JobInput | null = null;
	let acceptedJob: Job | null = null;
	const selections: (string | null)[] = [];
	const submissions: string[] = [];
	const generationCalls = () => createRequests + promptRequests + jobRequests;

	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") {
			providerRequests++;
			if (scenario === "explanation") await modelsGate;
			return Response.json([provider]);
		}
		if (path === "/api/segments/segment/threads") {
			if (request.method === "POST") {
				createRequests++;
				if (scenario === "create") await createGate;
				threads = [createdThread, originalThread];
				return Response.json(createdThread);
			}
			return Response.json({ items: threads, next_cursor: null });
		}
		if (path === "/api/chat/explanation-prompt") {
			promptRequests++;
			return Response.json({
				question: "明确继续后创建独立讲解",
				prompt_version: "v1",
			});
		}
		if (path === "/api/jobs/job") return Response.json(acceptedJob);
		if (path.includes("/jobs/by-request/"))
			return Response.json({ detail: "尚未提交" }, { status: 404 });
		if (
			path === `/api/threads/${createdThread.id}/jobs` &&
			request.method === "POST"
		) {
			jobRequests++;
			submittedInput = (await request.json()) as JobInput;
			acceptedJob = {
				...makeJob("succeeded"),
				thread_id: createdThread.id,
				request_id: submittedInput.request_id,
				question: submittedInput.question,
				assistant_message: {
					...makeJob("succeeded").assistant_message,
					thread_id: createdThread.id,
				},
			};
			return Response.json(acceptedJob);
		}
		for (const thread of threads) {
			if (path === `/api/threads/${thread.id}`) return Response.json(thread);
			if (path === `/api/threads/${thread.id}/messages`)
				return Response.json({ items: [], next_cursor: null });
		}
		throw new Error(`Unexpected activity request ${request.method} ${path}`);
	});

	function Screen({ explanation = false }: { explanation?: boolean }) {
		queryClient = useQueryClient();
		const [active, setActive] = useState(true);
		const [selected, setSelected] = useState<string | null>(null);
		return (
			<div style={{ height: "min(760px, 95dvh)", maxWidth: "720px" }}>
				<button type="button" onClick={() => setActive((old) => !old)}>
					{active ? "暂离工作台" : "返回工作台"}
				</button>
				<output data-workbench-selection={selected ?? "list"} />
				<div hidden={!active} data-workbench-active={String(active)}>
					<Workbench
						active={active}
						segment={materialSegment}
						explainToken={explanation ? "resume-after-settings" : null}
						selectedThreadId={selected}
						onSelectThread={(id) => {
							selections.push(id);
							setSelected(id);
						}}
						onSubmissionStarted={(id) => submissions.push(id)}
						onJobAccepted={() => {}}
						onOpenArtifact={() => {}}
					/>
				</div>
			</div>
		);
	}
	function action(label: string) {
		const node = [...container.querySelectorAll("button")].find(
			(item) =>
				(item.getAttribute("aria-label") ?? item.textContent?.trim()) ===
					label && item.getClientRects().length > 0,
		);
		check(node && !node.disabled, `Missing activity action ${label}`);
		return node;
	}
	function cachedThreads() {
		return (
			queryClient
				?.getQueryData<InfiniteData<Awaited<ReturnType<typeof listThreads>>>>(
					chatKeys.threads(materialSegment.id),
				)
				?.pages.flatMap((page) => page.items) ?? []
		);
	}
	async function toggleActive(active: boolean) {
		action(active ? "返回工作台" : "暂离工作台").click();
		await until(
			() =>
				!!container.querySelector(
					`[data-workbench-active="${String(active)}"]`,
				),
			"Workbench activity must commit before resolving delayed requests",
		);
		await settle();
	}

	let dispose = await mount(<Screen />, "*", "/segments/segment?chat=1");
	try {
		await until(
			() => !!container.querySelector(".chat-thread"),
			"The original thread list must load",
		);
		action("新建对话").click();
		await until(
			() => createRequests === 1,
			"Thread creation must be in flight",
		);
		await toggleActive(false);
		releaseCreate();
		await until(
			() => cachedThreads().some((thread) => thread.id === createdThread.id),
			"A delayed creation must remain recoverable in the thread-list cache",
		);
		await settle();
		check(
			selections.length === 0 &&
				!!container.querySelector('[data-workbench-selection="list"]'),
			"Inactive creation must not call onSelectThread or change its route selection",
		);
		await toggleActive(true);
		check(
			container.querySelector<HTMLElement>(".chat-list-view")?.hidden ===
				false &&
				container.querySelector<HTMLElement>(".chat-detail-view")?.hidden ===
					true,
			"Returning must preserve the list matching selectedThreadId=null",
		);
		check(
			selections.length === 0 &&
				container
					.querySelector(".chat-thread-list")
					?.textContent?.includes(createdThread.display_title),
			"Returning must expose the saved new thread without selecting it",
		);
	} finally {
		releaseCreate();
		dispose();
	}

	scenario = "explanation";
	threads = [originalThread];
	createRequests = 0;
	promptRequests = 0;
	jobRequests = 0;
	providerRequests = 0;
	selections.length = 0;
	dispose = await mount(
		<Screen explanation />,
		"*",
		"/segments/segment?chat=1",
	);
	try {
		await until(
			() => providerRequests === 1,
			"Automatic explanation must still be waiting for its model settings",
		);
		check(generationCalls() === 0, "Pending model settings must not generate");
		await toggleActive(false);
		releaseModels();
		await until(
			() =>
				queryClient?.getQueryState(settingsKeys.providers)?.status ===
				"success",
			"Models must finish loading while the workbench is inactive",
		);
		await settle();
		check(
			generationCalls() === 0 && submissions.length === 0,
			"Model readiness while inactive must not read prompts, create threads, or submit jobs",
		);
		await toggleActive(true);
		await until(
			() =>
				!!container.querySelector('#explanation-model option[value="model"]'),
			"Returning must show the available model for explicit continuation",
		);
		await settle();
		check(
			generationCalls() === 0 && submissions.length === 0,
			"Restoring activity must keep the unsubmitted explanation intent manual",
		);
		action("创建 AI 讲解").click();
		await until(
			() => jobRequests === 1 && !!container.querySelector(".chat-composer"),
			"Explicit continuation must submit the saved explanation intent once",
		);
		check(
			createRequests === 1 &&
				promptRequests === 1 &&
				submissions.join(",") === "resume-after-settings" &&
				(submittedInput as JobInput | null)?.request_id ===
					"resume-after-settings",
			"Explicit continuation must preserve the original request identity",
		);
		return "workbench activity: late thread creation preserves selection and cache; inactive model readiness requires explicit explanation continuation";
	} finally {
		releaseModels();
		dispose();
	}
}
