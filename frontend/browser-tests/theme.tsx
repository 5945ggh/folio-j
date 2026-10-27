import type { components } from "../src/api/schema";
import { projectPart } from "../src/materials/dom";
import { DEFAULT_BOOK_UI, READER_UI_KEY } from "../src/materials/preferences";
import { applyFramePresentation } from "../src/materials/presentation";
import { partDocument } from "../src/materials/reader-frames";
import type { StudyTarget } from "../src/materials/study-api";
import { startAppTheme } from "../src/theme/browser";
import type { BrowserHarness } from "./harness";
import "../src/materials/reader-r1.css";
import "../src/materials/reader-refresh.css";

type Schema = components["schemas"];
type Color = [number, number, number, number];
const timestamp = "2026-10-23T00:00:00Z";
const hash = "a".repeat(64);
const text = "春の庭。";
const settings: Schema["ReadingSettings"] = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb",
};
const chapter: Schema["MaterialChapterResponse"] = {
	id: "chapter",
	material_id: "theme",
	version_id: "v1",
	title: "主题回归",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
			href: "r.xhtml",
			css: "",
			html_attributes: {},
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
			leaf_end: 2,
			html: '<p><ruby><span data-locator-leaf="0">春</span><rt>はる</rt></ruby><span data-locator-leaf="1">の庭。</span></p>',
		},
	],
};
const reference: Schema["MaterialProvenance"] = {
	contract_version: "1",
	material_id: "theme",
	version_id: "v1",
	ranges: [
		{
			resource_id: "r",
			spine_index: 0,
			start: 0,
			end: text.length,
			exact: text,
			text_sha256: hash,
			prefix: "",
			suffix: "",
		},
	],
};
const target: StudyTarget = { reference, chapter };
const segment: Schema["SegmentResponse"] = {
	id: "saved",
	source_id: "source",
	text,
	text_sha256: hash,
	context_before: "",
	context_after: "",
	material_provenance: reference,
	created_at: timestamp,
	updated_at: timestamp,
	text_locked_at: timestamp,
	revision: 1,
	note: "个人备注",
	source_ref: "",
	transcription: "",
	translation: "春天的庭院。",
};

/** Resolve browser computed colors, including color-mix(), through the canvas parser. */
function color(value: string): Color {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context)
		throw new Error("Canvas unavailable for computed color parsing");
	context.fillStyle = value;
	context.fillRect(0, 0, 1, 1);
	const pixel = context.getImageData(0, 0, 1, 1).data;
	return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, (pixel[3] ?? 0) / 255];
}
function over(front: Color, back: Color): Color {
	const alpha = front[3] + back[3] * (1 - front[3]);
	return [0, 1, 2]
		.map(
			(i) =>
				((front[i] ?? 0) * front[3] +
					(back[i] ?? 0) * back[3] * (1 - front[3])) /
				alpha,
		)
		.concat(alpha) as Color;
}
function computed(node: Element) {
	const view = node.ownerDocument.defaultView;
	if (!view) throw new Error("Detached color sample");
	return view.getComputedStyle(node);
}
function background(node: Element | null): Color {
	if (!node) return [255, 255, 255, 1];
	const style = computed(node);
	// A gradient/image cannot be inferred from background-color. Require the real
	// presentation layer to remove author paint before measuring text contrast.
	if (style.backgroundImage !== "none")
		throw new Error(
			`${node.tagName}.${node.className}: unexpected painted background ${style.backgroundImage}`,
		);
	return over(color(style.backgroundColor), background(node.parentElement));
}
function luminance(value: Color) {
	const linear = value.slice(0, 3).map((n) => {
		const v = n / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return (
		(linear[0] ?? 0) * 0.2126 +
		(linear[1] ?? 0) * 0.7152 +
		(linear[2] ?? 0) * 0.0722
	);
}

export async function themeRegression(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const preview = new URLSearchParams(location.search).has("preview");
	const failures: string[] = [];
	const completed: string[] = [];
	let minimum = Number.POSITIVE_INFINITY;
	const dark = matchMedia("(prefers-color-scheme: dark)").matches;
	check(
		dark === (new URLSearchParams(location.search).get("system") === "dark"),
		"Runner must emulate the requested system theme",
	);
	localStorage.clear();
	const appTheme = startAppTheme();
	const synthesis = new EventTarget();
	Object.assign(synthesis, {
		getVoices: () => [],
		cancel: () => {},
		speak: () => {},
	});
	Object.defineProperty(window, "speechSynthesis", {
		configurable: true,
		value: synthesis,
	});
	function node<T extends Element = HTMLElement>(
		selector: string,
		scope: ParentNode = h.container,
	): T {
		const found = scope.querySelector<T>(selector);
		check(found, `Missing ${selector}`);
		return found;
	}
	function button(label: string, scope: ParentNode = h.container) {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) => candidate.textContent?.trim() === label,
		);
		check(found && !found.disabled, `Missing enabled ${label}`);
		return found;
	}
	function contrast(element: Element, label: string) {
		check(element.getClientRects().length > 0, `${label}: sample must render`);
		const css = computed(element);
		const bg = background(element);
		const ink = css.getPropertyValue("-webkit-text-fill-color") || css.color;
		const fg = over(color(ink), bg);
		const light = luminance(fg),
			back = luminance(bg);
		const ratio =
			(Math.max(light, back) + 0.05) / (Math.min(light, back) + 0.05);
		minimum = Math.min(minimum, ratio);
		check(
			ratio >= 4.5,
			`${label}: ${ratio.toFixed(2)}:1 < 4.5:1; foreground=${ink}, background=${bg.join(",")}`,
		);
	}
	async function run(name: string, task: () => Promise<void>) {
		try {
			await task();
			completed.push(name);
		} catch (error) {
			failures.push(`${name}: ${String(error)}`);
		}
	}
	const [
		{ Shell, InlineError },
		{ StudySegmentPanel },
		{ StudyPreview },
		{ ReaderNavigationPanel },
		{ MaterialReader },
		{ TranslationPanel },
	] = await Promise.all([
		import("../src/Shared"),
		import("../src/materials/StudySegmentPanel"),
		import("../src/materials/StudyPreview"),
		import("../src/materials/ReaderPanels"),
		import("../src/materials/MaterialReader"),
		import("../src/translation/TranslationPanel"),
	]);
	const noop = () => {};
	for (const theme of ["white", "black"] as const) {
		await run(`study confirmations ${theme}`, async () => {
			h.mock(async (request) => {
				const path = new URL(request.url).pathname;
				if (path === "/api/settings/segment-context")
					return Response.json({
						enabled: false,
						before_sentences: 0,
						after_sentences: 0,
						before_characters: 0,
						after_characters: 0,
						revision: 0,
					});
				if (path.endsWith("/material-provenance/matches"))
					return Response.json({ segments: [segment], truncated: false });
				throw new Error(`Unexpected study request ${path}`);
			});
			const dispose = await h.mount(
				<div className="reader-r1" data-theme={theme}>
					<StudySegmentPanel
						target={target}
						sourceId="source"
						sourceTitle="主题回归"
						onCancel={noop}
						onSaved={noop}
					/>
				</div>,
			);
			try {
				await h.until(
					() => !!h.container.querySelector(".study-matches button"),
					"Study candidates not loaded",
				);
				node<HTMLDetailsElement>(".study-context-side").open = true;
				h.inputValue(
					node<HTMLTextAreaElement>(".study-context-fields textarea"),
					"编辑后的前文",
				);
				await h.until(
					() => node(".study-context-status").textContent === "已编辑",
					"Draft edit not received",
				);
				button("取消").click();
				await h.until(
					() => !!h.container.querySelector("dialog[open]"),
					"Discard confirmation not opened",
				);
				for (const element of node("dialog[open]").querySelectorAll(
					"h2,p,button",
				))
					contrast(element, `discard ${theme} ${element.textContent}`);
				check(
					luminance(background(node("dialog[open]"))) < 0.1 ===
						(theme === "black"),
					"Discard dialog must use Reader theme",
				);
				button("继续编辑", node("dialog[open]")).click();
				await h.until(
					() => !h.container.querySelector("dialog"),
					"Discard confirmation not closed",
				);
				node<HTMLButtonElement>(".study-matches button").click();
				await h.until(
					() => !!h.container.querySelector("dialog[open]"),
					"Reuse confirmation not opened",
				);
				for (const element of node("dialog[open]").querySelectorAll(
					"h2,p,button",
				))
					contrast(element, `reuse ${theme} ${element.textContent}`);
				check(
					node<HTMLTextAreaElement>(".study-context-fields textarea").value ===
						"编辑后的前文",
					"Confirmation must preserve edited context",
				);
				button("继续编辑", node("dialog[open]")).click();
			} finally {
				dispose();
			}
		});
		await run(`study preview Markdown ${theme}`, async () => {
			const markdown =
				"正文与 `inline code`。\n\n```js\nconst value = 1;\n```\n\n> 引用文字\n\n| 名称 | 内容 |\n| --- | --- |\n| 春 | 庭院 |";
			const analysis: Schema["AnalysisDetail"] = {
				id: "analysis",
				segment_id: "saved",
				title: "讲解",
				excerpt: "正文",
				created_at: timestamp,
				updated_at: timestamp,
				current_revision_id: "rev",
				revision_id: "rev",
				parent_revision_id: null,
				normalizer_version: 1,
				origin: "manual",
				run_id: null,
				source_md: markdown,
				sections: [],
				warnings: [],
			};
			h.mock(async (request) => {
				const path = new URL(request.url).pathname;
				if (path === "/api/segments/saved") return Response.json(segment);
				if (path === "/api/segments/saved/analyses")
					return Response.json([analysis]);
				if (path === "/api/analyses/analysis") return Response.json(analysis);
				throw new Error(`Unexpected preview request ${path}`);
			});
			const dispose = await h.mount(
				<div className="reader-r1" data-theme={theme}>
					<StudyPreview
						anchor={{ left: 20, top: 100, right: 50, bottom: 120 }}
						items={[
							{
								segment_id: "saved",
								excerpt: text,
								material_provenance: reference,
								created_at: timestamp,
							},
						]}
						expanded
						embedded
						onExpand={noop}
						onCollapse={noop}
						onClose={noop}
						onOpen={noop}
						onEmphasize={noop}
					/>
				</div>,
			);
			try {
				await h.until(
					() => !!h.container.querySelector(".analysis-markdown td"),
					"Real preview Markdown not loaded",
				);
				for (const selector of [
					".reader-study-preview-original p",
					".reader-study-preview-translation p",
					".analysis-markdown p",
					".analysis-markdown p code",
					".analysis-markdown pre code",
					".analysis-markdown blockquote p",
					".analysis-markdown th",
					".analysis-markdown td",
					".reader-study-preview-note",
				])
					contrast(node(selector), `preview ${theme} ${selector}`);
			} finally {
				dispose();
			}
		});
		await run(`navigation progress ${theme}`, async () => {
			const dispose = await h.mount(
				<div className="reader-r1" data-theme={theme}>
					<ReaderNavigationPanel
						materialId="theme"
						versionId="v1"
						settings={settings}
						bookTitle="主题回归"
						chapters={[
							{ id: "chapter", title: chapter.title, level: 0, part_count: 1 },
						]}
						chapterId="chapter"
						progress={0.42}
						chapterProgress={new Map([["chapter", 0.42]])}
						tab="toc"
						onTab={noop}
						onChoose={noop}
						onBeginning={noop}
						onNavigate={noop}
						onClose={noop}
					/>
				</div>,
			);
			try {
				await h.until(
					() => !!h.container.querySelector('[aria-current="location"]'),
					"Current chapter not rendered",
				);
				for (const selector of [
					".reader-navigation-book span",
					'[aria-current="location"] > span',
					'[aria-current="location"] .reader-toc-progress',
					".reader-toc-hint",
				])
					contrast(node(selector), `navigation ${theme} ${selector}`);
			} finally {
				dispose();
			}
		});
		await run(`Reader and translation errors ${theme}`, async () => {
			h.mock(async (request) => {
				const path = new URL(request.url).pathname;
				if (path === "/api/settings/translation")
					return Response.json(
						{ detail: "翻译设置暂时不可用" },
						{ status: 503 },
					);
				if (path === "/api/materials/theme/translations")
					return Response.json({ results: [], tasks: [], next_offset: null });
				throw new Error(`Unexpected translation request ${path}`);
			});
			const dispose = await h.mount(
				<div className="reader-r1" data-theme={theme}>
					<div className="reader-error">
						<InlineError error={new Error("阅读失败，请重试")} />
					</div>
					<TranslationPanel
						materialId="theme"
						sourceId="source"
						target={target}
						embedded
						onClose={noop}
						onBackToOrigin={noop}
					/>
				</div>,
			);
			try {
				await h.until(
					() => !!h.container.querySelector(".translation-card .inline-error"),
					"Real translation error not rendered",
				);
				contrast(node(".reader-error .inline-error"), `Reader error ${theme}`);
				contrast(
					node(".translation-card .inline-error"),
					`translation error ${theme}`,
				);
			} finally {
				dispose();
			}
		});
	}
	for (const mode of ["light", "dark"] as const) {
		appTheme.select(mode);
		await run(`public Shell ${mode} is independent of Reader`, async () => {
			localStorage.setItem(READER_UI_KEY, JSON.stringify({ theme: "black" }));
			const dispose = await h.mount(
				<Shell>
					<p className="catalog-count">共 12 项</p>
					<div className="segment-conversation">
						<div className="chat-thread">
							<span className="chat-thread-meta">
								<time>2026-10-23</time>
								<span>3 条消息</span>
							</span>
						</div>
						<p className="chat-empty">暂无讨论</p>
					</div>
					<form className="editor-card">
						<label className="field">
							名称
							<input defaultValue="本の名前" />
							<small>输入用于识别的名称</small>
						</label>
						<p className="field-help">可稍后修改</p>
					</form>
				</Shell>,
			);
			try {
				await h.until(
					() => !!h.container.querySelector(".app-shell"),
					"Shell not rendered",
				);
				check(
					computed(node(".app-shell")).colorScheme === mode,
					"Public Shell controls must follow the application preference",
				);
				check(
					luminance(background(node(".page-content"))) < 0.1 ===
						(mode === "dark"),
					"Public Shell background must follow the application preference",
				);
				for (const selector of [
					".catalog-count",
					".chat-thread-meta time",
					".chat-thread-meta span",
					".field small",
					".field-help",
					".chat-empty",
				])
					contrast(node(selector), `public ${selector}`);
			} finally {
				dispose();
			}
		});
	}
	appTheme.select("system");
	await run("author iframe cascade and identity", async () => {
		const part = chapter.parts[0],
			resource = chapter.resources[0];
		check(part && resource, "Missing frame fixture");
		const html = `<section class="author" id="author"><p class="ink"><ruby><span data-locator-leaf="0">春</span><rt>はる</rt></ruby><span data-locator-leaf="1">の庭。</span></p><img data-epub-image="0" alt="作者图片" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><svg viewBox="0 0 10 10" width="16" height="16"><rect width="10" height="10" fill="#ff0000" /></svg></section>`;
		const css =
			"@layer author { html,body,#author.author .ink,#author.author span { color:#fefefe!important;background-color:#fff!important;background-image:linear-gradient(#fff,#fff)!important;-webkit-text-fill-color:#fff!important;text-shadow:1px 1px #fff!important; } } #author.author {color:#fff!important;background:linear-gradient(white,white)!important} #author .ink span{color:white!important;background-color:white!important}";
		const frame = document.createElement("iframe");
		frame.title = "作者样式主题回归";
		frame.style.cssText = "width:100%;height:250px";
		frame.srcdoc = partDocument(
			{ ...part, html },
			{ ...resource, css },
			settings,
		);
		const reader = document.createElement("div");
		reader.className = "reader-r1";
		reader.dataset.theme = "white";
		reader.append(frame);
		h.container.append(reader);
		let cleanup = noop;
		try {
			await h.until(
				() => !!frame.contentDocument?.querySelector("#author"),
				"Author iframe not loaded",
			);
			const doc = frame.contentDocument;
			check(doc, "Frame document inaccessible");
			const originalText = doc.body.textContent;
			const leaves = [...doc.querySelectorAll("[data-locator-leaf]")];
			const originals = [...doc.querySelectorAll("ruby,rt,img,svg,svg *")];
			const imageMarkup = node("img", doc).outerHTML;
			const svgMarkup = node("svg", doc).outerHTML;
			for (const theme of ["white", "black", "white", "black"] as const) {
				reader.dataset.theme = theme;
				cleanup();
				cleanup = applyFramePresentation(doc, theme, DEFAULT_BOOK_UI);
				check(
					projectPart(doc, text, 0).raw === text,
					"Theme changed exact projection",
				);
				check(
					doc.body.textContent === originalText,
					"Theme changed original text/ruby",
				);
				check(
					leaves.every(
						(leaf, i) =>
							doc.querySelectorAll("[data-locator-leaf]")[i] === leaf,
					),
					"Theme replaced locator leaves",
				);
				check(
					originals.every((leaf) => leaf.isConnected),
					"Theme replaced ruby/image/SVG nodes",
				);
				check(
					node("img", doc).outerHTML === imageMarkup &&
						node("svg", doc).outerHTML === svgMarkup,
					"Theme changed author images/SVG",
				);
				check(
					luminance(background(doc.body)) < 0.1 === (theme === "black"),
					"Frame background must follow requested theme",
				);
				for (const element of [...leaves, node("rt", doc)]) {
					contrast(
						element,
						`author layered important ${theme} ${element.tagName}`,
					);
					check(
						computed(element).textShadow === "none",
						"Author text shadow must be neutralized",
					);
				}
			}
		} finally {
			cleanup();
			reader.remove();
		}
	});
	await run("MaterialReader follows emulated system", async () => {
		localStorage.setItem(
			READER_UI_KEY,
			JSON.stringify({ theme: "system", focus: false }),
		);
		const book: Schema["MaterialResponse"] = {
			id: "theme",
			source_id: "source",
			title: "主题回归",
			version_id: "v1",
			contract_version: "1",
			product_sha256: hash,
			source_sha256: hash,
			created_at: timestamp,
			warnings: [],
			chapters: [
				{ id: "chapter", title: chapter.title, level: 0, part_count: 1 },
			],
			reading_position: null,
		};
		h.mock(async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/api/materials/theme" && request.method === "GET")
				return Response.json(book);
			if (path === "/api/sources/source")
				return Response.json({
					id: "source",
					title: "主题回归",
					description: "",
					note: "",
					segment_count: 1,
					created_at: timestamp,
					updated_at: timestamp,
				});
			if (path.endsWith("/opened") || path.endsWith("/usage"))
				return Response.json({
					material_id: book.id,
					status: "in_progress",
					revision: 1,
					last_opened_at: timestamp,
					updated_at: timestamp,
				});
			if (path.endsWith("/readings/prepare"))
				return Response.json({
					material_id: book.id,
					version_id: "v1",
					generation_id: "generation",
					token_count: 0,
				});
			if (path.endsWith("/readings"))
				return Response.json({
					material_id: book.id,
					version_id: "v1",
					generation_id: "generation",
					resources: [],
				});
			if (path.endsWith("/chapters/chapter")) return Response.json(chapter);
			if (
				path.endsWith("/chapters/chapter/segments") ||
				path.endsWith("/chapters/chapter/translations")
			)
				return Response.json({
					items: [],
					next_cursor: null,
					unavailable_count: 0,
				});
			if (path.endsWith("/translations"))
				return Response.json({ results: [], tasks: [], next_offset: null });
			if (path.endsWith("/reading-position") && request.method === "PUT") {
				const body: Schema["ReadingPositionUpdate"] = await request.json();
				return Response.json({
					...body,
					progress: 0,
					revision: body.expected_revision + 1,
					updated_at: timestamp,
				});
			}
			throw new Error(`Unexpected Reader request ${request.method} ${path}`);
		});
		const dispose = await h.mount(
			<MaterialReader />,
			"/materials/:id",
			"/materials/theme",
		);
		try {
			await h.until(
				() =>
					!!h.container
						.querySelector("iframe")
						?.contentDocument?.querySelector("[data-locator-leaf]"),
				"MaterialReader original not loaded",
			);
			check(
				node(".reader-r1").getAttribute("data-theme") ===
					(dark ? "black" : "white"),
				"Actual Reader must resolve system preference",
			);
			const doc = node<HTMLIFrameElement>("iframe").contentDocument;
			check(doc, "Missing actual Reader frame");
			await h.until(
				() => !!doc.getElementById("folio-reader-presentation"),
				"Actual Reader presentation not applied",
			);
			contrast(node("[data-locator-leaf]", doc), "Actual Reader original");
			check(
				luminance(background(doc.body)) < 0.1 === dark,
				"Actual Reader frame must follow emulated system",
			);
		} finally {
			if (!preview) dispose();
		}
	});
	check(failures.length === 0, failures.join("\n"));
	return `theme ${innerWidth}px system=${dark ? "dark" : "light"}: ${completed.join("; ")}; minimum computed contrast ${minimum.toFixed(2)}:1`;
}
