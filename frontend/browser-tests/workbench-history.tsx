import { useQueryClient } from "@tanstack/react-query";
import type { Message } from "../src/chat/api";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";
import { makeThread, provider, settings } from "./workbench";

export async function workbenchHistory(h: BrowserHarness) {
	const { Workbench } = await import("../src/chat/Workbench");
	const { chatKeys } = await import("../src/chat/api");
	const { container, mount, until, inputValue, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const thread = makeThread();
	const timestamp = thread.created_at;
	const messages: Message[] = Array.from({ length: 42 }, (_, index) => ({
		id: `history-${index}`,
		thread_id: thread.id,
		job_id: `job-${index}`,
		ordinal: index + 1,
		role: "assistant",
		status: index === 41 ? "failed" : "complete",
		content: `## 历史回复 ${index}\n\n日语的**离线讲解**。`,
		created_at: timestamp,
		updated_at: timestamp,
		job_summary: {
			artifacts:
				index === 2
					? [{ analysis_id: "saved", revision_id: "old-revision" }]
					: [],
			error: index === 41 ? "历史失败原因" : null,
			retry:
				index === 41
					? { question: "历史原问题", additional_instructions: "旧补充" }
					: null,
		},
	}));
	let historyGets = 0;
	let jobGets = 0;
	let opened = "";
	mock(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api/settings") return Response.json(settings);
		if (url.pathname === "/api/providers") return Response.json([provider]);
		if (url.pathname === "/api/segments/segment/threads")
			return Response.json({ items: [thread], next_cursor: null });
		if (url.pathname === "/api/threads/thread") return Response.json(thread);
		if (url.pathname === "/api/threads/thread/messages") {
			historyGets++;
			const before = Number(
				url.searchParams.get("before_ordinal") ?? String(messages.length + 1),
			);
			const backwards = url.searchParams.get("direction") === "backward";
			const eligible = messages.filter((message) => message.ordinal < before);
			const page = eligible.slice(-40);
			return Response.json({
				items: backwards ? page : messages.slice(2),
				next_cursor: eligible.length > 40 ? page[0]?.ordinal : null,
			});
		}
		if (url.pathname.startsWith("/api/jobs/")) {
			jobGets++;
			return Response.json({ detail: "历史不应查询完整任务" }, { status: 404 });
		}
		throw new Error(`Unexpected history request ${request.url}`);
	});
	function Screen() {
		const client = useQueryClient();
		return (
			<div style={{ height: "700px" }}>
				<button
					type="button"
					onClick={() => {
						const sample = messages[0];
						check(sample, "Missing sample message");
						for (let index = 42; index < 44; index++)
							messages.push({
								...sample,
								id: `new-${index}`,
								job_id: `new-job-${index}`,
								ordinal: index + 1,
								content: `## 新回复 ${index}`,
							});
						void client.invalidateQueries({
							queryKey: chatKeys.messages(thread.id),
						});
					}}
				>
					刷新新增消息
				</button>
				<Workbench
					segment={materialSegment}
					generateToken={null}
					selectedThreadId="thread"
					onSelectThread={() => {}}
					onGenerationAccepted={() => {}}
					onSubmissionStarted={() => {}}
					onJobAccepted={() => {}}
					onOpenArtifact={(analysis, revision) => {
						opened = `${analysis}/${revision}`;
					}}
				/>
			</div>
		);
	}
	const dispose = await mount(<Screen />);
	try {
		await until(
			() => container.querySelectorAll(".chat-message.assistant").length === 40,
			"Latest 40 assistant messages must be visible",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		check(
			jobGets === 0,
			`Opening 40 historic replies made ${jobGets} extra Job GETs`,
		);
		check(historyGets === 1, "History must wait for explicit pagination");
		check(
			container.textContent?.includes("历史回复 41") &&
				!container.textContent.includes("历史回复 0"),
			"Initial page must show latest history",
		);
		const artifact = container.querySelector<HTMLButtonElement>(
			".chat-artifact-button",
		);
		check(artifact, "Old saved artifact must remain available");
		artifact.click();
		check(
			opened === "saved/old-revision",
			"Artifact must preserve exact historic revision",
		);
		check(
			container.textContent?.includes("历史失败原因"),
			"Historic failure reason must remain visible",
		);
		const retry = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("把原问题放回输入框"),
		);
		check(retry, "Historic retry must remain available");
		retry.click();
		await until(
			() =>
				container.querySelector<HTMLTextAreaElement>("#chat-question")
					?.value === "历史原问题\n\n补充要求：\n旧补充",
			"Retry must visibly restore original question and instructions",
		);
		const more = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("加载更早消息"),
		);
		check(more, "Older history must have explicit pagination");
		more.click();
		await until(
			() => container.querySelectorAll(".chat-message.assistant").length === 42,
			"Explicit pagination must prepend older messages",
		);
		check(
			Number(historyGets) === 2 && jobGets === 0,
			"Pagination must request one bounded page without any Job details",
		);
		const headings = [...container.querySelectorAll(".chat-message h2")].map(
			(node) => node.textContent,
		);
		check(
			headings[0] === "历史回复 0" && headings.at(-1) === "历史回复 41",
			"Pages must remain chronological without duplicates",
		);
		const refresh = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "刷新新增消息",
		);
		check(refresh, "Missing refresh control");
		refresh.click();
		await until(
			() => container.querySelectorAll(".chat-message.assistant").length === 44,
			"Refresh must include new messages and recompute older page boundaries",
		);
		const refreshedHeadings = [
			...container.querySelectorAll(".chat-message h2"),
		].map((node) => node.textContent);
		check(
			new Set(refreshedHeadings).size === 44 &&
				refreshedHeadings[0] === "历史回复 0" &&
				refreshedHeadings.at(-1) === "新回复 43",
			"Refetch must retain chronological unique history when newest page moves",
		);
		const input =
			container.querySelector<HTMLTextAreaElement>("#chat-question");
		check(input, "Missing question input");
		inputValue(input, "仍可输入新问题");
		return "workbench history: 40 replies / 0 Job GETs; newest first page; exact artifact revision; failure retry; explicit older page";
	} finally {
		dispose();
	}
}
