import { createRef } from "react";
import type { AnkiConfigurationResponse } from "../src/anki/api";
import type {
	DictionaryMatch,
	DictionaryRequest,
} from "../src/dictionary/dictionary-api";
import { type BrowserHarness, readGate } from "./harness";

export async function ankiReferenceSearchRegression(h: BrowserHarness) {
	const { AnkiComposer } = await import("../src/anki/AnkiComposer");
	const check: BrowserHarness["check"] = h.check;
	const dictionaryId = "local-dictionary";
	const entry = (term: string, definition: string): DictionaryMatch => ({
		id: term,
		dictionary_id: dictionaryId,
		term,
		reading: "",
		surface: term,
		start: 0,
		end: Array.from(term).length,
		definitions: [{ tag: "p", text: definition }],
	});
	const scope = { url: "http://localhost:8765", profile: "A" };
	const configuration: AnkiConfigurationResponse = {
		id: "search-fixture",
		name: "词卡",
		deck: { scope, id: "1", name: "日语" },
		note_type: { kind: "external", id: "2", name: "词汇", scope },
		fields: [
			{
				id: "word",
				label: "词条",
				source: "selection",
				type: "text",
				presentation: "common",
				required: true,
				target_field: "Word",
				multiline: false,
			},
		],
	};
	const lateLookup = readGate();
	let lateReturned = false;
	const requests: DictionaryRequest[] = [];
	h.mock(async (request) => {
		switch (new URL(request.url).pathname) {
			case "/api/dictionary":
				return Response.json({ ready: true, dictionary_id: dictionaryId });
			case "/api/dictionary/lookup": {
				const payload: DictionaryRequest = await request.json();
				requests.push(payload);
				if (payload.text === "遅い") {
					await lateLookup.promise;
					lateReturned = true;
				}
				const first = entry(payload.text, `释义 ${payload.text}`);
				return Response.json({
					matches:
						payload.text === "新しい"
							? [
									first,
									...Array.from({ length: 6 }, (_, index) => ({
										...entry(payload.text, `同音义项 ${index + 2}`),
										id: `${first.id}-${index + 2}`,
									})),
								]
							: [first],
				});
			}
			case "/api/anki/builtins":
				return Response.json({
					shared_css: "",
					note_types: [],
					export_presets: [],
				});
			case "/api/settings/anki/configurations":
				return Response.json([configuration]);
			case "/api/anki/catalog":
				return Response.json({
					endpoint: scope.url,
					profile: scope.profile,
					protocol: "v1",
					decks: [{ id: "1", name: "日语" }],
					note_types: [{ id: "2", name: "词汇" }],
				});
			case "/api/anki/note-type-fields":
				return Response.json({ fields: ["Word"] });
			default:
				throw Error(`Unexpected Anki reference request: ${request.url}`);
		}
	});
	const card = createRef<HTMLElement>();
	const dispose = await h.mount(
		<div className="reader-r1" data-theme="black">
			<AnkiComposer
				cardRef={card}
				anchor={{ left: 480, right: 520, top: 140, bottom: 160 }}
				context={{
					key: "dictionary-search",
					origin: "dictionary",
					selection: "読んだ",
					sentence: "本を読んだ。",
					sourceMetadata: "本",
					reference: null,
					dictionarySeed: {
						surface: "読んだ",
						term: "読む",
						reading: "よむ",
						entries: [entry("読む", "原查词页的上下文义项")],
					},
					lookupInput: { text: "本を読んだ。", position: 2 },
				}}
				materialId="book"
				chapterSegments={[]}
				chapterTranslations={[]}
				recordsStatus="ready"
				settingsState={null}
				onClose={() => {
					throw Error("Composing in search should not close the Anki window");
				}}
				onExported={() => undefined}
			/>
		</div>,
	);
	try {
		const search = () =>
			card.current?.querySelector<HTMLInputElement>(
				'input[aria-label="搜索词典"]',
			);
		const button = (label: string) =>
			card.current?.querySelector<HTMLButtonElement>(
				`button[aria-label="${label}"]`,
			);
		const tab = (label: string) =>
			[
				...(card.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
					[]),
			].find((item) => item.textContent?.startsWith(label));
		const result = () =>
			card.current?.querySelector(".anki-ref-card")?.textContent ?? "";
		const press = (target: HTMLElement, key: string, isComposing = false) =>
			target.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					bubbles: true,
					cancelable: true,
					isComposing,
				}),
			);
		await h.until(
			() =>
				search()?.value === "読む" &&
				result().includes("原查词页的上下文义项") &&
				button("提交词典搜索")?.disabled === false,
			"即时查词的词条预填到搜索框，保留原查询页",
		);
		const input = search();
		check(input, "参考栏提供有名称的搜索框");
		const searchBar = input.closest("search");
		check(searchBar, "搜索框包住输入区和两侧按钮");
		const idleBorder = getComputedStyle(searchBar).borderTopColor;
		input.focus();
		check(
			getComputedStyle(searchBar).borderTopColor !== idleBorder &&
				getComputedStyle(input).outlineStyle === "none",
			"聚焦搜索输入时，只有搜索栏外框高亮",
		);
		input.dispatchEvent(
			new CompositionEvent("compositionstart", { bubbles: true }),
		);
		h.inputValue(input, "おそい");
		press(input, "Enter", true);
		press(input, "Escape", true);
		h.inputValue(input, "遅い");
		input.dispatchEvent(
			new CompositionEvent("compositionend", { bubbles: true }),
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		check(requests.length === 0, "候选确认、输入或初始预填都不查询词典");
		press(input, "Enter");
		await h.until(
			() => requests.some((request) => request.text === "遅い"),
			"回车提交查词",
		);
		h.inputValue(input, " 新しい ");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		button("提交词典搜索")?.click();
		await h.until(
			() => result().includes("释义 新しい"),
			"查询词典中原结果之外的新词",
		);
		check(
			card.current
				?.querySelector(".anki-ref-card:last-child")
				?.textContent?.includes("同音义项 7"),
			"搜索结果可以滚动到第七条及之后的词条",
		);
		check(
			requests[1]?.text === "新しい" &&
				requests[1]?.expected_dictionary_id === dictionaryId &&
				requests[1]?.auto_expand === false &&
				requests[1]?.position === undefined,
			"新查询只把输入的词作为本地查词目标",
		);
		lateLookup.release();
		await h.until(() => lateReturned, "旧请求迟到");
		tab("翻译")?.click();
		await h.until(
			() => !search() && tab("翻译")?.getAttribute("aria-selected") === "true",
			"翻译页不显示搜索框",
		);
		tab("词典")?.click();
		await h.until(
			() =>
				search()?.value.trim() === "新しい" && result().includes("释义 新しい"),
			"切回词典后保留新查询，忽略迟到结果",
		);
		const toggle =
			card.current?.querySelector<HTMLButtonElement>(".anki-ref-toggle");
		check(toggle, "参考栏可收起");
		toggle.click();
		await h.until(
			() => toggle.getAttribute("aria-expanded") === "false",
			"收起参考栏",
		);
		check(
			card.current?.querySelector<HTMLInputElement>(".anki-headword-input")
				?.value === "読む",
			"查询与清理只影响参考栏，从未改动草稿",
		);
		toggle.click();
		await h.until(
			() =>
				toggle.getAttribute("aria-expanded") === "true" &&
				search()?.value.trim() === "新しい" &&
				result().includes("释义 新しい"),
			"再次展开时继续当前查词",
		);
		button("清空词典搜索")?.click();
		await h.until(
			() => search()?.value === "" && result().includes("原查词页的上下文义项"),
			"清空输入恢复原查询页",
		);
		const restoredInput = search();
		check(restoredInput, "清空后搜索框保持可编辑");
		const requestCount = requests.length;
		const longWord = "𠮷".repeat(8193);
		h.inputValue(restoredInput, longWord);
		await h.until(
			() => restoredInput.getAttribute("aria-invalid") === "true",
			"输入上限按码点计算",
		);
		press(restoredInput, "Enter");
		check(
			restoredInput.value === longWord && requests.length === requestCount,
			"长输入保留原值且不会提交截断后的词",
		);
		const clearSearch = button("清空词典搜索");
		check(clearSearch, "有编辑时可清空查询");
		clearSearch.focus();
		press(clearSearch, "Escape");
		await h.until(
			() =>
				document.activeElement === restoredInput &&
				restoredInput.value === "読む" &&
				result().includes("原查词页的上下文义项"),
			"Escape 恢复初始查询和原词条，保留制卡浮窗",
		);
	} finally {
		lateLookup.release();
		dispose();
	}
}
