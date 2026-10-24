import { useQueryClient } from "@tanstack/react-query";
import type { Job, Message } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeJob, makeThread, provider, settings } from "./workbench";

declare global {
	interface Window {
		__chatMarkdownRenders?: Record<string, number>;
	}
}

const settle = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);

export async function workbenchRender(h: BrowserHarness) {
	const { Workbench } = await import("../src/chat/Workbench");
	const { chatKeys } = await import("../src/chat/api");
	const { container, mount, until, inputValue, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const thread = { ...makeThread(), active_job_id: "job" };
	const historic: Message[] = Array.from({ length: 40 }, (_, index) => ({
		id: `stable-${index}`,
		thread_id: thread.id,
		job_id: `historic-job-${index}`,
		ordinal: index + 1,
		role: "assistant",
		status: index === 39 ? "failed" : "complete",
		content: `## 稳定历史 ${index}\n\n日语的**完整说明**。\n\n- 例句\n- 中文解释`,
		created_at: thread.created_at,
		updated_at: thread.updated_at,
		job_summary: {
			artifacts: [],
			error: index === 39 ? "历史失败" : null,
			retry:
				index === 39
					? { question: "恢复的问题", additional_instructions: "保留例句" }
					: null,
		},
	}));
	let job: Job = {
		...makeJob("running"),
		assistant_message: {
			...makeJob("running").assistant_message,
			ordinal: 42,
			content: "## 活动回复第一段",
		},
	};
	let jobGets = 0;
	let copied = "";
	const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				copied = text;
			},
		},
	});
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/segments/segment/threads")
			return Response.json({ items: [thread], next_cursor: null });
		if (path === "/api/threads/thread") return Response.json(thread);
		if (path === "/api/threads/thread/messages")
			return Response.json({ items: historic, next_cursor: null });
		if (path === "/api/jobs/job") {
			jobGets++;
			return Response.json(job);
		}
		throw new Error(`Unexpected render regression request ${request.url}`);
	});
	function Screen() {
		const client = useQueryClient();
		return (
			<div style={{ height: "700px" }}>
				<button
					type="button"
					onClick={() => {
						job = {
							...job,
							version: job.version + 1,
							active_step: "new_step",
							assistant_message: {
								...job.assistant_message,
								content: "## 活动回复第二段",
							},
						};
						void client.invalidateQueries({ queryKey: chatKeys.job(job.id) });
					}}
				>
					刷新活动内容
				</button>
				<button
					type="button"
					onClick={() => {
						job = {
							...job,
							version: job.version + 1,
							active_step: "progress_without_text",
						};
						void client.invalidateQueries({ queryKey: chatKeys.job(job.id) });
					}}
				>
					刷新活动进度
				</button>
				<Workbench
					segment={materialSegment}
					generateToken={null}
					selectedThreadId="thread"
					onSelectThread={() => {}}
					onGenerationAccepted={() => {}}
					onSubmissionStarted={() => {}}
					onJobAccepted={() => {}}
					onOpenArtifact={() => {}}
				/>
			</div>
		);
	}
	const button = (text: string) => {
		const node = [...container.querySelectorAll("button")].find(
			(button) =>
				button.textContent === text ||
				button.getAttribute("aria-label") === text,
		);
		check(node, `Missing button ${text}`);
		return node;
	};
	const countStable = () =>
		historic.reduce(
			(total, message) =>
				total + (window.__chatMarkdownRenders?.[message.content] ?? 0),
			0,
		);
	const dispose = await mount(<Screen />);
	try {
		await until(
			() => container.querySelectorAll(".chat-markdown").length === 41,
			"Actual workbench must mount 40 historic and one active Markdown reply",
		);
		await settle();
		const initial = countStable();
		check(initial >= 40, "Runner must instrument actual Markdown invocations");
		const input =
			container.querySelector<HTMLTextAreaElement>("#chat-question");
		check(input, "Missing composer");
		inputValue(input, "输入草稿");
		await settle();
		check(
			countStable() === initial,
			`Composer input rerendered ${countStable() - initial} stable Markdown replies`,
		);
		button("刷新活动内容").click();
		await until(
			() => container.textContent?.includes("活动回复第二段") === true,
			"Active query refresh must update its own Markdown",
		);
		await settle();
		check(
			countStable() === initial,
			"Active streaming update rerendered historic Markdown",
		);
		check(
			window.__chatMarkdownRenders?.["## 活动回复第二段"] === 1,
			"Updated active text must render exactly once",
		);
		const getsBeforeProgress = jobGets;
		button("刷新活动进度").click();
		await until(
			() => jobGets > getsBeforeProgress,
			"Progress refresh must poll active Job",
		);
		await settle();
		check(
			countStable() === initial &&
				window.__chatMarkdownRenders?.["## 活动回复第二段"] === 1,
			"Progress-only refresh must preserve every unchanged Markdown tree",
		);
		button("复制助手消息").click();
		await until(
			() =>
				copied === historic[0]?.content &&
				!!container.querySelector('button[aria-label="已复制助手消息"]'),
			"Memoized history copy button must remain interactive",
		);
		check(
			countStable() === initial,
			"Copy feedback must not reparse history Markdown",
		);
		button("把原问题放回输入框").click();
		await until(
			() => input.value === "恢复的问题\n\n补充要求：\n保留例句",
			"Memoized history must retain latest retry callback",
		);
		await settle();
		check(
			countStable() === initial,
			"Failure retry draft update must not rerender stable Markdown",
		);
		return `workbench render ${window.innerWidth}px: 40 historic replies; input/active stream/progress/copy/retry = 0 historic Markdown rerenders; active text renders once`;
	} finally {
		dispose();
		if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
}
