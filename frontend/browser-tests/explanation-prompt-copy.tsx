import { useState } from "react";
import type { BrowserHarness } from "./harness";

export async function explanationPromptCopy(h: BrowserHarness) {
	const { NewAnalysisActions } = await import(
		"../src/segments/NewAnalysisActions"
	);
	const { container, until, mount, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	const copied: string[] = [];
	const requests: string[] = [];
	let readMode: "normal" | "error" | "pending" = "normal";
	let clipboardMode: "normal" | "error" | "pending" = "normal";
	let releaseRead: ((response: Response) => void) | undefined;
	let releaseCopy: (() => void) | undefined;
	let creates = 0;
	let generates = 0;
	const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	let itemWrites = 0;
	const writeText = async (text: string) => {
		if (clipboardMode === "error") throw new Error("permission denied");
		copied.push(text);
		if (clipboardMode === "pending")
			await new Promise<void>((resolve) => {
				releaseCopy = resolve;
			});
	};
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText,
			async write(items: ClipboardItem[]) {
				itemWrites++;
				const item = items[0];
				check(
					item,
					"Promised clipboard write must include its plain-text payload",
				);
				const text = await (await item.getType("text/plain")).text();
				await writeText(text);
			},
		},
	});
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		check(
			request.method === "GET" && path.endsWith("/explanation-prompt"),
			"Copying prompts must never write content or start a discussion/model request",
		);
		requests.push(path);
		if (readMode === "pending")
			return new Promise<Response>((resolve) => {
				releaseRead = resolve;
			});
		if (readMode === "error")
			return Response.json({ detail: "读取失败" }, { status: 500 });
		return Response.json({ prompt: `提示词：${path}\n保留原文与上下文。` });
	});
	function Fixture() {
		const [segmentId, setSegmentId] = useState("first");
		return (
			<div
				className="app-shell segment-study-shell"
				style={{ display: "block" }}
			>
				<NewAnalysisActions
					segmentId={segmentId}
					disabled={false}
					onCreate={() => creates++}
					onExplain={() => generates++}
				/>
				<button type="button" onClick={() => setSegmentId("second")}>
					切换片段
				</button>
			</div>
		);
	}
	const button = (label: string) => {
		const found = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.trim() === label);
		check(found && !found.disabled, `Missing prompt-copy action ${label}`);
		return found;
	};
	const key = (node: HTMLElement, value: string) =>
		node.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: value,
				bubbles: true,
				cancelable: true,
			}),
		);
	async function chooseCopy() {
		const trigger = button("＋ 新建讲解");
		await until(
			() => trigger.getAttribute("aria-expanded") === "false",
			"Creation menu closure must settle before reopening",
		);
		trigger.focus();
		key(trigger, "ArrowUp");
		await until(
			() =>
				!!container.querySelector(".segment-create-menu:popover-open") &&
				document.activeElement === button("复制讲解提示词"),
			"ArrowUp must reach the copy choice on the first menu level",
		);
		const box = container
			.querySelector(".segment-create-menu")
			?.getBoundingClientRect();
		check(
			box &&
				box.left >= 0 &&
				box.right <= innerWidth &&
				box.bottom <= innerHeight,
			"Creation menu must fit the viewport",
		);
		button("复制讲解提示词").click();
	}
	let dispose = await mount(<Fixture />);
	try {
		await until(
			() => !!container.querySelector("#manual-analysis-create"),
			"Mount copy menu",
		);
		check(
			requests.length === 0,
			"Mounting must not retrieve a prompt before choosing copy",
		);
		await chooseCopy();
		await until(
			() => container.textContent?.includes("已复制讲解提示词") === true,
			"One menu choice must read and copy the prepared prompt with an accurate receipt",
		);
		check(
			copied.length === 1 &&
				copied[0]?.includes("/first/") &&
				creates === 0 &&
				generates === 0,
			"Prompt copying must preserve the selected segment and avoid creation callbacks",
		);
		check(
			document.activeElement === button("＋ 新建讲解") &&
				!container.querySelector(":popover-open"),
			"Successful copy must close the menu and keep focus on its trigger",
		);
		check(
			itemWrites === 1,
			"Initial copy must start a promised ClipboardItem write during its menu gesture",
		);
		clipboardMode = "error";
		await chooseCopy();
		await until(
			() => !!container.querySelector(".segment-prompt-fallback textarea"),
			"Clipboard denial must expose the complete text for manual copying",
		);
		const text = container.querySelector<HTMLTextAreaElement>(
			".segment-prompt-fallback textarea",
		);
		check(
			text?.readOnly && text.value === copied[0],
			"Manual fallback must retain the exact prompt",
		);
		button("选择文本").click();
		check(
			text.selectionStart === 0 && text.selectionEnd === text.value.length,
			"Select text must select the complete prompt for keyboard and touch copying",
		);
		const fallbackBox = container
			.querySelector(".segment-prompt-fallback")
			?.getBoundingClientRect();
		check(
			fallbackBox &&
				fallbackBox.left >= 0 &&
				fallbackBox.right <= innerWidth &&
				fallbackBox.top >= 0 &&
				fallbackBox.bottom <= innerHeight,
			"The complete manual-copy fallback must fit the viewport",
		);
		key(text, "Escape");
		await until(
			() =>
				container.querySelector<HTMLElement>(".segment-prompt-feedback")
					?.hidden === true && document.activeElement === button("＋ 新建讲解"),
			"Escape from the manual text must dismiss feedback and restore the menu trigger",
		);
		await chooseCopy();
		await until(
			() => !!container.querySelector(".segment-prompt-fallback textarea"),
			"A dismissed fallback must allow another independent copy attempt",
		);
		const readsBeforeRetry = requests.length;
		clipboardMode = "normal";
		button("重试复制").click();
		await until(
			() =>
				copied.length === 2 &&
				container.textContent?.includes("已复制讲解提示词") === true,
			"Clipboard retry must copy retained text directly",
		);
		check(
			requests.length === readsBeforeRetry,
			"Clipboard retry must not reread or replace prepared text",
		);
		readMode = "error";
		await chooseCopy();
		await until(
			() => container.textContent?.includes("讲解提示词读取失败") === true,
			"Reading failure must remain distinct from clipboard failure",
		);
		check(
			!container.querySelector("textarea"),
			"A failed read must not offer an old prompt",
		);
		readMode = "normal";
		button("重试读取并复制").click();
		await until(
			() => Number(copied.length) === 3,
			"Read retry must finish copying without another menu choice",
		);
		readMode = "pending";
		await chooseCopy();
		await until(() => !!releaseRead, "Delay prompt read for route transition");
		button("切换片段").click();
		await until(
			() =>
				container.querySelector<HTMLElement>(".segment-prompt-feedback")
					?.hidden === true,
			"Changing segment must retire the old copy receipt and request",
		);
		releaseRead?.(Response.json({ prompt: "late old segment" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		check(
			Number(copied.length) === 3,
			"A late old-segment read must never write the clipboard",
		);
		readMode = "normal";
		clipboardMode = "pending";
		await chooseCopy();
		await until(() => !!releaseCopy, "Delay clipboard settlement");
		dispose();
		dispose = await mount(<Fixture />);
		await until(
			() => !!container.querySelector("#manual-analysis-create"),
			"Remount while old clipboard is pending",
		);
		releaseCopy?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		check(
			container.querySelector<HTMLElement>(".segment-prompt-feedback")?.hidden,
			"A late clipboard completion must not revive feedback in a new segment lifecycle",
		);
		check(
			creates === 0 && generates === 0,
			"All prompt-copy outcomes must leave creation and discussion untouched",
		);
	} finally {
		dispose();
		if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
}
