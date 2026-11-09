import { Outlet } from "react-router";
import type { AnalysisDetail } from "../src/analysis/api";
import type { components } from "../src/api/schema";
import { startAppTheme } from "../src/theme/browser";
import type { BrowserHarness } from "./harness";
import { materialSegment } from "./segment-materials";

type Schema = components["schemas"];

/** Real Segment page, host-document glyphs and shared word cards, with local responses only. */
export async function segmentDictionary(h: BrowserHarness) {
	const { SegmentDetail } = await import("../src/SegmentPage");
	const { SettingsReadingReturn } = await import(
		"../src/settings/SettingsNavigation"
	);
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search);
	const preview = params.has("preview");
	const capture = params.has("capture");
	const scene = params.get("scene");
	const retained = scene === "lifecycle";
	const { SegmentSessionHost } = await import(
		"../src/segments/SegmentSessionHost"
	);
	const segment = {
		...materialSegment,
		text: "猫が歩く。",
		context_before:
			scene === "dialog" ? "コーヒーを飲んだ。".repeat(20) : "静かな朝。",
		context_after: "道を走る。",
		material_provenance: null,
	};
	const analysis: AnalysisDetail = {
		id: "dictionary-analysis",
		segment_id: segment.id,
		title: "查词用讲解",
		excerpt: "跨行内格式查词",
		current_revision_id: "dictionary-revision",
		revision_id: "dictionary-revision",
		parent_revision_id: null,
		origin: "manual",
		run_id: null,
		normalizer_version: 1,
		created_at: segment.created_at,
		updated_at: segment.updated_at,
		source_md:
			"猫と**散歩**する。\n\n道を歩く。\n\n*猫*[犬](https://example.invalid)**鳥**\n\n😀か**\u3099猫**が歩く。\n\n中国语译文不应扩大原文范围。",
		warnings: [],
		sections: [],
	};
	const requests: Schema["DictionaryLookupRequest"][] = [];
	let statusReads = 0;
	let responses = 0;
	let hold = false;
	let release: (() => void) | undefined;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/dictionary" && request.method === "GET") {
			statusReads++;
			return Response.json({
				ready: true,
				dictionary_id: "segment-synthetic",
				title: "片段合成词典",
				revision: "1",
				entry_count: 3,
			});
		}
		if (path === "/api/dictionary/lookup" && request.method === "POST") {
			const input: Schema["DictionaryLookupRequest"] = await request.json();
			check(
				input.expected_dictionary_id === "segment-synthetic" &&
					typeof input.auto_expand === "boolean" &&
					typeof input.assisted_ranking === "boolean",
				"Segment lookup must freeze the shared dictionary and options",
			);
			requests.push(input);
			if (hold)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			const term = input.text.includes("散歩")
				? "散歩"
				: input.text.includes("猫")
					? "猫"
					: input.text.includes("道")
						? "道"
						: (Array.from(input.text)[input.position ?? 0] ?? "道");
			const start = Array.from(
				input.text.slice(0, input.text.indexOf(term)),
			).length;
			check(
				input.text.includes(term),
				"Synthetic lookup needs a Japanese term",
			);
			const match: Schema["DictionaryMatch"] = {
				id: term,
				dictionary_id: "segment-synthetic",
				term,
				surface: term,
				reading: term === "猫" ? "ねこ" : term === "散歩" ? "さんぽ" : "みち",
				start,
				end: start + Array.from(term).length,
				definitions: [
					{ tag: "p", lang: "ja", role: "def2", text: "道を歩くこと。" },
					{ tag: "p", lang: "zh", role: "dfcn", text: "片段离线查词释义。" },
				],
			};
			responses++;
			return Response.json({ matches: [match] });
		}
		check(
			request.method === "GET",
			`Unexpected write ${request.method} ${path}`,
		);
		if (path === `/api/segments/${segment.id}`) return Response.json(segment);
		if (path === `/api/sources/${segment.source_id}`)
			return Response.json({
				id: segment.source_id,
				title: "查词回归来源",
				description: "",
				note: "",
				created_at: segment.created_at,
				updated_at: segment.updated_at,
				segment_count: 1,
			});
		if (path === `/api/segments/${segment.id}/analyses`)
			return Response.json([analysis]);
		if (path === `/api/segments/${segment.id}/translation-results`)
			return Response.json([]);
		if (path === `/api/analyses/${analysis.id}`) return Response.json(analysis);
		throw new Error(`Unexpected segment dictionary ${request.method} ${path}`);
	});
	localStorage.clear();
	const theme = params.get("theme");
	if (theme === "light" || theme === "dark") startAppTheme().select(theme);
	const entry = `/segments/${segment.id}?chat=0&analysis=${analysis.id}`;
	const dispose = await h.mount(
		retained ? (
			<>
				<SegmentSessionHost />
				<Outlet />
			</>
		) : (
			<Outlet />
		),
		"/",
		entry,
		[
			{ path: "segments/:id", element: retained ? null : <SegmentDetail /> },
			{
				path: "settings",
				element: (
					<main>
						<h1>词典管理返回测试</h1>
						<SettingsReadingReturn />
					</main>
				),
			},
			{ path: "", element: <p>已离开片段</p> },
		],
	);
	const button = (label: string) => {
		const node = [
			...h.container.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(item) =>
				(item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
		);
		check(node && !node.disabled, `Missing enabled ${label}`);
		return node;
	};
	const find = <T extends Element>(selector: string) => {
		const node = h.container.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 180));
	const contained = (node: Element) => {
		const rect = node.getBoundingClientRect();
		check(
			rect.width > 0 &&
				rect.height > 0 &&
				rect.left >= -1 &&
				rect.top >= -1 &&
				rect.right <= innerWidth + 1 &&
				rect.bottom <= innerHeight + 1,
			"Shared dictionary surface must remain reachable in the Segment viewport",
		);
	};
	try {
		await h.until(
			() => !!h.container.querySelector(".analysis-markdown strong"),
			"Actual Segment and Markdown must load",
		);
		check(
			statusReads === 0,
			"Disabled Segment dictionary must load status on demand",
		);
		check(
			!!h.container.querySelector(
				'.segment-tools button[aria-label="即时查词"]',
			),
			"Segment left toolbar must own the dictionary trigger",
		);
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-modes"),
			"Segment dictionary settings must load",
		);
		contained(find(".dict-config"));
		if (scene === "options") {
			const menu = find<HTMLElement>(".dict-config");
			menu.scrollTop = menu.scrollHeight;
			await settle();
			contained(find(".dict-import"));
			check(
				document.documentElement.dataset.theme === theme,
				"The short settings surface must use the requested application theme",
			);
			return `segment dictionary settings: ${innerWidth}×${innerHeight}, ${theme}; scrollable options and management remain reachable`;
		}
		button("点击查词").click();
		await h.until(
			() => !h.container.querySelector(".dict-config"),
			"Choosing click lookup must close settings",
		);
		await settle();
		if (preview)
			return "segment dictionary preview: real page and synthetic local dictionary";
		const { browserPointer: pointer, browserKey: key } = window as Window & {
			browserPointer?: (events: unknown[]) => Promise<void>;
			browserKey?: (
				key: "Shift" | "Escape",
				type?: "keyDown" | "keyUp",
			) => Promise<void>;
		};
		check(
			pointer && key,
			"Runner must provide trusted dictionary pointer and keyboard input",
		);
		const point = (element: Element, offset = 0) => {
			element.scrollIntoView({ block: "nearest", behavior: "instant" });
			const node = element.firstChild;
			check(
				node?.nodeType === Node.TEXT_NODE,
				"Glyph needs a real Japanese text node",
			);
			const range = document.createRange();
			range.setStart(node, offset);
			range.setEnd(node, offset + 1);
			const rect = range.getBoundingClientRect();
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		};
		const click = async (element: Element, offset = 0) => {
			element.scrollIntoView({ block: "nearest", behavior: "instant" });
			await settle();
			const at = point(element, offset);
			check(
				element.contains(document.elementFromPoint(at.x, at.y)),
				`Glyph must remain under trusted pointer: ${element.className}; hit=${document.elementFromPoint(at.x, at.y)?.outerHTML}`,
			);
			await pointer([
				{ type: "mouseMoved", ...at },
				{ type: "mousePressed", ...at, button: "left", clickCount: 1 },
				{ type: "mouseReleased", ...at, button: "left", clickCount: 1 },
			]);
		};
		const resolved = async (stage: string) => {
			try {
				await h.until(
					() => !!h.container.querySelector(".dict-definitions"),
					`${stage}: Segment lookup must render shared definitions`,
				);
			} catch (error) {
				throw new Error(
					`${String(error)}; requests=${JSON.stringify(requests)}; original=${h.container.querySelector(".segment-context-preview")?.outerHTML}; selection=${document.getSelection()?.toString()}; trigger=${h.container.querySelector(".dict-trigger")?.outerHTML}`,
				);
			}
			contained(find(".dict-card"));
		};
		if (scene === "dialog") {
			const openMaterial = async () => {
				button("查看完整原文与资料").click();
				await h.until(
					() => !!h.container.querySelector(".segment-material-dialog[open]"),
					"Complete material dialog must open",
				);
				await settle();
			};
			const materialText = (index: number) =>
				find(
					`.segment-material-dialog .segment-material-field:nth-of-type(${index}) p`,
				);
			const checkTopLayer = (selector: string) => {
				const node = find(selector);
				const rect = node.getBoundingClientRect();
				check(
					find(".segment-material-dialog").contains(node) &&
						node.contains(
							document.elementFromPoint(
								rect.left + rect.width / 2,
								rect.top + 12,
							),
						),
					"Material lookup surfaces must remain interactive inside the dialog top layer",
				);
			};
			await openMaterial();
			await click(materialText(1), 1);
			await resolved("complete context prolonged sound mark");
			check(
				requests.at(-1)?.position === 1 &&
					requests.at(-1)?.text.startsWith("コーヒー"),
				"The complete context must allow lookup directly on the prolonged sound mark",
			);
			checkTopLayer(".dict-card");
			const definition = find('[data-depth="0"] [data-dict-role="def2"]');
			const definitionRange = document.createRange();
			definitionRange.selectNodeContents(definition);
			document.getSelection()?.removeAllRanges();
			document.getSelection()?.addRange(definitionRange);
			document.dispatchEvent(new Event("selectionchange"));
			await h.until(
				() => !!h.container.querySelector(".dict-foot button"),
				"Dialog word-card selection must expose nested lookup",
			);
			check(
				!h.container.querySelector(".segment-dictionary-selection"),
				"Dialog word-card selection must not expose the material selection action",
			);
			button("查选中文字").click();
			await h.until(
				() => h.container.querySelectorAll(".dict-card").length === 2,
				"Dialog word-card selection must keep its parent card",
			);
			document.getSelection()?.removeAllRanges();
			await key("Escape");
			await click(find('[data-depth="0"] [data-dict-role="def2"]'));
			await h.until(
				() => h.container.querySelectorAll(".dict-card").length === 2,
				"Read-only dialog definitions must support nested lookup",
			);
			await key("Escape");
			await key("Escape");
			check(
				!!h.container.querySelector(".segment-material-dialog[open]") &&
					!h.container.querySelector(".dict-card") &&
					document.activeElement === find(".segment-material-body"),
				"Escape must close cards before the material dialog and return focus to its reading region",
			);
			const source = materialText(1);
			const from = point(source),
				to = point(source, 4);
			const beforeDrag = requests.length;
			await pointer([
				{ type: "mouseMoved", ...from },
				{
					type: "mousePressed",
					...from,
					button: "left",
					buttons: 1,
					clickCount: 1,
				},
				{ type: "mouseMoved", ...to, button: "left", buttons: 1 },
				{
					type: "mouseReleased",
					...to,
					button: "left",
					buttons: 0,
					clickCount: 1,
				},
			]);
			await h.until(
				() => !!h.container.querySelector(".segment-dictionary-selection"),
				"Complete context selection must expose explicit lookup",
			);
			check(
				requests.length === beforeDrag,
				"Material drag must keep native selection without querying",
			);
			checkTopLayer(".segment-dictionary-selection");
			const selected = document.getSelection()?.toString();
			button("查所选文字").click();
			await resolved("complete context selection");
			check(
				requests.at(-1)?.text === selected &&
					requests.at(-1)?.selection_start === 0,
				"Material selection lookup must submit the exact selected text",
			);
			document.getSelection()?.removeAllRanges();
			find(".segment-material-body").dispatchEvent(new Event("scroll"));
			await h.until(
				() => !h.container.querySelector(".dict-deck"),
				"Material scroll must dismiss lookup",
			);
			button("关闭原文与资料").click();
			await h.until(
				() => !h.container.querySelector(".segment-material-dialog"),
				"Material dialog must close",
			);
			button("即时查词").click();
			await h.until(
				() => !!h.container.querySelector(".dict-modes"),
				"Material test must enable Shift lookup",
			);
			button("Shift 悬浮").click();
			await openMaterial();
			const at = point(materialText(2));
			await pointer([{ type: "mouseMoved", ...at }]);
			await key("Shift", "keyDown");
			await resolved("complete original Shift lookup");
			await key("Shift", "keyUp");
			checkTopLayer(".dict-card");
			await key("Escape");
			hold = true;
			const pendingAt = point(materialText(3));
			await settle();
			await pointer([{ type: "mouseMoved", ...pendingAt }]);
			await key("Shift", "keyDown");
			await h.until(
				() => !!release,
				"Dialog lookup must await the held response",
			);
			await key("Shift", "keyUp");
			button("关闭原文与资料").click();
			await h.until(
				() => !h.container.querySelector(".segment-material-dialog"),
				"Pending dialog must close",
			);
			check(release, "Held dialog response must be releasable");
			const beforeResponse = responses;
			release();
			hold = false;
			await h.until(
				() => responses > beforeResponse,
				"Old dialog response must settle",
			);
			await settle();
			check(
				!h.container.querySelector(".dict-deck") &&
					!CSS.highlights.has("folio-segment-word"),
				"Closed dialog response must not restore cards or highlights in the main page",
			);
			await openMaterial();
			await pointer([{ type: "mouseMoved", ...point(materialText(2)) }]);
			await key("Shift", "keyDown");
			await resolved("reopened complete original");
			await key("Shift", "keyUp");
			button("编辑片段资料").click();
			await h.until(
				() => !!h.container.querySelector(".segment-editor"),
				"Read-only dialog must switch to editing",
			);
			check(
				!h.container.querySelector(".dict-deck") &&
					!h.container.querySelector("dialog [data-dictionary-text]"),
				"Editing must clear lookup and leave editor text outside lookup surfaces",
			);
			button("取消").click();
			await h.until(
				() => !h.container.querySelector(".segment-editor"),
				"Editor must cancel",
			);
			await openMaterial();
			await pointer([{ type: "mouseMoved", ...point(materialText(2)) }]);
			await key("Shift", "keyDown");
			await resolved("final complete original");
			await key("Shift", "keyUp");
			await settle();
			if (!preview && !capture) {
				find<HTMLAnchorElement>(
					'.segment-tools a[aria-label="首页（素材库）"]',
				).click();
				await h.until(
					() => h.container.textContent?.includes("已离开片段") === true,
					"Leaving must retire the dialog",
				);
				check(
					!h.container.querySelector(".dict-deck") &&
						!CSS.highlights.has("folio-segment-word"),
					"Leaving the material dialog must clean lookup surfaces and highlights",
				);
			}
			return `segment dictionary material dialog: ${innerWidth}px; long context, prolonged mark, click/Shift/selection, nested cards, top-layer reachability, focus/scroll/edit/late-response/leave cleanup`;
		}
		const original = find(".segment-original-focus");
		await click(original);
		await resolved("original");
		check(
			requests.at(-1)?.text === segment.text && requests.at(-1)?.position === 0,
			`Original lookup must exclude saved adjacent context and retain glyph offset: ${JSON.stringify(requests.at(-1))}`,
		);
		check(
			CSS.highlights.has("folio-segment-word"),
			"Original match must paint a host-document highlight",
		);
		if (scene === "card") {
			await settle();
			return `segment dictionary card: ${innerWidth}px, ${theme}; original glyph and shared word card`;
		}
		if (retained) {
			const parent = find('.dict-card[data-depth="0"]');
			const prose = find('[data-depth="0"] [data-dict-role="def2"]');
			const range = document.createRange();
			range.selectNodeContents(prose);
			document.getSelection()?.removeAllRanges();
			document.getSelection()?.addRange(range);
			document.dispatchEvent(new Event("selectionchange"));
			await h.until(
				() => !!h.container.querySelector(".dict-foot button"),
				"A word-card selection must expose its existing nested lookup action",
			);
			await settle();
			check(
				!h.container.querySelector(".segment-dictionary-selection"),
				"Selecting definitions must not expose the Segment selection toolbar",
			);
			button("查选中文字").click();
			await h.until(
				() => h.container.querySelectorAll(".dict-card").length === 2,
				"Card selection must open a nested lookup",
			);
			check(
				find('.dict-card[data-depth="0"]') === parent &&
					requests.at(-1)?.selection_start === 0 &&
					requests.at(-1)?.selection_end ===
						Array.from(prose.textContent ?? "").length,
				"Card selection must retain its parent and use only the selected definition",
			);
			document.getSelection()?.removeAllRanges();
			await key("Escape");
			await key("Escape");
			button("即时查词").click();
			await h.until(
				() => !!h.container.querySelector(".dict-modes"),
				"Retained-page test must choose Shift lookup",
			);
			button("Shift 悬浮").click();
			await settle();
			const sameGlyph = point(original);
			await pointer([{ type: "mouseMoved", ...sameGlyph }]);
			await key("Shift", "keyDown");
			await resolved("before retained settings visit");
			await key("Shift", "keyUp");
			// Link activation without a pointerdown also covers keyboard navigation:
			// the availability transition itself must retire the old glyph identity.
			find<HTMLAnchorElement>(".segment-settings-link").click();
			await h.until(
				() =>
					!!h.container.querySelector('[data-segment-session="paused"]') &&
					!!h.container.querySelector("#settings-reading-return"),
				"Settings visit must pause the actual Segment session",
			);
			check(
				find(".segment-original-focus") === original &&
					!h.container.querySelector(".dict-deck"),
				"Paused session must retain original DOM while clearing dictionary surfaces",
			);
			find<HTMLAnchorElement>("#settings-reading-return").click();
			await h.until(
				() =>
					!!h.container.querySelector(
						'[data-segment-session="active"] .dict-trigger[aria-pressed="true"]',
					),
				"Returning from settings must reactivate the shared lookup mode",
			);
			await settle();
			check(
				find(".segment-original-focus") === original,
				"Settings return must reuse the same original DOM",
			);
			await pointer([{ type: "mouseMoved", ...point(original) }]);
			await key("Shift", "keyDown");
			await resolved("same retained glyph after settings return");
			await key("Shift", "keyUp");
			return "segment dictionary lifecycle: card selection stays nested; actual retained Segment settings return reopens the same Shift glyph";
		}
		await click(find('[data-depth="0"] [data-dict-role="def2"]'));
		await h.until(
			() => h.container.querySelectorAll(".dict-card").length === 2,
			"Japanese definition must open a nested word card",
		);
		await key("Escape");
		await h.until(
			() => h.container.querySelectorAll(".dict-card").length === 1,
			"Escape must return from the nested card",
		);
		await key("Escape");
		await h.until(
			() => !h.container.querySelector(".dict-deck"),
			"Escape must close the root card",
		);
		await settle();
		const beforeDrag = requests.length;
		const from = point(original),
			to = point(original, 3);
		await pointer([
			{ type: "mouseMoved", ...from },
			{
				type: "mousePressed",
				...from,
				button: "left",
				buttons: 1,
				clickCount: 1,
			},
			{ type: "mouseMoved", ...to, button: "left", buttons: 1 },
			{
				type: "mouseReleased",
				...to,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		]);
		await settle();
		check(
			!document.getSelection()?.isCollapsed && requests.length === beforeDrag,
			`Dragging original text must retain native selection without querying: selected=${document.getSelection()?.toString()}, requests=${beforeDrag}->${requests.length}`,
		);
		const selectedText = document.getSelection()?.toString() ?? "";
		await h.until(
			() => !!h.container.querySelector(".segment-dictionary-selection"),
			"Native Segment selection must expose explicit lookup",
		);
		button("查所选文字").click();
		await resolved("explicit selection");
		check(
			requests.at(-1)?.text === selectedText &&
				requests.at(-1)?.selection_start === 0 &&
				requests.at(-1)?.selection_end === Array.from(selectedText).length,
			"Explicit selected-text lookup must carry only the native selected range",
		);
		document.getSelection()?.removeAllRanges();
		await key("Escape");
		await click(find(".analysis-markdown strong"), 1);
		await resolved("inline Markdown");
		check(
			requests.at(-1)?.text === "猫と散歩する。" &&
				requests.at(-1)?.position === 3,
			"Markdown inline formatting must preserve its whole paragraph and code-point offset",
		);
		await key("Escape");
		await click(find(".analysis-markdown p:nth-child(3) em"));
		await resolved("before Markdown link");
		check(
			requests.at(-1)?.text === "猫",
			"Links must stop lookup text instead of joining their neighbors",
		);
		await key("Escape");
		await click(find(".analysis-markdown p:nth-child(3) strong"));
		await resolved("after Markdown link");
		check(
			requests.at(-1)?.text === "鳥",
			"Lookup after a link must exclude both its label and preceding text",
		);
		await key("Escape");
		await click(find(".analysis-markdown p:nth-child(4) strong"), 1);
		await resolved("NFC across Markdown inline");
		check(
			requests.at(-1)?.text === "😀が猫が歩く。" &&
				requests.at(-1)?.position === 2,
			"Supplementary code points and an NFC cluster across inline nodes must retain canonical lookup coordinates",
		);
		await key("Escape");
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-modes"),
			"Mode settings must reopen",
		);
		button("Shift 悬浮").click();
		const hoverAt = point(find(".analysis-markdown p:nth-child(2)"));
		const beforeHover = requests.length;
		await pointer([{ type: "mouseMoved", ...hoverAt }]);
		await settle();
		check(
			requests.length === beforeHover,
			"Ordinary hover must leave text selectable",
		);
		await key("Shift", "keyDown");
		await resolved("Shift hover");
		await key("Shift", "keyUp");
		check(
			!!h.container.querySelector(".dict-deck"),
			"Releasing Shift must retain the word card",
		);
		await key("Escape");
		await settle();
		await pointer([{ type: "mouseMoved", ...hoverAt }]);
		await key("Shift", "keyDown");
		await resolved("reopened same Shift glyph");
		await key("Shift", "keyUp");
		await key("Escape");
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-modes"),
			"Click mode must be available again",
		);
		button("点击查词").click();
		hold = true;
		await click(find('[aria-label="已保存后文"] span'));
		await h.until(
			() => !!release && !!h.container.querySelector(".dict-deck"),
			"Fresh context lookup must remain pending",
		);
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-config"),
			"Pending lookup must permit settings",
		);
		find<HTMLInputElement>('input[aria-label="自动扩展查词"]').click();
		await h.until(
			() => !h.container.querySelector(".dict-deck"),
			"Option changes must clear pending cards",
		);
		check(release, "Pending local response must be releasable");
		const beforeResponse = responses;
		release();
		hold = false;
		await h.until(
			() => responses > beforeResponse,
			"Held response must complete",
		);
		await settle();
		check(
			!h.container.querySelector(".dict-deck") &&
				!!h.container.querySelector(".dict-config"),
			"Late old-option result must not restore a card or close settings",
		);
		button("关闭查词设置").click();
		await click(original);
		await resolved("new options");
		check(
			requests.at(-1)?.auto_expand === false,
			"Next Segment lookup must use changed shared options",
		);
		button("返回讲解列表").click();
		await h.until(
			() => !h.container.querySelector(".dict-deck"),
			"Switching the selected analysis must close its dictionary stack",
		);
		await click(original);
		await resolved("before scroll");
		find(".segment-reader").dispatchEvent(new Event("scroll"));
		await h.until(
			() => !h.container.querySelector(".dict-deck"),
			"Scrolling Segment content must dismiss anchored word cards",
		);
		button("即时查词").click();
		await h.until(
			() => !!h.container.querySelector(".dict-import"),
			"Dictionary management must remain available",
		);
		find<HTMLAnchorElement>(".dict-import").click();
		await h.until(
			() => !!h.container.querySelector("#settings-reading-return"),
			"Management must preserve the Segment return destination",
		);
		find<HTMLAnchorElement>("#settings-reading-return").click();
		await h.until(
			() => !!h.container.querySelector(".segment-original-focus"),
			"Settings return must restore the real Segment page",
		);
		check(
			!h.container.querySelector(".dict-deck"),
			"Returning from settings must not restore old cards",
		);
		if (capture) {
			button("即时查词").click();
			await h.until(
				() => !!h.container.querySelector(".dict-config"),
				"Capture must retain the actual Segment dictionary settings",
			);
			contained(find(".dict-config"));
		} else {
			await click(find(".segment-original-focus"));
			await resolved("before leave");
			find<HTMLAnchorElement>(
				'.segment-tools a[aria-label="首页（素材库）"]',
			).click();
			await h.until(
				() => h.container.textContent?.includes("已离开片段") === true,
				"Home navigation must leave the Segment",
			);
			check(
				!h.container.querySelector(".dict-deck") &&
					!CSS.highlights.has("folio-segment-word"),
				"Leaving Segment must remove cards and native highlights",
			);
		}
		return `segment dictionary: ${innerWidth}px; original + inline Markdown, native selection, Shift, nested cards, late option isolation, analysis/scroll cleanup, settings return`;
	} finally {
		if (!preview && !capture) dispose();
	}
}
