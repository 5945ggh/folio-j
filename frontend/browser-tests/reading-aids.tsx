import { useEffect, useRef, useState } from "react";
import type { components } from "../src/api/schema";
import { DEFAULT_BOOK_UI } from "../src/materials/preferences";
import { applyFramePresentation } from "../src/materials/presentation";
import { partDocument } from "../src/materials/reader-frames";
import type { ScreenAnchor } from "../src/materials/reader-study";
import type { StudyTarget } from "../src/materials/study-api";
import { background, color, computed, luminance, over } from "./color-contrast";
import type { BrowserHarness } from "./harness";
import { fakeSpeech } from "./reader-speech-fixture";
import { checkTranslationResultActions } from "./translation-result-actions";
import "../src/materials/reader-r1.css";

type Direction = "horizontal-tb" | "vertical-rl";

const text = "夕暮れの道を、猫がゆっくりと歩いていた。";
const translation = "暮色中的路上，一只猫正慢慢地走着。";
const reference: components["schemas"]["MaterialProvenance"] = {
	contract_version: "1",
	material_id: "reading-aids",
	version_id: "v1",
	ranges: [
		{
			resource_id: "r",
			spine_index: 0,
			start: 0,
			end: Array.from(text).length,
			exact: text,
			text_sha256: "a".repeat(64),
			prefix: "",
			suffix: "",
		},
	],
};
const target: StudyTarget = {
	reference,
	chapter: {
		id: "chapter",
		material_id: "reading-aids",
		version_id: "v1",
		title: "夕暮れ",
		level: 0,
		resources: [
			{
				id: "r",
				text,
				text_sha256: "a".repeat(64),
				href: "chapter.xhtml",
				css: "p{margin:0 0 1.5em}mark{background:#cbdcfa;color:inherit}",
				html_attributes: {},
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 0,
				end: Array.from(text).length,
				html: `<p><mark data-locator-leaf="0">${text}</mark></p><p>遠くの空には、まだ淡い光が残っている。</p><p>風が木の葉を揺らし、小さな音を立てた。</p>`,
				leaf_start: 0,
				leaf_end: 1,
			},
		],
	},
};

function button(
	h: BrowserHarness,
	label: string,
	scope: ParentNode = h.container,
) {
	const check: BrowserHarness["check"] = h.check;
	const found = [...scope.querySelectorAll("button")].find(
		(node) =>
			(node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
	);
	check(
		found && !found.disabled && found.getClientRects().length > 0,
		`Missing reachable button ${label}`,
	);
	return found;
}

function contained(h: BrowserHarness, node: HTMLElement, name: string) {
	const check: BrowserHarness["check"] = h.check;
	const rect = node.getBoundingClientRect();
	check(
		rect.left >= -1 &&
			rect.right <= innerWidth + 1 &&
			rect.top >= -1 &&
			rect.bottom <= innerHeight + 1,
		`${name} overflows ${innerWidth}×${innerHeight}: ${JSON.stringify(rect.toJSON())}`,
	);
	check(
		node.scrollWidth <= node.clientWidth + 1,
		`${name} has horizontal overflow`,
	);
}

const afterLayout = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);

function contrast(node: Element) {
	const paper = background(node);
	const foreground = over(color(computed(node).color), paper);
	const values = [luminance(foreground), luminance(paper)].sort(
		(a, b) => a - b,
	);
	return ((values[1] ?? 0) + 0.05) / ((values[0] ?? 0) + 0.05);
}

export async function readingAidsRegression(
	h: BrowserHarness,
	preview = false,
) {
	localStorage.clear();
	const speech = fakeSpeech();
	const [
		{ TranslationPanel },
		{ targetIdentity },
		{ SpeechPlaybackBar, useStopSpeechOnLeave },
	] = await Promise.all([
		import("../src/translation/TranslationPanel"),
		import("../src/translation/state"),
		import("../src/speech"),
	]);
	const identity = await targetIdentity(reference);
	const result: components["schemas"]["TranslationResultResponse"] = {
		id: "translation",
		task_id: "task",
		source_id: "source",
		material_id: "reading-aids",
		material_deleted: false,
		reader_deleted: false,
		material_provenance: reference,
		identity_sha256: identity,
		text,
		translation,
		context_before: "",
		context_after: "",
		target_language: "简体中文",
		scheme_name: "默认翻译",
		model_id: "fixture",
		run_id: "run",
		created_at: "2026-10-23T00:00:00Z",
		adopted_segment_ids: [],
		chapter_id: "chapter",
		parts: [],
		scheme_id: "default",
		scheme_revision: 1,
		provider_name: "隔离回归",
		protocol: "chat_completions",
		prompt_version: "v1",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: 1000,
	};
	let shownResult = result;
	h.mock(async (request) => {
		const pathname = new URL(request.url).pathname;
		if (request.method !== "GET")
			throw new Error(
				`Reading aids must not generate: ${request.method} ${pathname}`,
			);
		if (pathname === "/api/settings/translation")
			return Response.json({
				id: "default",
				adapter: "llm",
				revision: 1,
				name: "默认翻译",
				model_id: "fixture",
				target_language: "简体中文",
				before_sentences: 3,
				after_sentences: 0,
				before_characters: 200,
				after_characters: 0,
				max_context_characters: 2000,
				max_target_characters: 2000,
			});
		if (pathname === "/api/materials/reading-aids/translations")
			return Response.json({
				results: [shownResult],
				tasks: [],
				next_offset: null,
			});
		if (pathname === "/api/translation-results/translation")
			return Response.json(shownResult);
		throw new Error(`Unmocked reading aid request ${pathname}`);
	});
	function Reading({
		direction,
		dark,
	}: {
		direction: Direction;
		dark: boolean;
	}) {
		useStopSpeechOnLeave("reading-aids");
		const [open, setOpen] = useState(true);
		const [anchor, setAnchor] = useState<ScreenAnchor>();
		const disposePresentation = useRef<(() => void) | undefined>(undefined);
		useEffect(() => () => disposePresentation.current?.(), []);
		const part = target.chapter.parts[0];
		const resource = target.chapter.resources[0];
		return (
			<main className="reader-r1" data-theme={dark ? "black" : "white"}>
				<header
					style={{
						padding: "12px",
						display: "flex",
						flexWrap: "wrap",
						gap: "6px",
					}}
				>
					<button type="button" onClick={() => setOpen(true)}>
						重开翻译
					</button>
					<button type="button" onClick={speech.start}>
						模拟开始
					</button>
					<button type="button" onClick={speech.end}>
						模拟结束
					</button>
					<button type="button" onClick={speech.error}>
						模拟失败
					</button>
				</header>
				{part && resource && (
					<iframe
						title="阅读原文"
						sandbox="allow-same-origin"
						style={{
							position: "absolute",
							top: "100px",
							left: "24px",
							width: "calc(100% - 48px)",
							height: "calc(100% - 210px)",
							border: 0,
						}}
						srcDoc={partDocument(part, resource, {
							font_size: 20,
							line_height: 1.8,
							writing_mode: direction,
						})}
						onLoad={(event) => {
							const iframe = event.currentTarget;
							const doc = iframe.contentDocument;
							const mark = doc?.querySelector("mark");
							if (!doc || !mark) return;
							disposePresentation.current?.();
							disposePresentation.current = applyFramePresentation(
								doc,
								dark ? "black" : "white",
								DEFAULT_BOOK_UI,
							);
							const bounds = mark.getBoundingClientRect();
							const outer = iframe.getBoundingClientRect();
							setAnchor({
								left: outer.left + bounds.left,
								right: outer.left + bounds.right,
								top: outer.top + bounds.top,
								bottom: outer.top + bounds.bottom,
							});
						}}
					/>
				)}
				{anchor && open && (
					<TranslationPanel
						materialId="reading-aids"
						sourceId="source"
						target={target}
						anchor={anchor}
						direction={direction}
						onClose={() => setOpen(false)}
						onBackToOrigin={() => {}}
					/>
				)}
				<SpeechPlaybackBar />
			</main>
		);
	}
	const params = new URLSearchParams(location.search);
	if (preview) {
		await h.mount(
			<Reading
				direction={
					params.get("direction") === "vertical-rl"
						? "vertical-rl"
						: "horizontal-tb"
				}
				dark={params.get("theme") === "dark"}
			/>,
		);
		await h.until(
			() => !!h.container.querySelector(".translation-output"),
			"Preview translation should render",
		);
		if (["active", "ended", "error"].includes(params.get("speech") ?? "")) {
			button(h, "朗读原文").click();
			await h.until(
				() => speech.utterances.length > 0,
				"Preview should use silent speech fixture",
			);
			speech.start();
			if (params.get("speech") === "ended") speech.end();
			if (params.get("speech") === "error") speech.error();
		}
		return "reading aids preview: real reader document, translation and speech components; mocked API and silent speech events";
	}
	const check: BrowserHarness["check"] = h.check;
	if (params.get("scenario") === "short") {
		const disposeShort = await h.mount(
			<Reading direction="horizontal-tb" dark />,
		);
		try {
			await h.until(
				() => !!h.container.querySelector(".translation-output"),
				"Short viewport should load translation",
			);
			button(h, "朗读原文").click();
			await h.until(
				() => speech.utterances.length > 0,
				"Short viewport should use fake speech",
			);
			speech.error();
			await h.until(
				() =>
					!!h.container.querySelector('.device-speech-bar[data-state="error"]'),
				"Short viewport must expose speech error state",
			);
			await afterLayout();
			const card = h.container.querySelector<HTMLElement>(".translation-card");
			const bar = h.container.querySelector<HTMLElement>(".device-speech-bar");
			const header = card?.querySelector("header");
			const content = card?.querySelector<HTMLElement>(".translation-content");
			check(
				card && bar && header && content,
				"Error state must retain translation, header, scrollable content and speech bar",
			);
			contained(h, card, "Short-screen error translation");
			contained(h, bar, "Short-screen error playback");
			const bounds = card.getBoundingClientRect(),
				playback = bar.getBoundingClientRect();
			check(
				bounds.bottom <= playback.top - 1,
				"Short-screen translation overlaps error playback bar",
			);
			const headerBounds = header.getBoundingClientRect();
			check(
				headerBounds.height < bounds.height && content.clientHeight > 0,
				"Header must leave visible room for the translation content",
			);
			check(
				content.scrollHeight > content.clientHeight &&
					getComputedStyle(content).overflowY === "auto",
				"Short-screen translation content must be scrollable",
			);
			check(
				![...card.querySelectorAll("button")].some((node) =>
					node.textContent?.includes("保存为学习片段"),
				),
				"Translation details must not expose a competing save action",
			);
			const back = button(h, "定位原文", card);
			content.scrollTop = content.scrollHeight;
			await afterLayout();
			check(
				content.scrollTop > 0,
				"The actual content area must scroll on a short screen",
			);
			content.scrollTop +=
				back.getBoundingClientRect().top - content.getBoundingClientRect().top;
			await afterLayout();
			const backBounds = back.getBoundingClientRect();
			check(
				Math.abs(header.getBoundingClientRect().top - headerBounds.top) < 1,
				"Scrolling content must retain the visible header position",
			);
			check(
				backBounds.top >= header.getBoundingClientRect().bottom - 1 &&
					backBounds.bottom <= card.getBoundingClientRect().bottom + 1,
				"Scrolling must expose return-to-origin below the visible header",
			);
			const hit = document.elementFromPoint(
				backBounds.left + backBounds.width / 2,
				backBounds.top + backBounds.height / 2,
			);
			check(
				hit && back.contains(hit),
				"Return-to-origin must remain clickable",
			);
			button(h, "声音与语速", bar).click();
			await h.until(
				() =>
					!!h.container.querySelector(".device-speech-popover:popover-open"),
				"Short-screen speech settings should be reachable",
			);
			const popover = h.container.querySelector<HTMLElement>(
				".device-speech-popover:popover-open",
			);
			check(popover, "Short-screen sound settings must be open");
			check(
				popover.textContent?.includes("audio-busy"),
				"In-place settings must expose the complete error reason",
			);
			contained(h, popover, "Short-screen sound settings");
		} finally {
			disposeShort();
		}
		return `reading aids: ${innerWidth}×${innerHeight}; error card/bar do not overlap; visible header leaves scrollable content and reachable return-to-origin; complete reason in sound popover`;
	}
	let minimumTranslationContrast = Infinity;
	for (const direction of ["horizontal-tb", "vertical-rl"] as const) {
		for (const dark of [false, true]) {
			const dispose = await h.mount(
				<Reading direction={direction} dark={dark} />,
			);
			try {
				await h.until(
					() => !!h.container.querySelector(".translation-output"),
					"Translation should load",
				);
				await afterLayout();
				const card =
					h.container.querySelector<HTMLElement>(".translation-card");
				check(card, "Missing translation card");
				contained(
					h,
					card,
					`${direction}/${dark ? "dark" : "light"} translation`,
				);
				check(
					card.querySelector(".translation-original blockquote")
						?.textContent === text,
					"Original comparison missing",
				);
				check(
					card.querySelector(".translation-output")?.textContent ===
						translation,
					"Translation missing",
				);
				check(
					[...card.querySelectorAll("details")].every(
						(details) => !details.open,
					),
					"Secondary configuration/history should start collapsed",
				);
				check(
					![...card.querySelectorAll("button")].some((node) =>
						node.textContent?.includes("保存为学习片段"),
					),
					"Translation details must not expose a save action",
				);
				const { actions } = checkTranslationResultActions(h, card);
				button(h, "定位原文", card);
				const actionsBounds = actions.getBoundingClientRect();
				check(
					actionsBounds.left >= card.getBoundingClientRect().left &&
						actionsBounds.right <= card.getBoundingClientRect().right + 1,
					"Result action row must fit the floating card",
				);
				const output = card.querySelector<HTMLElement>(".translation-output");
				check(output, "Missing translation text contrast sample");
				const paper = card.closest(".reader-r1");
				check(paper, "Missing Reader paper contrast sample");
				const ratio = contrast(output);
				minimumTranslationContrast = Math.min(
					minimumTranslationContrast,
					ratio,
				);
				check(
					ratio >= 4.5,
					`Translation text contrast ${ratio.toFixed(2)} < 4.5: foreground ${computed(output).color}; card ${computed(card).backgroundColor}; paper ${computed(paper).backgroundColor}; effective ${JSON.stringify(background(output))}`,
				);
				const frame = h.container.querySelector("iframe");
				const mark = frame?.contentDocument?.querySelector("mark");
				check(frame && mark, "Missing selected original");
				const doc = frame.contentDocument;
				check(doc, "Reader document should be accessible");
				const originalStyle = getComputedStyle(doc.body);
				const canvasStyle = getComputedStyle(doc.documentElement);
				check(
					originalStyle.backgroundColor ===
						(dark ? "rgb(25, 25, 25)" : "rgb(255, 255, 255)"),
					"Reader fixture must apply the real theme background",
				);
				check(
					canvasStyle.backgroundColor === originalStyle.backgroundColor &&
						contrast(doc.body) >= 4.5,
					"Reader iframe canvas and original text must share a readable theme",
				);
				const outer = frame.getBoundingClientRect(),
					selected = mark.getBoundingClientRect(),
					rect = card.getBoundingClientRect();
				const anchor = {
					left: outer.left + selected.left,
					right: outer.left + selected.right,
					top: outer.top + selected.top,
					bottom: outer.top + selected.bottom,
				};
				if (innerWidth >= 900)
					check(
						rect.right <= anchor.left ||
							rect.left >= anchor.right ||
							rect.bottom <= anchor.top ||
							rect.top >= anchor.bottom,
						`${direction}: card covers selected original despite available space`,
					);
				if (innerWidth <= 600)
					check(
						rect.bottom >= innerHeight - 100,
						"Narrow translation should be a bottom card",
					);
			} finally {
				dispose();
			}
		}
	}
	const dispose = await h.mount(<Reading direction="horizontal-tb" dark />);
	try {
		await h.until(
			() => !!h.container.querySelector(".translation-output"),
			"Speech fixture should load",
		);
		const initialActions = checkTranslationResultActions(h);
		speech.setVoicesAvailable(false);
		await h.until(
			() =>
				initialActions.speech.disabled &&
				!!initialActions.actions.querySelector(".device-speech-message"),
			"No local voice must visibly disable speech without hiding other result actions",
		);
		check(
			initialActions.speech.textContent?.trim() === "朗读原文" &&
				initialActions.actions.textContent?.includes("声音不可用") &&
				!initialActions.regenerate.disabled &&
				!initialActions.remove.disabled,
			"Unavailable speech must preserve its label and independent translation/deletion actions",
		);
		await afterLayout();
		const unavailableSpeech = initialActions.speech.getBoundingClientRect();
		const unavailableTranslation =
			initialActions.regenerate.getBoundingClientRect();
		const more = initialActions.actions.querySelector<HTMLElement>(
			".translation-more > summary",
		);
		check(
			more && more.getClientRects().length > 0,
			"Unavailable speech must retain the visible more-actions trigger",
		);
		const unavailableMore = more.getBoundingClientRect();
		check(
			Math.abs(
				(unavailableSpeech.top +
					unavailableSpeech.bottom -
					unavailableTranslation.top -
					unavailableTranslation.bottom) /
					2,
			) < 2 &&
				Math.abs(
					(unavailableMore.top +
						unavailableMore.bottom -
						unavailableTranslation.top -
						unavailableTranslation.bottom) /
						2,
				) < 2,
			"Unavailable voice explanation must not displace primary actions onto different rows",
		);
		speech.setVoicesAvailable(true);
		await h.until(
			() => !initialActions.speech.disabled,
			"Available voices must restore speech",
		);
		button(h, "朗读原文").click();
		await h.until(
			() => speech.utterances.length > 0,
			"Speech should use fake synthesizer",
		);
		speech.start();
		await h.until(
			() => h.container.textContent?.includes("正在朗读") ?? false,
			"Start event must show active state",
		);
		const playingActions = checkTranslationResultActions(h);
		check(
			playingActions.speech.textContent?.trim() === "停止朗读" &&
				playingActions.regenerate.textContent?.trim() === "重新翻译",
			"Active speech and retranslation must retain different action labels",
		);
		const settingsTrigger = button(h, "声音与语速");
		const beforeSettings = speech.cancellations;
		settingsTrigger.click();
		await h.until(
			() => !!h.container.querySelector(".device-speech-popover:popover-open"),
			"Sound settings should open in place",
		);
		const popover = h.container.querySelector<HTMLElement>(
			".device-speech-popover:popover-open",
		);
		check(popover, "Missing sound popover");
		contained(h, popover, "Sound popover");
		check(
			contrast(popover) >= 4.5,
			"Dark sound popover text lacks readable contrast",
		);
		await h.until(
			() => popover.contains(document.activeElement),
			"Sound settings must receive keyboard focus",
		);
		const voice = popover.querySelector<HTMLSelectElement>(
			"select:not([aria-label])",
		);
		const rate = popover.querySelector<HTMLInputElement>(
			'input[type="range"][aria-label="朗读语速"]',
		);
		check(voice && rate, "In-place voice and rate controls must be accessible");
		voice.value = "1";
		voice.dispatchEvent(new Event("change", { bubbles: true }));
		h.inputValue(rate, "1.2");
		rate.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		await h.until(
			() => !popover.matches(":popover-open"),
			"Escape must close sound settings",
		);
		check(
			document.activeElement === settingsTrigger,
			"Escape must return focus to sound settings trigger",
		);
		check(
			speech.cancellations === beforeSettings,
			"Opening sound settings interrupted playback",
		);
		check(
			speech.utterances[0]?.rate === 1,
			"Rate changes rewrote the active utterance",
		);
		const beforeClose = speech.cancellations;
		button(h, "关闭翻译（任务继续）").click();
		await h.until(
			() => !h.container.querySelector(".translation-card"),
			"Close should hide translation",
		);
		check(
			speech.cancellations === beforeClose,
			"Closing translation interrupted speech",
		);
		const bar = h.container.querySelector<HTMLElement>(".device-speech-bar");
		check(bar, "Closing translation removed active playback control");
		contained(h, bar, "Active playback bar");
		const activeBounds = bar.getBoundingClientRect();
		button(h, "停止朗读", bar).click();
		await h.until(
			() =>
				!!h.container.querySelector('.device-speech-bar[data-state="resting"]'),
			"Stop should retain the playback bar with replay available",
		);
		const assertStablePlayback = () => {
			const bounds = bar.getBoundingClientRect();
			check(
				Math.abs(bounds.width - activeBounds.width) < 1 &&
					Math.abs(bounds.height - activeBounds.height) < 1,
				"Completed/stopped playback changed the bar dimensions",
			);
			check(
				bar
					.querySelector(".device-speech-summary")
					?.textContent?.includes(text),
				"Completed/stopped playback lost its original summary",
			);
			button(h, "声音与语速", bar);
			contained(h, bar, "Resting playback bar");
		};
		assertStablePlayback();
		button(h, "重播原文", bar).click();
		await h.until(
			() => speech.utterances.length === 2,
			"Replay should start original snapshot",
		);
		check(
			speech.utterances[1]?.text === text,
			"Replay changed original snapshot",
		);
		check(
			speech.utterances[1]?.rate === 1.2 &&
				speech.utterances[1]?.voice?.voiceURI === "fixture-second",
			"Replay must apply the newly selected voice and rate",
		);
		speech.start();
		speech.end();
		await h.until(
			() =>
				!!h.container.querySelector('.device-speech-bar[data-state="resting"]'),
			"End should retain the playback bar with replay available",
		);
		assertStablePlayback();
		button(h, "重播原文", bar);
		button(h, "重开翻译").click();
		await h.until(
			() => !!h.container.querySelector(".translation-output"),
			"Reopened translation should load",
		);
		button(h, "重播原文").click();
		await h.until(
			() => speech.utterances.length === 3,
			"Another read should start",
		);
		speech.error();
		await h.until(
			() =>
				!!h.container.querySelector('.device-speech-bar[data-state="error"]'),
			"Speech error must remain visible",
		);
		const errorBar = h.container.querySelector<HTMLElement>(
			'.device-speech-bar[data-state="error"]',
		);
		check(errorBar, "Speech error bar must remain reachable");
		check(
			[...errorBar.querySelectorAll('[role="status"], [role="alert"]')].some(
				(node) =>
					node.getClientRects().length > 0 &&
					node.textContent?.includes("朗读失败"),
			),
			"Speech error is not announced",
		);
		button(h, "声音与语速", errorBar).click();
		await h.until(
			() => !!h.container.querySelector(".device-speech-popover:popover-open"),
			"Speech error settings must be reachable",
		);
		check(
			h.container
				.querySelector(".device-speech-popover:popover-open")
				?.textContent?.includes("audio-busy"),
			"Complete speech failure must be available in the open settings",
		);
	} finally {
		dispose();
	}
	const { getSpeechController } = await import("../src/speech/browser");
	check(
		getSpeechController().getSnapshot().target === null,
		"Leaving reader must clear replay target",
	);
	const multiline =
		"一行目。\n二行目。\n三行目。\n四行目。\n五行目。\n六行目。";
	const firstRange = reference.ranges[0];
	check(
		firstRange && Array.from(multiline).length < 70,
		"Multiline regression must remain below the old length threshold",
	);
	const multilineReference = {
		...reference,
		ranges: [
			{ ...firstRange, end: Array.from(multiline).length, exact: multiline },
		],
	};
	shownResult = {
		...result,
		text: multiline,
		material_provenance: multilineReference,
		identity_sha256: await targetIdentity(multilineReference),
	};
	const disposeMultiline = await h.mount(
		<main className="reader-r1" data-theme="black">
			<TranslationPanel
				materialId="reading-aids"
				sourceId="source"
				target={{
					reference: multilineReference,
					chapter: {
						...target.chapter,
						resources: target.chapter.resources.map((resource) => ({
							...resource,
							text: multiline,
						})),
						parts: target.chapter.parts.map((part) => ({
							...part,
							end: Array.from(multiline).length,
						})),
					},
				}}
				onClose={() => {}}
				onBackToOrigin={() => {}}
			/>
		</main>,
	);
	try {
		await h.until(
			() => !!h.container.querySelector(".translation-output"),
			"Multiline original should load",
		);
		await afterLayout();
		const original = h.container.querySelector<HTMLElement>(
			".translation-original blockquote",
		);
		check(original, "Multiline comparison must be present");
		const collapsedHeight = original.getBoundingClientRect().height;
		check(
			original.scrollHeight > original.clientHeight + 1,
			"Six-line original should actually overflow the collapsed comparison",
		);
		button(h, "展开原文").click();
		await afterLayout();
		check(
			original.textContent === multiline &&
				original.scrollHeight <= original.clientHeight + 1,
			"Expanded original must expose every line without clipping",
		);
		check(
			original.getBoundingClientRect().height > collapsedHeight,
			"Expanding must increase the comparison height",
		);
		button(h, "收起原文").click();
		await afterLayout();
		check(
			Math.abs(original.getBoundingClientRect().height - collapsedHeight) < 1,
			"Collapsing must restore the original three-line height",
		);
		button(h, "展开原文");
	} finally {
		disposeMultiline();
	}
	return `reading aids: ${innerWidth}px; light/dark × horizontal/vertical fit and source visibility with real iframe presentation; collapsed secondary controls; fake start/stop/end/error; translation close preserves speech; replay snapshot and changed voice/rate; in-place settings Escape/focus; leaving reader clears target; short multiline original expands and collapses; minimum rendered translation contrast ${minimumTranslationContrast.toFixed(2)}:1`;
}
