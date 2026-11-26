import { createRef } from "react";
import builtinAsset from "../../backend/src/app/anki_builtin_types.json";
import type {
	AnkiBuiltins,
	AnkiConfigurationResponse,
	AnkiExportInput,
	AnkiFieldDefinition,
} from "../src/anki/api";
import { ankiReferenceSearchRegression } from "./anki-reference-search";
import { ankiSentenceFocusRegression } from "./anki-sentence-focus";
import type { BrowserHarness } from "./harness";
import { readGate } from "./harness";

async function ankiVocabularyPresetRegression(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const { AnkiComposer } = await import("../src/anki/AnkiComposer");
	const { AnkiConfigurationEditor } = await import(
		"../src/anki/AnkiConfigurationEditor"
	);
	const { AnkiSettings } = await import("../src/anki/AnkiSettings");
	const builtins: AnkiBuiltins = {
		shared_css: builtinAsset.sharedCss,
		note_types: builtinAsset.noteTypes.map(
			({ cardTemplates, ...noteType }) => ({
				...noteType,
				card_templates: cardTemplates,
			}),
		),
		export_presets: builtinAsset.exportPresets.map(
			({ noteTypeRef, fields, ...preset }) => ({
				...preset,
				note_type_ref: noteTypeRef,
				fields: fields.map(({ targetField, ...field }) => ({
					...field,
					target_field: targetField,
				})) as AnkiFieldDefinition[],
			}),
		),
	};
	const vocabulary = builtins.export_presets.find(
		(preset) => preset.id === "export.vocabulary",
	);
	check(vocabulary, "载入词义回忆预设");
	const previousVersion = {
		id: vocabulary.note_type_ref.id,
		version: 1,
	};
	const oldType = builtins.note_types.find(
		(item) =>
			item.id === previousVersion.id &&
			item.version === previousVersion.version,
	);
	const currentType = builtins.note_types.find(
		(item) =>
			item.id === vocabulary.note_type_ref.id &&
			item.version === vocabulary.note_type_ref.version,
	);
	check(oldType && currentType, "当前和旧版笔记类型随包提供");
	const scope = { url: "http://localhost:8765", profile: "A" };
	const existing: AnkiConfigurationResponse = {
		id: "legacy-vocabulary",
		name: "旧配置",
		note_type: { kind: "builtin", ...previousVersion },
		fields: vocabulary.fields
			.filter(
				(field) =>
					field.target_field && oldType.fields.includes(field.target_field),
			)
			.map((field) =>
				field.id === "meaning" ? { ...field, label: "本句义" } : field,
			),
	};
	const catalog = {
		endpoint: scope.url,
		profile: scope.profile,
		protocol: "v1" as const,
		decks: [{ id: "1", name: "日语" }],
		note_types: [
			{ id: "2", name: oldType.name },
			{ id: "3", name: currentType.name },
		],
	};
	const typeSelect = () =>
		h.container.querySelector<HTMLSelectElement>("#anki-config-note-type");
	const editorProps = {
		builtins,
		catalog,
		catalogLoading: false,
		catalogError: null,
		onRefreshCatalog: () => undefined,
		onBack: () => undefined,
		onSaved: () => undefined,
	};
	const builtinOptions = (select: HTMLSelectElement | null) =>
		Array.from(
			select?.querySelectorAll<HTMLOptionElement>(
				'optgroup[label="内置笔记类型"] option',
			) ?? [],
		);
	const disposeNewConfig = await h.mount(
		<AnkiConfigurationEditor
			mode="create"
			seedPreset={vocabulary}
			{...editorProps}
		/>,
	);
	try {
		await h.until(() => Boolean(typeSelect()), "载入词义回忆个人配置编辑器");
		const select = typeSelect();
		const value = `builtin:${currentType.id}@${currentType.version}`;
		check(select?.value === value, "由词义回忆创建个人配置默认使用当前版本");
		check(
			builtinOptions(select).filter((item) =>
				item.value.startsWith(`builtin:${currentType.id}@`),
			).length === 1 &&
				select
					?.querySelector('option[value="external:3"]')
					?.textContent?.includes("使用 Anki 已有模板"),
			"新建仅列当前内置词汇版本，同名 Anki 现有类型有清楚标识",
		);
	} finally {
		disposeNewConfig();
	}
	const disposeOldConfig = await h.mount(
		<AnkiConfigurationEditor
			mode="edit"
			existing={existing}
			{...editorProps}
		/>,
	);
	try {
		await h.until(() => Boolean(typeSelect()), "载入原有个人配置编辑器");
		check(
			typeSelect()?.selectedOptions[0]?.textContent?.includes("旧版"),
			"原有个人配置保留旧版笔记类型",
		);
	} finally {
		disposeOldConfig();
	}
	h.mock(async (request) => {
		switch (new URL(request.url).pathname) {
			case "/api/dictionary":
				return Response.json({ ready: false });
			case "/api/anki/builtins":
				return Response.json(builtins);
			case "/api/settings/anki/configurations":
				return Response.json([existing]);
			case "/api/settings/anki/connection":
				return Response.json({
					url: scope.url,
					revision: 0,
					has_api_key: false,
				});
			case "/api/anki/catalog":
				return Response.json(catalog);
			default:
				throw Error(`Unexpected Anki request: ${request.url}`);
		}
	});
	const disposeSettings = await h.mount(<AnkiSettings />);
	try {
		const click = (label: string) => {
			const button = [...h.container.querySelectorAll("button")].find(
				(item) => item.textContent?.trim() === label,
			);
			check(button, `Anki 设置提供「${label}」`);
			button.click();
		};
		const nameInput = () =>
			h.container.querySelector<HTMLInputElement>(
				'input[aria-label="配置名称"]',
			);
		await h.until(
			() => h.container.textContent?.includes(existing.name) ?? false,
			"加载个人配置",
		);
		click("另存为");
		await h.until(
			() => nameInput()?.value === `${existing.name}（副本）`,
			"个人副本从原配置初始化",
		);
		click("← 返回 Anki 设置");
		await h.until(() => !nameInput(), "返回 Anki 设置列表");
		click("查看");
		await h.until(
			() => h.container.textContent?.includes("以此新建配置") ?? false,
			"打开系统预设详情",
		);
		click("以此新建配置");
		await h.until(
			() => nameInput()?.value === `${vocabulary.name}（个人）`,
			"预设创建使用预设字段",
		);
		check(
			typeSelect()?.value ===
				`builtin:${currentType.id}@${currentType.version}`,
			"预设创建不沿用早先的个人副本",
		);
	} finally {
		disposeSettings();
	}
	const card = createRef<HTMLElement>();
	const sentence = "春の風。";
	const translation =
		"初春的风穿过刚刚冒出新芽的树梢，一直吹到了院子的另一头。";
	const disposePreset = await h.mount(
		<div className="reader-r1">
			<AnkiComposer
				cardRef={card}
				anchor={{ left: 480, right: 520, top: 140, bottom: 160 }}
				context={{
					key: "vocabulary",
					origin: "selection",
					selection: "春",
					sentence,
					sentenceFocus: { start: 0, end: 1, text: "春" },
					sentenceRuby: [{ start: 0, end: 1, reading: "はる" }],
					sourceMetadata: "春の本",
					reference: null,
				}}
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
	try {
		const selectConfig = () =>
			card.current?.querySelector<HTMLSelectElement>("#anki-composer-config");
		await h.until(
			() => (selectConfig()?.options.length ?? 0) >= 2,
			"预设与旧配置均可选择",
		);
		const configSelect = selectConfig();
		check(configSelect, "显示制卡配置选项");
		const chooseConfig = (id: string) => {
			configSelect.value = id;
			configSelect.dispatchEvent(new Event("change", { bubbles: true }));
		};
		chooseConfig(vocabulary.id);
		const sentenceMeaning = () =>
			card.current?.querySelector<HTMLTextAreaElement>(
				"#anki-f-sentenceMeaning",
			);
		await h.until(() => Boolean(sentenceMeaning()), "导出浮窗提供例句释义");
		const field = sentenceMeaning();
		const wordMeaning =
			card.current?.querySelector<HTMLTextAreaElement>("#anki-f-meaning");
		check(
			field?.placeholder === "选填，可简写" &&
				wordMeaning?.labels?.[0]?.textContent === "词汇释义*" &&
				field
					.closest(".anki-field")
					?.previousElementSibling?.textContent?.includes("原句"),
			"词汇释义必填，例句释义是紧邻原句的可选字段",
		);
		const openPreview = () =>
			Array.from(card.current?.querySelectorAll("button") ?? [])
				.find((button) => button.textContent?.trim() === "预览")
				?.click();
		const preview = () =>
			Array.from(document.querySelectorAll(".anki-preview-card-body"));
		const closePreview = async () => {
			document
				.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')
				?.click();
			await h.until(() => preview().length === 0, "关闭卡片预览");
		};
		openPreview();
		await h.until(() => preview().length === 2, "可以空白预览例句释义");
		check(
			!preview()[1]?.querySelector(".fj-jp + p"),
			"空白例句释义不生成背面段落",
		);
		await closePreview();
		h.inputValue(wordMeaning, "春天");
		h.inputValue(field, translation);
		openPreview();
		await h.until(() => preview().length === 2, "预览已填例句释义");
		check(
			!preview()[0]?.querySelector(
				".sentence-focus, rt, .fj-sentence-meaning",
			) &&
				preview()[1]?.querySelector(".fj-sentence-meaning")?.textContent ===
					translation &&
				preview()[1]?.querySelector(".sentence-focus ruby rt")?.textContent ===
					"はる",
			"例句释义只出现在背面原句下方",
		);
		const back = preview()[1];
		const example = back?.querySelector(".fj-jp");
		const translationLine = back?.querySelector(".fj-sentence-meaning");
		const head = back?.querySelector(".fj-word");
		check(
			back && example && translationLine && head,
			"背面显示词头、原句与译文",
		);
		const gap =
			translationLine.getBoundingClientRect().top -
			example.getBoundingClientRect().bottom;
		check(
			gap >= 2 &&
				gap <= 5 &&
				getComputedStyle(back).fontSize === "19px" &&
				getComputedStyle(head).fontSize === "34px" &&
				getComputedStyle(translationLine).fontSize === "16px" &&
				getComputedStyle(translationLine).color !==
					getComputedStyle(example).color,
			"预览采用实卡字号，译文以次要色紧接日文原句",
		);
		await closePreview();
		chooseConfig(existing.id);
		await h.until(() => !sentenceMeaning(), "旧版个人配置保留自己的字段");
		openPreview();
		await h.until(
			() => preview().length === 2,
			"旧版个人配置仍可预览卡片正反面",
		);
		check(
			preview()[1]?.textContent?.includes("春天") &&
				!preview()[1]?.textContent?.includes(translation),
			"旧版背面仍显示词义，保留原模板",
		);
	} finally {
		localStorage.removeItem("folio-j:anki-export-preferences");
		disposePreset();
	}
}

export async function ankiComposerRegression(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const { AnkiComposer } = await import("../src/anki/AnkiComposer");
	await import("../src/materials/reader-r1.css");
	await ankiReferenceSearchRegression(h);
	await ankiVocabularyPresetRegression(h);
	await ankiSentenceFocusRegression(h);
	const gate = readGate();
	const configurations = readGate();
	let presetLoaded = false;
	let nextStatus: "unknown" | "target_changed" | undefined;
	const requests: AnkiExportInput[] = [];
	const scope = { url: "http://localhost:8765", profile: "A" };
	const config: AnkiConfigurationResponse = {
		id: "personal",
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
			{
				id: "custom_1",
				label: "词条音频",
				source: "manual",
				type: "audio",
				presentation: "more",
				required: false,
				target_field: "Audio",
				multiline: false,
			},
			{
				id: "sentence",
				label: "原句",
				source: "sentence",
				type: "text",
				presentation: "common",
				required: false,
				target_field: "Sentence",
				multiline: true,
			},
			{
				id: "reading",
				label: "读音",
				source: "manual",
				type: "text",
				presentation: "more",
				required: false,
				target_field: "Reading",
				multiline: false,
			},
			{
				id: "source",
				label: "出处",
				source: "sourceMetadata",
				type: "text",
				presentation: "summary",
				required: false,
				target_field: "Source",
				multiline: false,
			},
		],
	};
	h.mock(async (request) => {
		switch (new URL(request.url).pathname) {
			case "/api/dictionary":
				return Response.json({ ready: true, dictionary_id: "fixture" });
			case "/api/dictionary/lookup":
				return Response.json({
					matches: [
						{
							id: "entry",
							dictionary_id: "fixture",
							term: "春",
							reading: "はる",
							surface: "春",
							start: 0,
							end: 1,
							definitions: [
								{
									tag: "ol",
									style: { paddingLeft: "12px" },
									content: [
										{
											tag: "li",
											role: "def1",
											content: [
												{
													tag: "ruby",
													text: "春",
													content: [{ tag: "rt", text: "はる" }],
												},
												{
													tag: "span",
													role: "dfcn",
													lang: "zh",
													text: "春天",
													style: { fontWeight: "bold" },
												},
											],
										},
										{ tag: "li", role: "def1", text: "盛りの時期。" },
									],
								},
							],
						},
					],
				});
			case "/api/anki/builtins":
				presetLoaded = true;
				return Response.json({
					shared_css: "",
					note_types: [],
					export_presets: [
						{
							id: "early-preset",
							name: "先到的预设",
							note_type_ref: { id: "preset", version: 1 },
							fields: config.fields.slice(0, 1),
						},
					],
				});
			case "/api/settings/anki/configurations":
				await configurations.promise;
				return Response.json([config]);
			case "/api/anki/catalog":
				return Response.json({
					endpoint: scope.url,
					profile: scope.profile,
					protocol: "v1",
					decks: [{ id: "1", name: "日语" }],
					note_types: [{ id: "2", name: "词汇" }],
				});
			case "/api/anki/note-type-fields":
				return Response.json({
					fields: ["Word", "Audio", "Sentence", "Reading", "Source"],
				});
			case "/api/anki/export": {
				const payload: AnkiExportInput = await request.json();
				requests.push(payload);
				return Response.json({
					status:
						nextStatus ?? (payload.allow_duplicate ? "created" : "duplicate"),
					media_may_remain: nextStatus === "target_changed",
					message:
						nextStatus === "target_changed" ? "当前 Anki 用户已变化。" : null,
					type_created: false,
				});
			}
			default:
				throw Error(`Unexpected Anki request: ${request.url}`);
		}
	});
	const card = createRef<HTMLElement>();
	let result = "";
	const dispose = await h.mount(
		<div className="reader-r1" data-theme="black">
			<AnkiComposer
				cardRef={card}
				anchor={{ left: 480, right: 520, top: 140, bottom: 160 }}
				context={{
					key: "draft",
					origin: "selection",
					selection: "春",
					sentence: "春の風。",
					sourceMetadata: "春の本",
					reference: null,
				}}
				materialId="book"
				chapterSegments={[]}
				chapterTranslations={[]}
				recordsStatus="ready"
				settingsState={null}
				onClose={() => {
					throw Error("Unexpected discard");
				}}
				onExported={(value) => {
					result = value;
				}}
			/>
		</div>,
	);
	try {
		await h.until(() => presetLoaded, "内置配置先返回，个人配置仍在读取");
		await new Promise(requestAnimationFrame);
		await new Promise(requestAnimationFrame);
		check(
			!card.current?.querySelector("#anki-f-word"),
			"初次配置选择就绪前不出现将被自动切换的临时字段",
		);
		configurations.release();
		const send = () =>
			h.container.querySelector<HTMLButtonElement>(
				".anki-composer-foot .anki-btn-primary",
			);
		await h.until(
			() =>
				!!send() &&
				!send()?.disabled &&
				!!card.current?.querySelector("input[type=file]"),
			"草稿与目标卡组可用",
		);
		const labels = Array.from(
			h.container.querySelectorAll(".anki-field-label"),
			(label) => label.textContent?.replace("*", "").trim(),
		);
		check(
			labels.join("/") === "词条/读音/原句/出处/词条音频",
			"读音紧随词条，附件在下方直接显示",
		);
		const quote = () =>
			h.container.querySelector<HTMLButtonElement>(".anki-quote-inline");
		const sentence = () =>
			h.container.querySelector<HTMLTextAreaElement>("#anki-f-sentence");
		const edited = "春の風。\n暖かい。";
		quote()?.click();
		await h.until(
			() => !!sentence() && document.activeElement === sentence(),
			"原句就地编辑",
		);
		const editor = sentence();
		check(editor, "原句输入框可用");
		h.inputValue(editor, edited);
		h.container.querySelector<HTMLInputElement>("#anki-f-reading")?.focus();
		await h.until(
			() => quote()?.textContent === edited && !sentence(),
			"失焦后按引文显示修改后的多行原句",
		);
		quote()?.click();
		await h.until(
			() =>
				sentence()?.value === edited && document.activeElement === sentence(),
			"再次编辑沿用修改后的草稿",
		);
		sentence()?.blur();
		const source = () =>
			card.current?.querySelector<HTMLInputElement>("#anki-f-source");
		const summary = () =>
			card.current?.querySelector<HTMLButtonElement>(".anki-summary-inline");
		summary()?.click();
		await h.until(
			() => !!source() && document.activeElement === source(),
			"点击出处可编辑",
		);
		const sourceEditor = source();
		check(sourceEditor, "出处输入框已打开");
		const editedSource = "春の本・第一章　".repeat(12);
		h.inputValue(sourceEditor, editedSource);
		sourceEditor.blur();
		await h.until(
			() => summary()?.textContent === editedSource && !source(),
			"出处失焦后回到摘要",
		);
		const summaryButton = summary();
		check(
			summaryButton &&
				summaryButton.scrollWidth > summaryButton.clientWidth &&
				getComputedStyle(summaryButton).textOverflow === "ellipsis",
			"长出处单行省略",
		);
		summaryButton.click();
		await h.until(
			() =>
				source()?.value === editedSource && document.activeElement === source(),
			"重新编辑保留完整出处",
		);
		source()?.blur();
		const toggle =
			card.current?.querySelector<HTMLButtonElement>(".anki-ref-toggle");
		const cardElement = card.current;
		const draftPane = cardElement?.querySelector<HTMLElement>(
			".anki-composer-form-pane",
		);
		const referencePane = cardElement?.querySelector<HTMLElement>(
			".anki-composer-reference-pane",
		);
		check(
			toggle && cardElement && draftPane && referencePane,
			"有资料时显示参考栏控制",
		);
		const edge = () => cardElement.getBoundingClientRect().right;
		const initialEdge = edge();
		const initialWidth = cardElement.getBoundingClientRect().width;
		const initialDraftLeft = draftPane.getBoundingClientRect().left;
		const compact = innerWidth <= 780;
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const transitionElement = compact ? referencePane : cardElement;
		const transitionProperty = compact ? "transform" : "width";
		const paneTransition = () =>
			transitionElement
				.getAnimations()
				.find(
					(animation) =>
						animation instanceof CSSTransition &&
						animation.transitionProperty === transitionProperty,
				);
		toggle.click();
		await h.until(
			() => toggle.getAttribute("aria-expanded") === "true",
			"打开参考栏",
		);
		check(edge() === initialEdge, "打开参考栏应保留右边缘");
		const opening = paneTransition();
		if (reduced) {
			check(!opening, "减少动态效果时立即显示参考栏");
		} else {
			check(opening, "展开参考栏时播放开合动效");
			opening.pause();
			opening.currentTime = 90;
			if (compact) {
				const offset = new DOMMatrix(getComputedStyle(referencePane).transform)
					.m41;
				check(offset < 0 && offset > -12, "窄屏参考栏以短距离横移切入");
			} else {
				const intermediateWidth = cardElement.getBoundingClientRect().width;
				check(
					intermediateWidth > initialWidth &&
						intermediateWidth < initialWidth + 370 &&
						edge() === initialEdge &&
						draftPane.getBoundingClientRect().left === initialDraftLeft,
					"宽屏从草稿左侧展开，草稿横向位置始终不变",
				);
			}
			opening.play();
		}
		if (compact) {
			check(draftPane.inert, "窄屏单独显示参考资料");
			check(
				referencePane.contains(document.activeElement),
				"窄屏切入参考资料后转移焦点",
			);
		} else {
			const header = cardElement.querySelector<HTMLElement>(
				".anki-composer-head",
			);
			check(header, "宽屏标题可用方向键移动");
			await h.until(() => !paneTransition(), "宽屏参考栏展开完成");
			const referenceAside = referencePane.querySelector(".anki-ref-pane");
			check(
				referenceAside?.getBoundingClientRect().bottom ===
					draftPane.getBoundingClientRect().bottom,
				"宽屏参考资料铺满草稿的高度",
			);
			header.focus();
			header.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
			);
			await h.until(() => edge() !== initialEdge, "手动移动应改变右边缘");
		}
		const movedEdge = edge();
		toggle.click();
		await h.until(() => referencePane.inert, "收起时立即停止参考栏交互");
		check(
			document.activeElement === toggle && edge() === movedEdge,
			"收起参考栏应恢复开关焦点并保留当前位置",
		);
		check(Boolean(paneTransition()) !== reduced, "参考栏收起时也遵循动效偏好");
		toggle.click();
		await h.until(() => !referencePane.inert, "收起途中可以再次打开参考栏");
		await h.until(() => !paneTransition(), "来回切换后参考栏应稳定展开");
		if (!compact) {
			const resize = (
				window as Window & {
					browserResize?: (width: number, height: number) => Promise<void>;
				}
			).browserResize;
			if (resize) {
				const { innerWidth: width, innerHeight: height } = window;
				const word = draftPane.querySelector<HTMLInputElement>("#anki-f-word");
				check(word, "缺少草稿词条输入框");
				word.focus();
				await resize(390, height);
				await h.until(
					() =>
						draftPane.inert && referencePane.contains(document.activeElement),
					"视口变窄时从隐藏草稿转移焦点",
				);
				await resize(width, height);
				await h.until(
					() => !draftPane.inert && edge() === movedEdge,
					"视口恢复后仍在手动移动的位置",
				);
			}
		}
		card.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.click();
		const richSelector = ".anki-ref-card .dict-definitions ol > li";
		await h.until(
			() => card.current?.querySelectorAll(richSelector).length === 2,
			"参考栏保留有序列表与义项",
		);
		const firstSense = card.current?.querySelector(richSelector);
		const chinese = firstSense?.querySelector<HTMLElement>(
			'[lang="zh"][data-dict-role="dfcn"]',
		);
		check(
			chinese &&
				getComputedStyle(chinese).fontWeight === "700" &&
				firstSense?.querySelector("ruby rt")?.textContent === "はる",
			"词典释义保留语言、字重和注音",
		);
		const range = document.createRange();
		range.selectNodeContents(chinese);
		document.getSelection()?.removeAllRanges();
		document.getSelection()?.addRange(range);
		await h.until(
			() =>
				card.current?.querySelector(".anki-ref-excerpt")?.textContent ===
				"春天",
			"可划选结构化义项中的部分文字",
		);
		const target = card.current?.querySelector<HTMLSelectElement>(
			".anki-ref-target-row select",
		);
		check(target, "可选择摘录目标");
		target.value = "reading";
		target.dispatchEvent(new Event("change", { bubbles: true }));
		const fill = firstSense?.querySelector<HTMLButtonElement>("button");
		check(fill, "每个义项可直接填入");
		await h.until(
			() => fill.getAttribute("aria-label") === "填入「读音」",
			"使用当前字段",
		);
		fill.click();
		if (!compact) toggle.click();
		await h.until(
			() => toggle.getAttribute("aria-expanded") === "false",
			"返回草稿",
		);
		check(edge() === movedEdge, "收起参考栏应保留当前位置");
		if (compact) {
			check(
				!draftPane.inert &&
					document.activeElement === draftPane.querySelector("#anki-f-reading"),
				"窄屏填回后焦点落在目标字段",
			);
		}
		const readingInput =
			card.current?.querySelector<HTMLInputElement>("#anki-f-reading");
		check(readingInput?.value === "春はる春天", "整项填入只写入本义项的纯文本");
		readingInput.focus();
		toggle.click();
		const append = () =>
			card.current?.querySelector<HTMLButtonElement>(
				'.anki-ref-card .dict-definitions li:nth-child(2) button[aria-label="追加到「读音」"]',
			);
		await h.until(
			() => Boolean(append()) && !referencePane.inert,
			"再次引用词义时可追加到已有读音",
		);
		append()?.click();
		await h.until(
			() =>
				!draftPane.inert && readingInput.value === "春はる春天 盛りの時期。",
			"追加文本在单行字段中使用可见空格",
		);
		const file = new File(["MP3"], "word.mp3", { type: "audio/mpeg" });
		let reads = 0;
		const original = file.arrayBuffer.bind(file);
		file.arrayBuffer = async () => {
			reads++;
			await gate.promise;
			return original();
		};
		const transfer = new DataTransfer();
		transfer.items.add(file);
		const input =
			card.current?.querySelector<HTMLInputElement>("input[type=file]");
		check(input, "缺少附件控件");
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() => !!card.current?.querySelector(".anki-media-filename"),
			"附件应进入草稿",
		);
		card.current
			?.querySelector<HTMLButtonElement>(
				".anki-composer-foot .anki-btn-secondary",
			)
			?.click();
		await h.until(
			() =>
				Array.from(document.querySelectorAll(".anki-field-table-row")).some(
					(row) =>
						row.querySelector("strong")?.textContent === "Audio" &&
						row.textContent?.includes("word.mp3"),
				),
			"自定义类型预览应显示旧配置中已选择的附件",
		);
		document
			.querySelector<HTMLButtonElement>(".anki-modal [aria-label=关闭预览]")
			?.click();
		await h.until(
			() => !document.querySelector(".anki-modal[open]"),
			"关闭字段预览",
		);
		send()?.click();
		send()?.click();
		await h.until(() => !!send()?.disabled, "附件读取前应锁定发送");
		check(
			reads === 1 && requests.at(0) === undefined,
			"同一次发送只能读取附件一次",
		);
		gate.release();
		const confirm = () =>
			card.current?.querySelector<HTMLButtonElement>(
				".anki-banner-actions .anki-btn-primary",
			);
		await h.until(() => !!confirm(), "重复回执等待明确确认");
		const word = card.current?.querySelector<HTMLInputElement>(
			".anki-headword-input",
		);
		check(word, "词条允许修改");
		h.inputValue(word, "春風");
		await h.until(() => !confirm(), "编辑应使旧确认失效");
		send()?.click();
		await h.until(() => !!confirm(), "新草稿重新核验重复");
		confirm()?.click();
		await h.until(() => !!result, "明确允许重复后完成");
		check(
			requests.length === 3 &&
				requests.every((item) => item.profile === "A" && item.deck_id === "1"),
			"每个请求应使用读者选择的集合与卡组",
		);
		check(
			!requests[0]?.allow_duplicate &&
				!requests[1]?.allow_duplicate &&
				requests[2]?.allow_duplicate,
			"重复授权仅限本次确认",
		);
		check(requests[2]?.fields[0]?.value === "春風", "回执确认应使用新草稿");
		check(
			requests[2]?.fields.find((field) => field.target_field === "Reading")
				?.value === readingInput.value,
			"发送的单行字段值应与输入框显示一致",
		);
		nextStatus = "unknown";
		send()?.click();
		await h.until(
			() =>
				card.current
					?.querySelector('[role="alert"]')
					?.textContent?.includes("结果未确认") === true,
			"未收到写入回执时应提示先查 Anki",
		);
		card.current
			?.querySelector<HTMLButtonElement>('[aria-label="关闭制卡浮窗"]')
			?.click();
		const discard = () =>
			document.querySelector<HTMLDialogElement>(
				'dialog[aria-labelledby="anki-discard-title"]',
			);
		await h.until(
			() =>
				discard()
					?.querySelector("p")
					?.textContent?.includes("发送结果尚未确认，请先在 Anki 中核对") ===
				true,
			"关闭确认应保留发送结果未知的提示",
		);
		discard()
			?.querySelector<HTMLButtonElement>("[data-dialog-cancel]")
			?.click();
		await h.until(() => !discard(), "继续编辑当前草稿");
		nextStatus = "target_changed";
		send()?.click();
		await h.until(
			() =>
				card.current?.querySelector('[role="alert"]')?.textContent ===
				"当前 Anki 用户已变化（部分媒体文件可能已上传）。",
			"上传后目标变化应保留媒体残留说明",
		);
		return "Anki attachment preview and submission, scoped target, duplicate confirmation, unknown receipt and partial media notice";
	} finally {
		configurations.release();
		gate.release();
		dispose();
	}
}
