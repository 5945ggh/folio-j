import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import type { fakeSpeech } from "./reader-speech-fixture";

export const segmentSelectionToolbar =
	".segment-selection-toolbar[role=toolbar]";

export async function checkSegmentSelectionSpeech(
	h: BrowserHarness,
	{
		speech,
		original,
		before,
		after,
		requests,
		failedDictionary,
		preview,
		capture,
	}: {
		speech: ReturnType<typeof fakeSpeech>;
		original: string;
		before: string;
		after: string;
		requests: readonly components["schemas"]["DictionaryLookupRequest"][];
		failedDictionary: boolean;
		preview: boolean;
		capture: boolean;
	},
) {
	const check: BrowserHarness["check"] = h.check;
	const { browserPointer: pointer } = window as Window & {
		browserPointer?: (events: unknown[]) => Promise<void>;
	};
	check(
		pointer,
		"Runner must provide trusted pointer input for the speech controls",
	);
	const find = <T extends Element>(
		selector: string,
		within: Element = h.container,
	) => {
		const node = within.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const action = (label: string, within: Element = h.container) => {
		const node = [...within.querySelectorAll("button")].find(
			(item) =>
				(item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
		);
		check(node && !node.disabled, `Missing enabled ${label}`);
		return node;
	};
	const press = async (node: HTMLButtonElement) => {
		const { left, top, width, height } = node.getBoundingClientRect();
		const at = { x: left + width / 2, y: top + height / 2 };
		check(
			width > 0 &&
				height > 0 &&
				node.contains(document.elementFromPoint(at.x, at.y)),
			`${node.getAttribute("aria-label") ?? node.textContent?.trim()} must be reachable by pointer`,
		);
		await pointer([
			{ type: "mouseMoved", ...at },
			{
				type: "mousePressed",
				...at,
				button: "left",
				buttons: 1,
				clickCount: 1,
			},
			{
				type: "mouseReleased",
				...at,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		]);
	};
	const afterLayout = () =>
		new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
	const select = async (
		element: Element,
		text: string,
		start = 0,
		end?: number,
	) => {
		element.scrollIntoView({ block: "nearest", behavior: "instant" });
		await afterLayout();
		const first = element.firstChild;
		const last = element.lastChild;
		check(
			first instanceof Text && last instanceof Text,
			"Selection needs visible text endpoints",
		);
		const range = new Range();
		range.setStart(first, start);
		range.setEnd(last, end ?? last.length);
		const selection = document.getSelection();
		check(selection, "Segment needs a native selection");
		selection.removeAllRanges();
		selection.addRange(range);
		check(
			selection.toString() === text,
			`Fixture must select ${text.length} exact characters`,
		);
		await h.until(
			() => !!h.container.querySelector(segmentSelectionToolbar),
			"Segment selection must expose the shared toolbar",
		);
		const toolbar = find(segmentSelectionToolbar);
		const groups = toolbar.querySelectorAll(".selection-action-group");
		const actions = [...toolbar.querySelectorAll("button")];
		const lookupAvailable = Array.from(text).length <= 512;
		check(
			toolbar.classList.contains("selection-actions") &&
				groups.length === 1 &&
				groups[0]?.querySelectorAll("button").length === actions.length &&
				!toolbar.querySelector(".selection-action-divider"),
			"The Segment toolbar must use one shared action group without empty groups or dividers",
		);
		check(
			actions.map((item) => item.textContent?.trim()).join("|") ===
				(lookupAvailable ? "朗读|查词" : "朗读"),
			"The Segment toolbar must show only speech followed by lookup when available",
		);
		const [speaker, lookup] = actions;
		check(
			speaker?.querySelector(':scope > svg[aria-hidden="true"]') &&
				(!lookupAvailable ||
					(lookup?.classList.contains("secondary") &&
						lookup.getAttribute("aria-label") === "查所选文字" &&
						!lookup.querySelector("svg"))),
			"Speech must have a speaker icon and lookup must remain accessible, secondary and text-only",
		);
		return toolbar;
	};
	const playing = async (
		text: string,
		count: number,
		within: Element = h.container,
	) => {
		await h.until(
			() =>
				speech.utterances.length === count &&
				within.querySelector(".device-speech-summary")?.textContent === text,
			"Fake voice and playback bar must receive exactly one matching speech snapshot",
		);
		const utterance = speech.utterances.at(-1);
		check(
			utterance?.text === text && utterance.lang === "ja-JP",
			"Device speech must receive the full selected Japanese text",
		);
		speech.start();
	};
	const source = find(".segment-original-focus");
	const selectedOriginal = original.slice(0, 2);
	if (preview) {
		const toolbar = await select(source, selectedOriginal, 0, 2);
		await Promise.all(toolbar.getAnimations().map(({ finished }) => finished));
		return "segment selection preview: original selection with lookup and device speech";
	}
	action("朗读原文").click();
	await playing(original, 1);
	const beforeSelection = speech.cancellations;
	const firstToolbar = await select(source, selectedOriginal, 0, 2);
	const utteranceCountAfterSelection = speech.utterances.length;
	check(
		utteranceCountAfterSelection === 1 &&
			speech.cancellations === beforeSelection &&
			find(".device-speech-summary").textContent === original &&
			requests.length === 0,
		"Changing selection must preserve whole-original playback and issue no lookup",
	);
	await press(action("朗读", firstToolbar));
	await playing(selectedOriginal, 2);
	check(
		speech.cancellations > beforeSelection &&
			requests.length === 0 &&
			!h.container.querySelector(".dict-deck"),
		"Selection speech must replace whole-original playback without querying the dictionary",
	);
	if (failedDictionary) {
		action("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-config [role=alert]"),
			"Dictionary failure must be visible before trying speech again",
		);
		action("关闭查词设置").click();
	} else {
		const toolbar = await select(source, selectedOriginal, 0, 2);
		await press(action("查所选文字", toolbar));
		await h.until(
			() => !!h.container.querySelector(".dict-definitions"),
			"Selection must allow manual lookup before dictionary setup and while automatic lookup is off",
		);
		check(
			requests.at(-1)?.text === selectedOriginal &&
				requests.at(-1)?.selection_end === 2 &&
				action("即时查词").getAttribute("aria-pressed") === "false",
			"Manual selection lookup must send the selection without enabling automatic lookup",
		);
		action("关闭当前词卡").click();
	}
	const inlineText = "と散歩する";
	const inlineToolbar = await select(
		find(".analysis-markdown p"),
		inlineText,
		1,
		2,
	);
	await press(action("朗读", inlineToolbar));
	await playing(inlineText, 3);
	const afterToolbar = await select(
		find('[aria-label="已保存后文"] span'),
		after,
	);
	await press(action("朗读", afterToolbar));
	await playing(after, 4);
	const reader = find<HTMLElement>(".segment-reader");
	reader.scrollTop = reader.scrollHeight;
	await afterLayout();
	const pageEnd = reader.scrollTop;
	check(
		pageEnd > 0 && pageEnd + reader.clientHeight >= reader.scrollHeight - 1,
		"Speech regression must open complete materials from the end of a scrollable reading page",
	);
	action("查看完整原文与资料").click();
	const dialogSelector = ".segment-material-dialog[open]";
	await h.until(
		() => !!h.container.querySelector(dialogSelector),
		"Complete material dialog must open",
	);
	const dialog = find(dialogSelector);
	check(
		find(".device-speech-summary", dialog).textContent === after,
		"The playing snapshot must be reachable inside the top-layer dialog",
	);
	const longText = find(".segment-material-field p", dialog);
	const dialogToolbar = await select(longText, before);
	check(
		Math.abs(reader.scrollTop - pageEnd) <= 1,
		"Opening the material dialog while speaking must preserve the page-end reading position",
	);
	const toolbarRect = dialogToolbar.getBoundingClientRect();
	const bodyRect = find(
		".segment-material-body",
		dialog,
	).getBoundingClientRect();
	check(
		Array.from(before).length > 512 && dialog.contains(dialogToolbar),
		"The long context fixture must open its speech action within the dialog",
	);
	check(
		toolbarRect.top >= bodyRect.top && toolbarRect.bottom <= bodyRect.bottom,
		"The selection toolbar must leave the dialog title and playback controls unobstructed",
	);
	await press(action("朗读", dialogToolbar));
	await playing(before, 5, dialog);
	const beforeStop = speech.cancellations;
	await press(action("停止朗读", dialog));
	await h.until(
		() =>
			speech.cancellations > beforeStop &&
			!!dialog.querySelector('.device-speech-primary[data-action="replay"]'),
		"The dialog stop control must retire the active attempt and offer replay",
	);
	await press(
		find<HTMLButtonElement>(
			'.device-speech-primary[data-action="replay"]',
			dialog,
		),
	);
	await playing(before, 6, dialog);
	if (capture) {
		await select(longText, before);
		return `segment selection speech capture: ${innerWidth}px; dialog selection and playback controls`;
	}
	const beforeClose = speech.cancellations;
	action("关闭原文与资料", dialog).click();
	await h.until(
		() =>
			!h.container.querySelector(dialogSelector) &&
			h.container.querySelector(".device-speech-summary")?.textContent ===
				before,
		"Closing complete materials must move playback controls back to the page",
	);
	await afterLayout();
	check(
		speech.cancellations === beforeClose && speech.utterances.length === 6,
		"Closing the material dialog must continue the same speech attempt",
	);
	check(
		Math.abs(reader.scrollTop - pageEnd) <= 1,
		"Closing the material dialog while speaking must preserve the page-end reading position",
	);
	find<HTMLAnchorElement>(
		'.segment-tools a[aria-label="首页（素材库）"]',
	).click();
	await h.until(
		() =>
			h.container.textContent?.includes("已离开片段") === true &&
			speech.cancellations > beforeClose &&
			!h.container.querySelector(".device-speech-bar") &&
			!h.container.querySelector(segmentSelectionToolbar),
		"Leaving Segment must stop speech and retire its transient controls",
	);
	return `segment selection speech: ${innerWidth}px; original, inline Markdown and long dialog context, ${failedDictionary ? "failed dictionary status" : "manual lookup with automatic lookup off"}, replace, stop, replay, dialog close and leave`;
}
