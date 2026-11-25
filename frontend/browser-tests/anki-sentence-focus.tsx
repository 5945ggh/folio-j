import { createRef } from "react";
import type {
	AnkiConfigurationResponse,
	AnkiExportInput,
	AnkiFieldDefinition,
} from "../src/anki/api";
import type { AnkiMaterialContext } from "../src/anki/context";
import type { BrowserHarness } from "./harness";

export async function ankiSentenceFocusRegression(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const { AnkiComposer } = await import("../src/anki/AnkiComposer");
	const card = createRef<HTMLElement>();
	const scope = { url: "http://localhost:8765", profile: "重点测试" };
	const textField = (
		id: string,
		label: string,
		target_field: string,
		source: AnkiFieldDefinition["source"],
		multiline = false,
	): AnkiFieldDefinition => ({
		id,
		label,
		target_field,
		type: "text",
		source,
		presentation: "common",
		multiline,
		required: target_field === "Word",
	});
	const config: AnkiConfigurationResponse = {
		id: "sentence-focus",
		name: "重点测试",
		deck: { scope, id: "1", name: "日语" },
		note_type: {
			kind: "builtin",
			id: "folio-j.vocabulary-recall",
			version: 2,
			name: "Folio-J 词汇 v2",
		},
		fields: [
			textField("selection", "词条", "Word", "selection"),
			textField("sentence", "原句", "Sentence", "sentence", true),
			textField("partOfSpeech", "词性", "PartOfSpeech", "manual"),
		],
	};
	const requests: AnkiExportInput[] = [];
	h.mock(async (request) => {
		switch (new URL(request.url).pathname) {
			case "/api/dictionary":
				return Response.json({ ready: false });
			case "/api/anki/builtins":
				return Response.json({
					note_types: [],
					export_presets: [],
					shared_css: "",
				});
			case "/api/settings/anki/configurations":
				return Response.json([config]);
			case "/api/anki/catalog":
				return Response.json({
					endpoint: scope.url,
					profile: scope.profile,
					protocol: "v1",
					decks: [{ id: "1", name: "日语" }],
					note_types: [],
				});
			case "/api/anki/export": {
				const payload: AnkiExportInput = await request.json();
				requests.push(payload);
				return Response.json({
					status: payload.allow_duplicate ? "created" : "duplicate",
					media_may_remain: false,
					type_created: false,
				});
			}
			default:
				throw Error(`Unexpected Anki request: ${request.url}`);
		}
	});
	const context: AnkiMaterialContext = {
		key: "sentence-focus",
		origin: "dictionary",
		selection: "取る",
		sentence: "𠮷が取る。次も取る。",
		sentenceFocus: { start: 2, end: 4, text: "取る" },
		sentenceRuby: [{ start: 2, end: 3, reading: "と" }],
		sourceMetadata: "試験",
		reference: null,
		dictionarySeed: {
			surface: "取る",
			term: "取る",
			reading: "とる",
			partOfSpeech: "动词",
			entries: [],
		},
	};
	const dispose = await h.mount(
		<div className="reader-r1">
			<AnkiComposer
				cardRef={card}
				anchor={{ left: 480, right: 520, top: 140, bottom: 160 }}
				context={context}
				materialId="book"
				chapterSegments={[]}
				chapterTranslations={[]}
				recordsStatus="ready"
				settingsState={null}
				onClose={() => undefined}
				onExported={() => undefined}
			/>
		</div>,
	);
	const button = (label: string) =>
		Array.from(card.current?.querySelectorAll("button") ?? []).find(
			(item) => item.textContent?.trim() === label,
		);
	const referenceToggle = () =>
		card.current?.querySelector<HTMLButtonElement>(".anki-ref-toggle");
	const quote = () =>
		card.current?.querySelector<HTMLButtonElement>(".anki-quote-inline");
	const editor = () =>
		card.current?.querySelector<HTMLTextAreaElement>("#anki-f-sentence");
	const partOfSpeech = () =>
		card.current?.querySelector<HTMLInputElement>("#anki-f-partOfSpeech");
	const headword = () =>
		card.current?.querySelector<HTMLInputElement>("#anki-f-selection");
	const confirmation = () => button("仍作为新笔记发送");
	const sentenceFor = (index: number) =>
		requests[index]?.fields.find((field) => field.target_field === "Sentence");
	try {
		await h.until(() => Boolean(quote()), "载入带重点的原句");
		check(partOfSpeech()?.value === "动词", "词性自动填入可编辑字段");
		referenceToggle()?.click();
		await h.until(
			() => referenceToggle()?.getAttribute("aria-expanded") === "false",
			"回到制卡草稿",
		);
		check(
			quote()?.querySelector("mark")?.previousSibling?.textContent === "𠮷が",
			"默认重点标在选中的第一次出现位置",
		);
		await h.until(() => button("发送到 Anki")?.disabled === false, "目标可用");
		button("发送到 Anki")?.click();
		await h.until(() => Boolean(confirmation()), "等待第一次重复确认");
		check(sentenceFor(0)?.sentence_focus?.start === 2, "首次发送默认重点");

		quote()?.click();
		await h.until(
			() => Boolean(editor()) && document.activeElement === editor(),
			"打开原句就地编辑框",
		);
		const input = editor();
		check(input, "原句输入框可用");
		const start = input.value.lastIndexOf("取る");
		input.setSelectionRange(start, start + "取る".length);
		input.dispatchEvent(
			new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }),
		);
		await h.until(
			() => button("设为重点")?.disabled === false,
			"文字选区可设置",
		);
		const setFocus = button("设为重点");
		check(setFocus, "重点操作按钮可用");
		setFocus.focus();
		check(editor() === input, "键盘移焦到重点按钮时保留编辑框和选区");
		setFocus.click();
		await h.until(() => !confirmation(), "修改重点使第一次重复确认失效");
		check(
			card.current?.querySelector(".anki-sentence-focus-status mark")
				?.textContent === "取る",
			"原句编辑时显示已设置的重点",
		);
		partOfSpeech()?.focus();
		await h.until(() => !editor(), "离开编辑区域后折叠原句");
		check(
			quote()?.querySelector("mark")?.previousSibling?.textContent ===
				"𠮷が取る。次も",
			"折叠原句准确标记重复文字的位置",
		);
		button("发送到 Anki")?.click();
		await h.until(() => Boolean(confirmation()), "等待修改后的重复确认");
		check(
			sentenceFor(1)?.sentence_focus?.start === 7 &&
				sentenceFor(1)?.sentence_focus?.end === 9 &&
				sentenceFor(1)?.sentence_ruby?.[0]?.reading === "と",
			"发送用码点记录重点并保留原有注音",
		);

		button("清除重点")?.click();
		await h.until(() => !quote()?.querySelector("mark"), "清除当前重点");
		check(!confirmation() && requests.length === 2, "清除重点使重复确认失效");
		const word = headword();
		check(word, "词头可编辑");
		h.inputValue(word, "読まない");
		await h.until(() => partOfSpeech()?.value === "", "更换词头清除自动词性");
	} finally {
		dispose();
	}
}
