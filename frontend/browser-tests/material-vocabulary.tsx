import { focusManager, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type Location, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const materialId = "vocabulary-book";
const versionId = "vocabulary-version";
const base = `/api/materials/${materialId}`;
const vocabularyPath = `/materials/${materialId}/vocabulary`;
const timestamp = "2026-10-31T00:00:00Z";
const hash = "a".repeat(64);
const sentences = Array.from(
	{ length: 52 },
	(_, index) => `第${index + 1}段。生の声を聞く。`,
);
const text = sentences.join("");
const offsetAt = (index: number) => sentences.slice(0, index).join("").length;
const chapter: Schema["MaterialChapterResponse"] = {
	id: "chapter",
	material_id: materialId,
	version_id: versionId,
	title: "春の庭",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
			href: "chapter.xhtml",
			css: "p{margin:0 0 1.5em}",
			html_attributes: { lang: "ja" },
			body_attributes: {},
		},
	],
	parts: [
		{
			resource_id: "r",
			spine_index: 0,
			start: 0,
			end: text.length,
			leaf_start: 0,
			leaf_end: sentences.length,
			html: sentences
				.map(
					(sentence, index) =>
						`<p><span data-locator-leaf="${index}">${sentence}</span></p>`,
				)
				.join(""),
		},
	],
};
const book: Schema["MaterialResponse"] = {
	id: materialId,
	source_id: "source",
	title: "春の庭を歩く",
	version_id: versionId,
	contract_version: "1",
	product_sha256: hash,
	source_sha256: hash,
	created_at: timestamp,
	warnings: [],
	chapters: [{ id: chapter.id, title: chapter.title, level: 0, part_count: 1 }],
	reading_position: null,
};
const details: Schema["MaterialDetailsResponse"] = {
	...book,
	type: "book",
	source_title: "日本語の本棚",
	original_title: book.title,
	cover_url: null,
	custom_cover: false,
	metadata_revision: 0,
	usage_revision: 0,
	status: "not_started",
	last_opened_at: null,
	chapter_count: 1,
};
const pos = (value = "名詞") => [value, "普通名詞", "一般", "*", "*", "*"];
function word(value: string, frequency = 1): Schema["VocabularyItem"] {
	const readings: Record<string, string> = {
		の: "ノ",
		に: "ニ",
		は: "ハ",
		する: "スル",
		いる: "イル",
		人: "ヒト",
		見る: "ミル",
		ある: "アル",
		こと: "コト",
		私: "ワタシ",
		春: "ハル",
		風: "カゼ",
		庭: "ニワ",
		歩く: "アルク",
		花: "ハナ",
		声: "コエ",
		聞く: "キク",
		雨: "アメ",
		空: "ソラ",
	};
	const partOfSpeech = ["の", "に", "は"].includes(value)
		? "助詞"
		: [
					"する",
					"いる",
					"見る",
					"ある",
					"歩く",
					"聞く",
					"話す",
					"読む",
					"思う",
				].includes(value)
			? "動詞"
			: "名詞";
	return {
		word: value,
		frequency,
		readings: [value === "生" ? "セイ" : (readings[value] ?? value)],
		surfaces: [value],
		parts_of_speech: [[partOfSpeech, "*", "*", "*", "*", "*"]],
		oov_count: 0,
		variants_truncated: false,
	};
}
const common = [
	"の",
	"に",
	"は",
	"する",
	"いる",
	"人",
	"見る",
	"ある",
	"こと",
	"私",
	"春",
	"風",
	"庭",
	"歩く",
	"日",
	"花",
	"声",
	"聞く",
	"雨",
	"空",
	"道",
	"木",
	"家",
	"時間",
	"少し",
	"静か",
	"光",
	"今",
	"友達",
	"話す",
	"朝",
	"本",
	"読む",
	"思う",
	"町",
	"山",
	"海",
	"水",
	"心",
	"夢",
];

/** Real App and Reader, with every material response supplied by an offline fixture. */
export async function materialVocabulary(
	h: BrowserHarness,
	preview = false,
): Promise<string> {
	document.documentElement.dataset.theme =
		new URLSearchParams(location.search).get("mode") === "dark"
			? "dark"
			: "light";
	const { App, appRoutes } = await import("../src/App");
	const { container, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	let current: Location | undefined;
	let navigate: ReturnType<typeof useNavigate> | undefined;
	let queryClient: ReturnType<typeof useQueryClient> | undefined;
	function Navigator() {
		const entry = useLocation();
		const go = useNavigate();
		const client = useQueryClient();
		useEffect(() => {
			current = entry;
			navigate = go;
			queryClient = client;
		}, [entry, go, client]);
		return null;
	}
	let generation: string | null = "generation-one";
	let failVocabulary = false;
	let failStatistics = false;
	let emptyVocabulary = false;
	let nextVocabulary: Promise<void> | undefined;
	let nextOccurrences: Promise<void> | undefined;
	let opened = 0;
	let saved = 0;
	const requests: { method: string; url: URL }[] = [];
	let position: Schema["ReadingPositionResponse"] | null = null;
	h.mock(async (request) => {
		const url = new URL(request.url);
		requests.push({ method: request.method, url });
		const path = url.pathname;
		if (request.method === "GET" && path === "/api/settings/context-copy")
			return Response.json(defaultContextCopySettings);
		if (request.method === "GET" && path === `${base}/details`)
			return Response.json(details);
		if (request.method === "GET" && path === `${base}/statistics`) {
			if (failStatistics)
				return Response.json({ detail: "文本分析暂不可用" }, { status: 503 });
			return Response.json({
				material_id: materialId,
				version_id: versionId,
				generation_id: generation,
				analysis_configuration: generation ? "{}" : null,
				scope: "unique_resources",
				text: {
					rule_version: "text-statistics-v1",
					unicode_version: "16",
					resource_count: 1,
					character_count: text.length,
					unique_kanji_count: 12,
					singleton_kanji_count: 2,
				},
				lexical: generation
					? {
							rule_version: "lexical-statistics-v1",
							counted_token_count: 100,
							distinct_word_count: 43,
							singleton_word_count: 10,
							singleton_word_ratio: 10 / 43,
							coverage: [
								{ vocabulary_size: 0, coverage: 0 },
								{ vocabulary_size: 43, coverage: 1 },
							],
							thresholds: [0.8, 0.9, 0.95].map((target) => ({
								target,
								vocabulary_size: 40,
							})),
						}
					: null,
			} satisfies Schema["MaterialStatisticsResponse"]);
		}
		if (request.method === "GET" && path === `${base}/vocabulary`) {
			const requestedGeneration = url.searchParams.get("generation_id");
			check(
				requestedGeneration,
				"Vocabulary must pin the statistics generation",
			);
			await nextVocabulary;
			if (failVocabulary)
				return Response.json({ detail: "词汇暂时无法读取" }, { status: 503 });
			const query = url.searchParams.get("q") ?? "";
			const selectedPos = url.searchParams.get("pos");
			const frequency = selectedPos ? 31 : 52;
			const items = query
				? Array.from({ length: 42 }, (_, index) =>
						word(`生物${String(index).padStart(2, "0")}`),
					)
				: common.map((value, index) => word(value, 40 - index));
			items.push({
				...word("生", frequency),
				readings: selectedPos ? ["セイ"] : ["セイ", "ナマ"],
				parts_of_speech: selectedPos ? [pos()] : [pos(), pos("形状詞")],
			});
			const ascending = url.searchParams.get("sort") === "frequency_asc";
			items.sort(
				(a, b) =>
					(ascending ? a.frequency - b.frequency : b.frequency - a.frequency) ||
					a.word.localeCompare(b.word),
			);
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const limit = Number(url.searchParams.get("limit") ?? 40);
			return Response.json({
				material_id: materialId,
				version_id: versionId,
				generation_id: requestedGeneration,
				analysis_configuration: "{}",
				scope: "unique_resources",
				status: "ready",
				rule_version: "material-vocabulary-v1:lexical-statistics-v1",
				query,
				pos: selectedPos,
				sort: ascending ? "frequency_asc" : "frequency_desc",
				total: emptyVocabulary ? 0 : items.length,
				offset,
				limit,
				available_pos: ["名詞", "形状詞", "動詞", "助詞"],
				items: emptyVocabulary
					? []
					: items
							.slice(offset, offset + limit)
							.map((item) =>
								requestedGeneration === "generation-two"
									? { ...item, readings: ["更新した読音"] }
									: item,
							),
			} satisfies Schema["MaterialVocabularyResponse"]);
		}
		if (request.method === "GET" && path === `${base}/vocabulary/occurrences`) {
			const requestedGeneration = url.searchParams.get("generation_id");
			check(
				requestedGeneration,
				"Occurrences must pin the selected list generation",
			);
			await nextOccurrences;
			const offset = Number(url.searchParams.get("offset") ?? 0);
			const limit = Number(url.searchParams.get("limit") ?? 10);
			const selectedPos = url.searchParams.get("pos");
			const total = selectedPos ? 31 : 52;
			return Response.json({
				material_id: materialId,
				version_id: versionId,
				generation_id: requestedGeneration,
				analysis_configuration: "{}",
				scope: "unique_resources",
				presentation_policy: "first_navigable_spine",
				rule_version: "material-vocabulary-v1:lexical-statistics-v1",
				word: url.searchParams.get("word") ?? "",
				pos: selectedPos,
				total,
				offset,
				limit,
				items: Array.from(
					{ length: Math.min(limit, total - offset) },
					(_, index) => {
						const ordinal = offset + index;
						const start =
							offsetAt(ordinal) + (sentences[ordinal]?.indexOf("生") ?? 0);
						return {
							chapter_id: chapter.id,
							chapter_title: chapter.title,
							part_index: 0,
							spine_index: 0,
							resource_id: "r",
							start,
							end: start + 1,
							text_sha256: hash,
							before: `第${ordinal + 1}段。`,
							match: "生",
							after: "の声を聞く。",
							reading:
								requestedGeneration === "generation-two"
									? "更新した出現"
									: "セイ",
							parts_of_speech: pos(),
							is_oov: false,
						};
					},
				),
			} satisfies Schema["MaterialVocabularyOccurrencesResponse"]);
		}
		if (request.method === "GET" && path === base)
			return Response.json({ ...book, reading_position: position });
		if (request.method === "GET" && path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: details.source_title,
				description: "",
				note: "",
				segment_count: 0,
				created_at: timestamp,
				updated_at: timestamp,
			});
		if (request.method === "GET" && path === `${base}/chapters/chapter`)
			return Response.json(chapter);
		if (request.method === "POST" && path === `${base}/readings/prepare`)
			return Response.json({
				material_id: materialId,
				version_id: versionId,
				generation_id: generation,
				token_count: 52,
			});
		if (request.method === "GET" && path === `${base}/readings`)
			return Response.json({
				material_id: materialId,
				version_id: versionId,
				generation_id: generation,
				resources: [],
			});
		if (
			request.method === "GET" &&
			/\/chapters\/chapter\/(segments|translations)$/.test(path)
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (request.method === "GET" && path === `${base}/translations`)
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (path === `${base}/usage` || path === `${base}/opened`) {
			if (request.method === "POST") opened++;
			return Response.json({
				material_id: materialId,
				status: "in_progress",
				revision: 1,
				last_opened_at: timestamp,
				updated_at: timestamp,
			});
		}
		if (request.method === "PUT" && path === `${base}/reading-position`) {
			const body: Schema["ReadingPositionUpdate"] = await request.json();
			saved++;
			position = {
				...body,
				revision: body.expected_revision + 1,
				progress: 0,
				updated_at: timestamp,
			};
			return Response.json(position);
		}
		throw new Error(
			`Unexpected vocabulary fixture request ${request.method} ${path}`,
		);
	});
	function element<T extends Element>(
		selector: string,
		scope: ParentNode = container,
	): T {
		const found = scope.querySelector<T>(selector);
		check(found, `Missing vocabulary element ${selector}`);
		return found;
	}
	function action(
		label: string,
		scope: ParentNode = container,
	): HTMLButtonElement {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) =>
				item.textContent?.trim() === label ||
				item.getAttribute("aria-label") === label,
		);
		check(
			found && !found.disabled,
			`Missing enabled vocabulary action ${label}`,
		);
		return found;
	}
	const requestCount = (suffix: string) =>
		requests.filter((item) => item.url.pathname === `${base}/${suffix}`).length;
	const latest = (suffix: string) =>
		requests.filter((item) => item.url.pathname === `${base}/${suffix}`).at(-1)
			?.url.searchParams;
	const row = (value = "生") =>
		container.querySelector<HTMLButtonElement>(`button[data-word="${value}"]`);
	const idle = () =>
		!container.querySelector('.vocabulary-list-panel[aria-busy="true"]');
	async function select(selector: string, value: string) {
		const control = element<HTMLSelectElement>(selector);
		control.value = value;
		control.dispatchEvent(new Event("change", { bubbles: true }));
		await until(
			() => idle() && control.value === value,
			`Vocabulary control ${selector} must settle`,
		);
	}
	function fits() {
		check(
			document.documentElement.scrollWidth <= innerWidth + 1,
			"Vocabulary page must not overflow horizontally",
		);
	}
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	focusManager.setFocused(true);
	const dispose = await h.mount(
		<>
			<Navigator />
			<App />
		</>,
		"/",
		preview ? vocabularyPath : `/materials/${materialId}/details`,
		appRoutes,
	);
	try {
		if (preview) {
			await until(
				() => !!row(),
				"Vocabulary preview must show its saved words",
			);
			row()?.click();
			await until(
				() => !!container.querySelector(".vocabulary-context"),
				"Vocabulary preview must show context",
			);
			return `material vocabulary preview: ${innerWidth}px, saved words and context`;
		}
		await until(
			() => !!container.querySelector(".book-statistics-chart svg"),
			"Details must automatically load statistics",
		);
		check(
			![...container.querySelectorAll("button")].some((item) =>
				item.textContent?.includes("刷新统计"),
			),
			"Details must not expose a manual statistics refresh action",
		);
		const entry = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
			(item) => item.textContent?.includes("查看词汇"),
		);
		check(
			entry?.getAttribute("href") === vocabularyPath,
			"Details must expose the vocabulary route",
		);
		entry.click();
		await until(
			() => !!row(),
			"Details link must open the real vocabulary route",
		);
		check(
			row()?.textContent?.includes("52"),
			"Unfiltered frequency must include all matching tokens",
		);
		fits();
		const beforePos = requestCount("vocabulary");
		await select('select[aria-label="词性"]', "名詞");
		await until(
			() => row()?.textContent?.includes("31") === true,
			"POS selection must display the filtered token frequency",
		);
		check(
			requestCount("vocabulary") === beforePos + 1 &&
				latest("vocabulary")?.get("pos") === "名詞",
			"POS selection must make one scoped query",
		);
		const beforeSort = requestCount("vocabulary");
		await select('select[aria-label="词频排序"]', "frequency_asc");
		await until(
			() => latest("vocabulary")?.get("sort") === "frequency_asc" && idle(),
			"Ascending order must query the server",
		);
		check(
			requestCount("vocabulary") === beforeSort + 1,
			"Changing sort must make one query",
		);
		const beforeSearch = requestCount("vocabulary");
		inputValue(element<HTMLInputElement>('input[type="search"]'), "生");
		check(
			requestCount("vocabulary") === beforeSearch,
			"Draft search must not query before submission",
		);
		action("搜索").click();
		await until(
			() => latest("vocabulary")?.get("q") === "生" && idle(),
			"Submitted search must reach the vocabulary API",
		);
		check(
			requestCount("vocabulary") === beforeSearch + 1,
			"Search submission must make one query",
		);
		action("词汇下一页").click();
		await until(
			() => latest("vocabulary")?.get("offset") === "40" && !!row(),
			"Word pagination must request the second page",
		);
		row()?.click();
		await until(
			() => container.querySelectorAll(".vocabulary-context").length === 10,
			"Selecting a word must load its pinned occurrences",
		);
		check(
			latest("vocabulary/occurrences")?.get("pos") === "名詞" &&
				latest("vocabulary/occurrences")?.get("generation_id") ===
					"generation-one",
			"Occurrences must share list POS and generation",
		);
		if (innerWidth <= 760)
			check(
				document.activeElement ===
					container.querySelector(".vocabulary-word-title h2"),
				"Narrow selection must focus the occurrence heading",
			);
		fits();
		action("出现位置下一页").click();
		await until(
			() =>
				latest("vocabulary/occurrences")?.get("offset") === "10" &&
				!container.querySelector('.vocabulary-occurrences[aria-busy="true"]'),
			"Occurrence pagination must request its second page",
		);
		const returnSearch = current?.search;
		check(
			returnSearch &&
				new URLSearchParams(returnSearch).get("occurrencePage") === "2",
			"Occurrence page must be represented in the URL",
		);
		check(
			requests.every((request) => request.method === "GET"),
			"Details and vocabulary browsing must remain entirely read-only",
		);
		element<HTMLAnchorElement>(".vocabulary-occurrence-footer a").click();
		await until(
			() => !!container.querySelector("iframe.material-part"),
			"View original must mount the real Reader",
		);
		await until(() => {
			const frame = container.querySelector<HTMLIFrameElement>(
				"iframe.material-part",
			);
			const highlight =
				frame?.contentDocument?.defaultView?.CSS.highlights.get("folio-search");
			return (
				!!highlight && [...highlight].some((range) => range.toString() === "生")
			);
		}, "Reader must validate and highlight the exact vocabulary occurrence");
		await until(() => {
			const frame = container.querySelector<HTMLIFrameElement>(
				"iframe.material-part",
			);
			return !frame?.contentDocument?.defaultView?.CSS.highlights.has(
				"folio-search",
			);
		}, "Cold vocabulary navigation highlight must expire after its visible interval");
		check(
			current?.pathname === `/materials/${materialId}` &&
				current.search.includes("vocabulary="),
			"Original link must use the Reader temporary reference",
		);
		element<HTMLAnchorElement>('a[aria-label="返回词汇列表"]').click();
		await until(
			() =>
				current?.pathname === vocabularyPath &&
				current.search === returnSearch &&
				!!container.querySelector(".vocabulary-context"),
			"Reader return must restore every vocabulary query and page",
		);
		const restored = new URLSearchParams(current?.search);
		check(
			restored.get("q") === "生" &&
				restored.get("pos") === "名詞" &&
				restored.get("sort") === "frequency_asc" &&
				restored.get("page") === "2" &&
				restored.get("word") === "生" &&
				restored.get("occurrencePage") === "2",
			"Reader return lost vocabulary state",
		);
		element<HTMLButtonElement>(".vocabulary-close").click();
		await until(
			() => !container.querySelector(".vocabulary-occurrences"),
			"Close occurrences must restore the list",
		);
		check(
			document.activeElement === row(),
			"Closing occurrences must restore focus to the selected word",
		);
		fits();
		check(opened === 1, "Only entering the Reader may record material usage");
		check(
			navigate && queryClient,
			"Vocabulary fixture navigator must be ready",
		);
		const go = navigate;
		const cache = queryClient;
		// Errors and an actually empty analyzed result use independent query keys.
		failVocabulary = true;
		go(`${vocabularyPath}?q=失敗`);
		await until(
			() => container.textContent?.includes("词汇暂时无法读取") === true,
			"Vocabulary failure must be visible",
		);
		failVocabulary = false;
		action("重试").click();
		await until(
			() => !!container.querySelector(".vocabulary-row"),
			"Vocabulary retry must recover",
		);
		emptyVocabulary = true;
		go(`${vocabularyPath}?q=空`);
		await until(
			() => container.textContent?.includes("没有符合条件的词汇") === true,
			"Analyzed empty search must explain its filters",
		);
		emptyVocabulary = false;
		generation = null;
		await cache.invalidateQueries({
			queryKey: ["book-statistics", materialId],
		});
		// Trigger the actual focus observer rather than calling a product refresh action.
		focusManager.setFocused(false);
		focusManager.setFocused(true);
		await until(
			() => container.textContent?.includes("词汇尚未准备") === true,
			"Absent analysis must be distinct from an empty vocabulary",
		);
		generation = "generation-one";
		failStatistics = true;
		focusManager.setFocused(false);
		focusManager.setFocused(true);
		await until(
			() => container.textContent?.includes("文本分析暂不可用") === true,
			"Statistics failure must offer retry",
		);
		failStatistics = false;
		action("重试").click();
		await until(
			() => !!container.querySelector(".vocabulary-row"),
			"Analysis retry must restore vocabulary",
		);
		go(`${vocabularyPath}?word=生`);
		await until(
			() => !!container.querySelector(".vocabulary-context"),
			"Generation scenario must start with selected old occurrences",
		);
		let releaseWords: (() => void) | undefined;
		let releasePlaces: (() => void) | undefined;
		nextVocabulary = new Promise<void>((resolve) => {
			releaseWords = resolve;
		});
		nextOccurrences = new Promise<void>((resolve) => {
			releasePlaces = resolve;
		});
		generation = "generation-two";
		focusManager.setFocused(false);
		focusManager.setFocused(true);
		await until(
			() =>
				latest("vocabulary")?.get("generation_id") === "generation-two" &&
				latest("vocabulary/occurrences")?.get("generation_id") ===
					"generation-two",
			"Automatic analysis refresh must request a coherent new generation",
		);
		check(
			!container.querySelector(".vocabulary-row") &&
				!container.querySelector(".vocabulary-context"),
			"Old generation list and occurrences must be concealed while new queries wait",
		);
		check(
			releaseWords && releasePlaces,
			"Generation responses must remain controlled",
		);
		releaseWords();
		nextVocabulary = undefined;
		await until(
			() =>
				container
					.querySelector(".vocabulary-row")
					?.textContent?.includes("更新した読音") === true,
			"New generation list must appear independently",
		);
		check(
			!container.querySelector(".vocabulary-context"),
			"New list must not reveal old occurrences",
		);
		releasePlaces();
		nextOccurrences = undefined;
		await until(
			() =>
				container
					.querySelector(".vocabulary-occurrence-footer")
					?.textContent?.includes("更新した出現") === true,
			"New generation occurrences must replace the old ones",
		);
		fits();
		check(
			!requests.some(
				(request) =>
					request.method !== "GET" &&
					![
						`${base}/opened`,
						`${base}/readings/prepare`,
						`${base}/reading-position`,
					].includes(request.url.pathname),
			),
			"Vocabulary browsing must not write learning content",
		);
		return `material vocabulary ${innerWidth}px: details entry; POS/sort/submitted search queries; word/occurrence paging; exact Reader highlight and expiration (${saved} Reader position saves), full URL return; focus and no overflow; retry, empty/unavailable; automatic generation coherence`;
	} finally {
		focusManager.setFocused(undefined);
		if (!preview) dispose();
	}
}
