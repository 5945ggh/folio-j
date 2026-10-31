import type { BrowserHarness } from "./harness";

/** Protect the shared action contract in floating and embedded result hosts. */
export function checkTranslationResultActions(
	h: BrowserHarness,
	host: ParentNode = h.container,
) {
	const check: BrowserHarness["check"] = h.check;
	const output = host.querySelector<HTMLElement>(".translation-output");
	const actions = host.querySelector<HTMLElement>(
		".translation-result-actions",
	);
	check(
		output && actions,
		"A complete translation needs its result action group",
	);
	check(
		output.nextElementSibling === actions &&
			(actions.tagName === "FIELDSET" ||
				actions.getAttribute("role") === "group") &&
			actions.getAttribute("aria-label") === "译文操作",
		"Result actions must be one accessible group directly below the output",
	);
	const speech = actions.querySelector<HTMLButtonElement>(
		".device-speech > button",
	);
	const regenerate = actions.querySelector<HTMLButtonElement>(
		'[aria-label="重新翻译"], [aria-label="停止翻译"], [aria-label="核实原提交"]',
	);
	const remove = actions.querySelector<HTMLButtonElement>(
		'[aria-label="删除此处翻译"]',
	);
	check(
		speech && regenerate && remove,
		"Speech, translation and deletion share the result group",
	);
	check(
		speech.textContent?.trim() &&
			regenerate.textContent?.trim() ===
				regenerate.getAttribute("aria-label") &&
			!remove.textContent?.trim(),
		"Speech and translation have visible labels; deletion stays a compact icon",
	);
	check(
		speech.querySelector("svg") &&
			regenerate.querySelector("svg") &&
			remove.querySelector("svg") &&
			speech.querySelector("svg")?.innerHTML !==
				regenerate.querySelector("svg")?.innerHTML,
		"Speech and translation must retain distinct icons",
	);
	check(
		!host.querySelector(".translation-original .device-speech") &&
			!host.querySelector(".translation-result-meta small") &&
			!host
				.querySelector(".translation-result-view")
				?.textContent?.includes("· 已留存") &&
			!host.querySelector('[aria-label="返回原处"]') &&
			![...host.querySelectorAll("button")].some(
				(button) => button.textContent?.trim() === "返回原处",
			),
		"Complete results omit duplicate original speech, saved-language status and return-to-origin action",
	);
	return { actions, speech, regenerate, remove };
}
