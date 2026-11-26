import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Chapter } from "../materials/api.ts";
import type { MaterialProvenance } from "../materials/study-api.ts";
import type { AnkiBuiltins, AnkiFieldDefinition } from "./api.ts";
import {
	type AnkiMaterialContext,
	dictionarySenseTexts,
	extractExpandedSentence,
	formatSourceMetadata,
	intersectingRecords,
} from "./context.ts";
import {
	buildConfigOptions,
	buildExportFields,
	buildPreviewFieldMap,
	createCustomFieldId,
	createInitialDraft,
	fieldValueKey,
	getFieldText,
	mediaFileIssue,
	missingRequiredFieldIds,
	renderBuiltinTemplate,
	resolveDeckInCatalog,
	resolveInitialConfigId,
	sentenceFocusFromSelection,
	updateDraftFieldText,
	validateFieldMappings,
} from "./draft.ts";
import {
	getRememberedDeck,
	loadAnkiPreferences,
	rememberLastConfigurationId,
	rememberRecentDeck,
} from "./preferences.ts";

function makeChapter(text: string): Chapter {
	const points = Array.from(text);
	return {
		material_id: "mat-1",
		version_id: "ver-1",
		chapter_id: "ch-1",
		title: "第一章 午后的汤",
		resources: [
			{
				id: "res-1",
				href: "ch1.xhtml",
				text,
				text_sha256: "sha-res-1",
			},
		],
		parts: [
			{
				resource_id: "res-1",
				spine_index: 0,
				start: 0,
				end: points.length,
				html: `<p>${text}</p>`,
			},
		],
	} as unknown as Chapter;
}

function makeRef(
	text: string,
	start: number,
	end: number,
	overrides?: Partial<MaterialProvenance["ranges"][number]>,
): MaterialProvenance {
	const exact = Array.from(text).slice(start, end).join("");
	return {
		contract_version: "1",
		material_id: "mat-1",
		version_id: "ver-1",
		ranges: [
			{
				resource_id: "res-1",
				spine_index: 0,
				text_sha256: "sha-res-1",
				start,
				end,
				exact,
				prefix: "",
				suffix: "",
				...overrides,
			},
		],
	};
}

describe("anki context extraction", () => {
	it("expands a word selection to the enclosing Japanese sentence including closing quote", () => {
		const text =
			"「水を入れて煮込みながら、ぼんやりと灰汁を取る。」湯気の向こうで笑った。";
		const chapter = makeChapter(text);
		const wordStart = Array.from(text).indexOf("灰");
		const ref = makeRef(text, wordStart, wordStart + 2);
		assert.equal(
			extractExpandedSentence(chapter, ref, "灰汁"),
			"「水を入れて煮込みながら、ぼんやりと灰汁を取る。」",
		);
	});

	it("keeps both sentences when the selection crosses a sentence boundary", () => {
		const text = "一番目の文。二番目の文。三番目の文。";
		const chapter = makeChapter(text);
		const ref = makeRef(text, 4, 8); // "文。二番"
		assert.equal(
			extractExpandedSentence(chapter, ref, "文。二番"),
			"一番目の文。二番目の文。",
		);
	});

	it("falls back to the verified selection when chapter version mismatches", () => {
		const text = "水を入れて煮込みながら、灰汁を取る。";
		const chapter = makeChapter(text);
		const ref = makeRef(text, 12, 14);
		ref.version_id = "ver-other";
		assert.equal(extractExpandedSentence(chapter, ref, "灰汁"), "灰汁");
	});

	it("formats source metadata by joining non-empty parts and deduplicating adjacent identical names", () => {
		assert.equal(
			formatSourceMetadata([
				"厨房里的小故事",
				"厨房里的小故事",
				"第一章 午后的汤",
			]),
			"厨房里的小故事 · 第一章 午后的汤",
		);
		assert.equal(
			formatSourceMetadata([null, "  ", "来源A", "书名B", "章C"]),
			"来源A · 书名B · 章C",
		);
	});

	it("matches overlapping records strictly on the frozen original selection without transitive expansion", () => {
		const text = "水を入れて煮込みながら、ぼんやりと灰汁を取る。";
		const target = makeRef(text, 17, 19); // "灰汁"
		const segments = [
			{ id: "exact", material_provenance: makeRef(text, 17, 19) },
			{ id: "enclosing", material_provenance: makeRef(text, 0, 23) },
			{ id: "partial", material_provenance: makeRef(text, 18, 22) },
			{ id: "adjacent", material_provenance: makeRef(text, 19, 22) }, // starts right at target.end
			{
				id: "other-spine",
				material_provenance: makeRef(text, 17, 19, { spine_index: 1 }),
			},
			{ id: "disjoint", material_provenance: makeRef(text, 0, 5) },
		];
		const translations = [
			{ id: "t-hit", material_provenance: makeRef(text, 17, 22) },
			{ id: "t-miss", material_provenance: makeRef(text, 0, 17) },
		];
		const matched = intersectingRecords(target, segments, translations);
		assert.deepEqual(
			matched.segments.map((item) => item.id),
			["exact", "enclosing", "partial"],
		);
		assert.deepEqual(
			matched.translations.map((item) => item.id),
			["t-hit"],
		);
	});

	it("extracts structured list senses from dictionary matches", () => {
		const senses = dictionarySenseTexts({
			id: "e1",
			term: "灰汁",
			reading: "あく",
			surface: "灰汁",
			start: 0,
			end: 2,
			definitions: [
				{
					tag: "ol",
					content: [
						{ tag: "li", text: "植物を焼いた灰を水に浸した上澄み。" },
						{ tag: "li", text: "煮物などで出る泡や不純物。" },
					],
				},
			],
		} as Parameters<typeof dictionarySenseTexts>[0]);
		assert.deepEqual(
			[...senses.values()],
			["植物を焼いた灰を水に浸した上澄み。", "煮物などで出る泡や不純物。"],
		);
	});
});

describe("anki draft, mapping validation, and preview rendering", () => {
	const builtins: AnkiBuiltins = {
		shared_css: ".card { color: #000; }",
		note_types: [
			{
				id: "folio-j.vocabulary-recall",
				version: 1,
				name: "Folio-J 词汇",
				fields: ["Word", "Meaning", "Reading", "Sentence", "SourceMetadata"],
				card_templates: [
					{
						name: "词义回忆",
						front:
							"<!-- folio-j.vocabulary-recall@1 --><div>{{Word}}</div>{{#Sentence}}<p>{{Sentence}}</p>{{/Sentence}}",
						back: "<div>{{Word}}</div>{{#Reading}}<span>{{Reading}}</span>{{/Reading}}<p>{{Meaning}}</p>",
					},
				],
			},
		],
		export_presets: [
			{
				id: "export.vocabulary",
				name: "词义回忆",
				deck: null,
				note_type_ref: { id: "folio-j.vocabulary-recall", version: 1 },
				fields: [
					{
						id: "selection",
						label: "词条",
						type: "text",
						source: "selection",
						target_field: "Word",
						required: true,
						presentation: "common",
						multiline: false,
					},
					{
						id: "meaning",
						label: "本句义",
						type: "text",
						source: "manual",
						target_field: "Meaning",
						required: true,
						presentation: "common",
						multiline: true,
					},
					{
						id: "reading",
						label: "读音",
						type: "text",
						source: "manual",
						target_field: "Reading",
						required: false,
						presentation: "more",
						multiline: false,
					},
					{
						id: "sentence",
						label: "原句",
						type: "text",
						source: "sentence",
						target_field: "Sentence",
						required: false,
						presentation: "common",
						multiline: true,
					},
				],
			},
			{
				id: "export.sentence",
				name: "例句理解",
				deck: null,
				note_type_ref: { id: "folio-j.vocabulary-recall", version: 1 },
				fields: [
					{
						id: "sentence",
						label: "原句",
						type: "text",
						source: "sentence",
						target_field: "Sentence",
						required: true,
						presentation: "common",
						multiline: true,
					},
					{
						id: "explanation",
						label: "说明",
						type: "text",
						source: "manual",
						target_field: "Meaning",
						required: true,
						presentation: "common",
						multiline: true,
					},
				],
			},
		],
	};

	const dictContext: AnkiMaterialContext = {
		key: "dict:1",
		origin: "dictionary",
		selection: "取って",
		sentence: "灰汁を取って仕上げる。",
		sourceMetadata: "小故事 · 第一章",
		reference: null,
		dictionarySeed: {
			surface: "取って",
			term: "取る",
			reading: "とる",
			entries: [],
		},
	};

	it("prefills dictionary form and reading when launched from dictionary card", () => {
		const options = buildConfigOptions(builtins, []);
		const vocab = options.find((item) => item.id === "export.vocabulary");
		assert.ok(vocab);
		const draft = createInitialDraft();
		const wordField = vocab.fields[0];
		const readingField = vocab.fields[2];
		assert.ok(wordField && readingField);
		assert.equal(getFieldText(draft, wordField, dictContext), "取る");
		assert.equal(getFieldText(draft, readingField, dictContext), "とる");
	});

	it("exports the new headword without the old automatic reading and keeps a manually entered reading", async () => {
		const vocab = buildConfigOptions(builtins, []).find(
			(item) => item.id === "export.vocabulary",
		);
		const word = vocab?.fields.find((field) => field.target_field === "Word");
		const reading = vocab?.fields.find(
			(field) => field.target_field === "Reading",
		);
		assert.ok(vocab && word && reading);
		const initial = createInitialDraft();
		const changeWord = (draft: typeof initial) =>
			updateDraftFieldText(draft, word, dictContext, "撮る");
		const exportReading = async (draft: typeof initial) =>
			(await buildExportFields(vocab, draft, dictContext)).find(
				(field) => field.id === reading.id,
			)?.value;
		assert.equal(await exportReading(initial), "とる");
		assert.equal(await exportReading(changeWord(initial)), "");
		const manual = updateDraftFieldText(
			initial,
			reading,
			dictContext,
			"と・る",
		);
		assert.equal(await exportReading(changeWord(manual)), "と・る");
	});

	it("preserves manual edits across configuration switches and remembers last config id", () => {
		const options = buildConfigOptions(builtins, []);
		const vocab = options[0];
		const sentence = options[1];
		assert.ok(vocab && sentence);
		assert.equal(
			resolveInitialConfigId(options, "export.sentence", "selection"),
			"export.sentence",
		);
		assert.equal(
			resolveInitialConfigId(options, null, "translation"),
			"export.sentence",
		);

		let draft = createInitialDraft();
		const sentenceField = vocab.fields[3];
		const meaningField = vocab.fields[1];
		assert.ok(sentenceField && meaningField);
		assert.equal(
			getFieldText(
				draft,
				{ ...sentenceField, source: "selection" },
				dictContext,
			),
			"取る",
		);
		assert.equal(
			getFieldText(draft, sentenceField, dictContext),
			dictContext.sentence,
		);
		draft = {
			...draft,
			text: {
				...draft.text,
				[fieldValueKey(sentenceField)]: "改写后的原句。",
				[fieldValueKey(meaningField)]: "撇去浮沫",
			},
		};

		// Switch to sentence preset: shared sentence edit stays intact
		const sentencePresetField = sentence.fields[0];
		assert.ok(sentencePresetField);
		assert.equal(
			getFieldText(draft, sentencePresetField, dictContext),
			"改写后的原句。",
		);

		// Switch back to vocab preset: meaning edit is still recoverable
		assert.equal(getFieldText(draft, meaningField, dictContext), "撇去浮沫");
	});

	it("isolates legacy custom field values and assigns each new field its own identity", async () => {
		const legacyField: AnkiFieldDefinition = {
			id: "custom_1",
			label: "笔记",
			type: "text",
			source: "manual",
			target_field: "Meaning",
			required: false,
			presentation: "common",
			multiline: false,
		};
		const [first, second] = buildConfigOptions(undefined, [
			{ id: "a", name: "词汇", fields: [legacyField] },
			{ id: "b", name: "例句", fields: [legacyField] },
		]);
		const firstField = first?.fields[0];
		const secondField = second?.fields[0];
		assert.ok(first && second && firstField && secondField);
		const draft = updateDraftFieldText(
			createInitialDraft(),
			firstField,
			dictContext,
			"第一份配置的笔记",
		);
		assert.equal(getFieldText(draft, secondField, dictContext), "");
		assert.equal(
			getFieldText(draft, firstField, dictContext),
			"第一份配置的笔记",
		);
		assert.equal(
			(await buildExportFields(second, draft, dictContext))[0]?.value,
			"",
		);
		const [exported] = await buildExportFields(first, draft, dictContext);
		assert.equal(exported?.id, legacyField.id);
		assert.equal(exported?.value, "第一份配置的笔记");

		const removed = { ...legacyField, id: createCustomFieldId() };
		const replacement = { ...legacyField, id: createCustomFieldId() };
		assert.notEqual(fieldValueKey(removed), fieldValueKey(replacement));
	});

	it("keeps the exact Anki field name through validation and export", async () => {
		const field: AnkiFieldDefinition = {
			id: "selection",
			label: "词条",
			type: "text",
			source: "selection",
			target_field: " Word ",
			required: false,
			presentation: "common",
			multiline: false,
		};
		const [config] = buildConfigOptions(undefined, [
			{ id: "a", name: "词汇", fields: [field] },
		]);
		assert.ok(config);
		assert.deepEqual(validateFieldMappings([field], [" Word "]), []);
		assert.equal(
			validateFieldMappings([field], ["Word"])[0]?.kind,
			"unknown_target",
		);
		const [exported] = await buildExportFields(
			config,
			createInitialDraft(),
			dictContext,
		);
		assert.equal(exported?.target_field, " Word ");
	});

	it("detects missing required mappings, duplicate target mappings, unknown targets, and hidden missing required values", () => {
		const fields: AnkiFieldDefinition[] = [
			{
				id: "f1",
				label: "词条",
				type: "text",
				source: "selection",
				target_field: null,
				required: true,
				presentation: "common",
				multiline: false,
			},
			{
				id: "f2",
				label: "本句义",
				type: "text",
				source: "manual",
				target_field: "Back",
				required: true,
				presentation: "more",
				multiline: true,
			},
			{
				id: "f3",
				label: "备注",
				type: "text",
				source: "manual",
				target_field: "Back",
				required: false,
				presentation: "more",
				multiline: true,
			},
			{
				id: "f4",
				label: "旧字段",
				type: "text",
				source: "manual",
				target_field: "RemovedField",
				required: false,
				presentation: "more",
				multiline: false,
			},
		];
		const issues = validateFieldMappings(fields, ["Front", "Back"]);
		assert.deepEqual(
			issues.map((item) => [item.fieldId, item.kind]),
			[
				["f1", "missing_required_target"],
				["f3", "duplicate_target"],
				["f4", "unknown_target"],
			],
		);

		const options = buildConfigOptions(builtins, []);
		const vocab = options[0];
		assert.ok(vocab);
		const draft = createInitialDraft();
		assert.deepEqual(missingRequiredFieldIds(vocab, draft, dictContext), [
			"meaning",
		]);
	});

	it("shares source ruby between builtin preview and export only while the mapped sentence matches", async () => {
		const context: AnkiMaterialContext = {
			...dictContext,
			sentence: "𠮷が夕飯を<食べる>。",
			sentenceRuby: [
				{ start: 2, end: 4, reading: "ゆうはん" },
				{ start: 6, end: 7, reading: "た" },
			],
		};
		for (const config of buildConfigOptions(builtins, [])) {
			const draft = createInitialDraft();
			const field = config.fields.find(
				(item) => item.target_field === "Sentence",
			);
			assert.ok(field);
			const preview = () =>
				buildPreviewFieldMap(config, draft, context, "back").Sentence;
			assert.equal(
				buildPreviewFieldMap(config, draft, context, "front").Sentence,
				"𠮷が夕飯を&lt;食べる&gt;。",
			);
			const exported = async () =>
				(await buildExportFields(config, draft, context)).find(
					(item) => item.target_field === "Sentence",
				);
			assert.equal(
				preview(),
				"𠮷が<ruby>夕飯<rt>ゆうはん</rt></ruby>を&lt;<ruby>食<rt>た</rt></ruby>べる&gt;。",
			);
			assert.deepEqual((await exported())?.sentence_ruby, context.sentenceRuby);
			assert.equal((await exported())?.value, context.sentence);
			draft.text[fieldValueKey(field)] = "夕飯。";
			assert.equal(preview(), "夕飯。");
			assert.equal((await exported())?.sentence_ruby, undefined);
			delete draft.text[fieldValueKey(field)];
			config.noteType = {
				kind: "external",
				name: "自定义",
				scope: { url: "http://localhost:8765", profile: "A" },
			};
			assert.equal((await exported())?.sentence_ruby, undefined);
			assert.equal(preview(), "𠮷が夕飯を&lt;食べる&gt;。");
		}
	});

	it("exports exact focus only on supported sentences and clears stale offsets after a rewrite", async () => {
		const [legacy, sentence] = buildConfigOptions(builtins, []);
		assert.ok(legacy && sentence);
		const configs = [
			{
				...legacy,
				noteType: {
					kind: "builtin",
					id: "folio-j.vocabulary-recall",
					version: 2,
				},
			},
			{
				...sentence,
				noteType: {
					kind: "builtin",
					id: "folio-j.sentence-reading",
					version: 1,
				},
			},
		] as const;
		const context: AnkiMaterialContext = {
			...dictContext,
			sentence: "𠮷が取って、また取って。",
			sentenceFocus: { start: 2, end: 5, text: "取って" },
		};
		for (const config of configs) {
			const field = config.fields.find(
				(item) => item.target_field === "Sentence",
			);
			assert.ok(field);
			let draft = createInitialDraft();
			const exported = async () =>
				(await buildExportFields(config, draft, context)).find(
					(item) => item.target_field === "Sentence",
				);
			assert.deepEqual(
				(await exported())?.sentence_focus,
				context.sentenceFocus,
			);
			const rewritten = "𠮷に　取ってほしい。";
			draft = updateDraftFieldText(draft, field, context, rewritten);
			assert.equal((await exported())?.sentence_focus, undefined);
			const manualFocus = sentenceFocusFromSelection(rewritten, 3, 7);
			assert.deepEqual(manualFocus, { start: 2, end: 6, text: "　取って" });
			assert.equal(sentenceFocusFromSelection(rewritten, 0, 1), null);
			draft.sentenceFocus[fieldValueKey(field)] = manualFocus;
			assert.deepEqual((await exported())?.sentence_focus, manualFocus);
			draft = updateDraftFieldText(draft, field, context, context.sentence);
			assert.equal((await exported())?.sentence_focus, undefined);
		}
		const legacyFields = await buildExportFields(
			legacy,
			createInitialDraft(),
			context,
		);
		assert.equal(
			legacyFields.find((item) => item.target_field === "Sentence")
				?.sentence_focus,
			undefined,
		);
	});

	it("clears automatic word context when a different dictionary homograph is adopted", async () => {
		const [legacy] = buildConfigOptions(builtins, []);
		assert.ok(legacy);
		const wordField = legacy.fields.find(
			(field) => field.target_field === "Word",
		);
		assert.ok(wordField);
		const partOfSpeech: AnkiFieldDefinition = {
			...wordField,
			id: "partOfSpeech",
			target_field: "PartOfSpeech",
			source: "manual",
		};
		const context: AnkiMaterialContext = {
			...dictContext,
			dictionarySeed: {
				surface: "取って",
				term: "取る",
				reading: "とる",
				partOfSpeech: "动词",
				entries: [
					{
						id: "source-entry",
						dictionary_id: "dictionary",
						start: 0,
						end: 3,
						surface: "取って",
						term: "取る",
						reading: "とる",
						definitions: [],
					},
				],
			},
		};
		const original = createInitialDraft();
		assert.equal(getFieldText(original, partOfSpeech, context), "动词");
		assert.equal(
			updateDraftFieldText(
				original,
				wordField,
				context,
				"取る",
				"source-entry",
			),
			original,
		);
		const changed = updateDraftFieldText(
			original,
			wordField,
			context,
			"取る",
			"homograph",
		);
		assert.equal(getFieldText(changed, partOfSpeech, context), "");
		const manual = updateDraftFieldText(
			original,
			partOfSpeech,
			context,
			"他动词",
		);
		const changedAfterManual = updateDraftFieldText(
			manual,
			wordField,
			context,
			"読む",
		);
		assert.equal(
			getFieldText(changedAfterManual, partOfSpeech, context),
			"他动词",
		);
	});

	it("keeps one ruby reading when the focus crosses only part of its base", () => {
		const [config] = buildConfigOptions(builtins, []);
		assert.ok(config);
		config.noteType = {
			kind: "builtin",
			id: "folio-j.vocabulary-recall",
			version: 2,
		};
		const context: AnkiMaterialContext = {
			...dictContext,
			sentence: "𠮷と生徒<。",
			sentenceRuby: [{ start: 2, end: 4, reading: "せいと" }],
			sentenceFocus: { start: 3, end: 5, text: "徒<" },
		};
		const draft = createInitialDraft();
		assert.equal(
			buildPreviewFieldMap(config, draft, context, "front").Sentence,
			"𠮷と生徒&lt;。",
		);
		assert.equal(
			buildPreviewFieldMap(config, draft, context, "back").Sentence,
			'𠮷と<ruby>生<span class="sentence-focus">徒</span><rt>せいと</rt></ruby><span class="sentence-focus">&lt;</span>。',
		);
	});

	it("escapes user HTML and resolves conditional blocks in local builtin preview", () => {
		const options = buildConfigOptions(builtins, []);
		const vocab = options[0];
		assert.ok(vocab);
		const selContext: AnkiMaterialContext = {
			...dictContext,
			origin: "selection",
			selection: "<script>alert(1)</script>",
			sentence: "",
		};
		const draft = createInitialDraft();
		const meaningField = vocab.fields[1];
		assert.ok(meaningField);
		const meaningKey = fieldValueKey(meaningField);
		draft.text[meaningKey] = "浮沫 & 杂质\n第二行";
		const map = buildPreviewFieldMap(vocab, draft, selContext, "front");
		const tpl = builtins.note_types[0]?.card_templates[0];
		assert.ok(tpl);
		const front = renderBuiltinTemplate(tpl.front, map);
		const back = renderBuiltinTemplate(tpl.back, map);
		assert.equal(front.includes("<script>"), false);
		assert.equal(front.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
		assert.equal(front.includes("<p>"), false); // empty Sentence block omitted
		assert.equal(back.includes("<span>"), false); // empty Reading block omitted
		assert.equal(back.includes("浮沫 &amp; 杂质<br />第二行"), true);
	});
});

it("validates attachment formats and size before reading the file", () => {
	for (const name of ["voice.OGG", "voice.wav"])
		assert.ok(mediaFileIssue("audio", { name, size: 32 }));
	assert.ok(
		mediaFileIssue("video", { name: "film.mp4", size: 11 * 1024 * 1024 + 1 }),
	);
	assert.ok(mediaFileIssue("image", { name: "picture.PNG", size: 0 }));
	assert.equal(mediaFileIssue("image", { name: "photo.JPEG", size: 32 }), null);
});

it("requires the same collection and preserves stored deck identity after a rename", () => {
	const scope = { url: "http://localhost:8765", profile: "Default" };
	const decks = [
		{ id: "7", name: "新名称" },
		{ id: "8", name: "旧名称" },
	];
	const catalog = {
		endpoint: scope.url,
		profile: scope.profile,
		protocol: "v1" as const,
		decks,
		note_types: [],
	};
	const deck = { scope, id: "7", name: "旧名称" };
	assert.equal(resolveDeckInCatalog(deck, catalog)?.id, "7");
	assert.equal(
		resolveDeckInCatalog(deck, { ...catalog, profile: "其他" }),
		null,
	);
	assert.equal(
		resolveDeckInCatalog(deck, { ...catalog, profile: "Default " }),
		null,
	);
	assert.equal(
		resolveDeckInCatalog(deck, { ...catalog, decks: decks.slice(1) }),
		null,
	);
});

describe("anki local preferences", () => {
	it("remembers configuration id and scoped deck while gracefully handling corrupt storage", () => {
		const map = new Map<string, string>();
		const storage = {
			getItem: (key: string) => map.get(key) ?? null,
			setItem: (key: string, value: string) => {
				map.set(key, value);
			},
		};
		rememberLastConfigurationId("cfg-1", storage);
		rememberRecentDeck(
			"http://127.0.0.1:8765/",
			"Reading",
			{ id: "21", name: "日语::阅读" },
			storage,
		);
		assert.equal(loadAnkiPreferences(storage).lastConfigurationId, "cfg-1");
		assert.deepEqual(
			getRememberedDeck("http://127.0.0.1:8765", "Reading", storage),
			{ id: "21", name: "日语::阅读" },
		);
		assert.equal(
			getRememberedDeck("http://127.0.0.1:8765", "Reading ", storage),
			null,
		);

		map.set("folio-j:anki-export-preferences", "{not-json");
		assert.deepEqual(loadAnkiPreferences(storage), {
			lastConfigurationId: null,
			recentDecks: {},
		});
	});
});
