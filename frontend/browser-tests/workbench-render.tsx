import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Job, Message } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeJob, makeThread, provider, settings } from "./workbench";

declare global {
	interface Window {
		__chatMarkdownParses?: Record<string, number>;
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
	const originalTheme = document.documentElement.dataset.theme;
	if (new URLSearchParams(location.search).get("theme") === "dark")
		document.documentElement.dataset.theme = "dark";
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
			retry: index === 39 ? { question: "恢复的问题\n\n保留例句" } : null,
		},
	}));
	let job: Job = {
		...makeJob("running"),
		created_at: new Date(Date.now() - 12000).toISOString(),
		active_step: "model_call",
		assistant_message: {
			...makeJob("running").assistant_message,
			ordinal: 42,
			content: "## 活动回复第一段",
		},
	};
	let queryClient: QueryClient | undefined;
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
		queryClient = client;
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
					explainToken={null}
					selectedThreadId="thread"
					onSelectThread={() => {}}
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
				total + (window.__chatMarkdownParses?.[message.content] ?? 0),
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
		check(initial >= 40, "Runner must instrument actual Markdown parsing");
		const input =
			container.querySelector<HTMLTextAreaElement>("#chat-question");
		check(input, "Missing composer");
		inputValue(input, "输入草稿");
		await settle();
		check(
			countStable() === initial,
			`Composer input reparsed ${countStable() - initial} stable Markdown replies`,
		);
		button("刷新活动内容").click();
		await until(
			() => container.textContent?.includes("活动回复第二段") === true,
			"Active query refresh must update its own Markdown",
		);
		await settle();
		check(
			countStable() === initial,
			"Active streaming update reparsed historic Markdown",
		);
		check(
			(window.__chatMarkdownParses?.["## 活动回复第二段"] ?? 0) > 0,
			"Updated active text must pass through the Markdown processor",
		);
		const activeParses = window.__chatMarkdownParses?.["## 活动回复第二段"];
		const getsBeforeProgress = jobGets;
		button("刷新活动进度").click();
		await until(
			() => jobGets > getsBeforeProgress,
			"Progress refresh must poll active Job",
		);
		await settle();
		check(
			countStable() === initial &&
				window.__chatMarkdownParses?.["## 活动回复第二段"] === activeParses,
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
			() => input.value === "恢复的问题\n\n保留例句",
			"Memoized history must retain latest retry callback",
		);
		await settle();
		check(
			countStable() === initial,
			"Failure retry draft update must not reparse stable Markdown",
		);
		const progress = () =>
			container.querySelector(".chat-reply-progress[data-status]");
		check(
			progress()?.textContent?.includes("正在处理本轮请求"),
			"Unknown activity must use neutral fallback",
		);
		const phase = () => progress()?.querySelector('[role="status"]');
		check(
			getComputedStyle(phase() as Element, "::before").content === '""',
			"Active processing must have a static activity dot",
		);
		const clock = () => progress()?.querySelector(".chat-reply-elapsed");
		const beforeTick = clock()?.textContent;
		check(
			beforeTick?.startsWith("已用 "),
			"Active reply must show elapsed wall time",
		);
		check(
			clock()?.getAttribute("aria-live") === "off",
			"Clock ticks must not be announced every second",
		);
		await until(
			() => clock()?.textContent !== beforeTick,
			"Reply elapsed time must advance",
		);
		check(
			countStable() === initial &&
				window.__chatMarkdownParses?.["## 活动回复第二段"] === activeParses,
			"Clock ticks must not reparse any reply Markdown",
		);
		const update = async (changes: Partial<Job>, label: string) => {
			job = { ...job, ...changes, version: job.version + 1 };
			check(queryClient, "Missing mounted query client");
			await queryClient.invalidateQueries({ queryKey: chatKeys.job(job.id) });
			await until(
				() =>
					progress()?.querySelector('[role="status"]')?.textContent === label,
				`Expected actual activity: ${label}`,
			);
			check(
				!container.querySelector(".chat-placeholder,.chat-job-state"),
				"Reply activity must have only one current progress line",
			);
		};
		await update({ active_step: "writing_analysis" }, "正在撰写讲解");
		check(
			!container.querySelector(".chat-artifact-button"),
			"Writing tool arguments must not claim an explanation was saved",
		);
		await update({ active_step: "saving_analysis" }, "正在保存讲解");
		await update(
			{
				active_step: "model_call",
				runs: [
					{ id: "run1", purpose: "chat", status: "succeeded" },
					{ id: "run2", purpose: "chat", status: "running" },
				],
			},
			"等待模型继续回复",
		);
		await update(
			{ status: "waiting_review", active_step: "streaming" },
			"等待你审核修改",
		);
		check(
			!!container.querySelector(".chat-review-card"),
			"Review waiting must retain review controls",
		);
		check(
			getComputedStyle(phase() as Element, "::before").content === "none",
			"Review waiting must not look like active processing",
		);
		await update({ status: "stopping" }, "正在停止本轮");
		await update(
			{
				status: "interrupted",
				finished_at: new Date(Date.parse(job.created_at) + 31000).toISOString(),
			},
			"本轮已中断",
		);
		check(
			clock()?.textContent === "已用 0:31",
			"Terminal clock must use server finish time",
		);
		const stoppedClock = clock()?.textContent;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		check(
			clock()?.textContent === stoppedClock,
			"Terminal clock must remain stopped",
		);
		const bounds = progress()?.getBoundingClientRect();
		check(
			bounds &&
				bounds.width <= container.clientWidth &&
				bounds.right <= window.innerWidth,
			"Progress line must fit a narrow discussion panel",
		);
		check(
			getComputedStyle(progress() as Element).animationName === "none",
			"Progress must not depend on animation",
		);
		return `workbench render ${window.innerWidth}px: Markdown reused across input/stream/progress/copy/retry/clock; one factual progress line, writing/saving/multiple calls/review/stop/terminal clock and narrow layout verified`;
	} finally {
		dispose();
		if (originalTheme === undefined)
			delete document.documentElement.dataset.theme;
		else document.documentElement.dataset.theme = originalTheme;
		if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
}
