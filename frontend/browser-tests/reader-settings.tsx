import { useEffect } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const stamp = "2026-10-29T00:00:00Z",
	hash = "b".repeat(64),
	materialId = "reader-settings";
const paragraphs = Array.from(
	{ length: 120 },
	(_, index) => `春の風。第${index}段落。静かな庭を歩いた。`,
);
const text = paragraphs.join("");
const offset = (index: number) => paragraphs.slice(0, index).join("").length;
const bookKey = `folio-reader-book-ui-v1:${materialId}:v1`,
	uiKey = "folio-reader-ui-v1";
function chapter(id: string): Schema["MaterialChapterResponse"] {
	return {
		id,
		material_id: materialId,
		version_id: "v1",
		title: id === "first" ? "第一章" : "第二章",
		level: 0,
		resources: [
			{
				id: "r",
				text,
				text_sha256: hash,
				href: `${id}.xhtml`,
				css: "p{margin:0 0 1.8em}",
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
				leaf_end: paragraphs.length,
				html: paragraphs
					.map(
						(value, index) =>
							`<p><span data-locator-leaf="${index}">${value}</span></p>`,
					)
					.join(""),
			},
		],
	};
}
/** Real retained Reader, actual DataRouter, and strictly isolated API fixtures. */
export async function readerSettings(h: BrowserHarness, preview = false) {
	const { ReaderSessionHost } = await import(
		"../src/materials/ReaderSessionHost"
	);
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search),
		vertical = params.get("direction") === "vertical-rl",
		dark = params.get("theme") === "dark";
	let navigate: ReturnType<typeof useNavigate> | undefined,
		route = "";
	function Scene() {
		const go = useNavigate(),
			current = useLocation();
		useEffect(() => {
			navigate = go;
			route = current.pathname + current.search;
		}, [go, current]);
		return (
			<>
				<ReaderSessionHost />
				<Routes>
					<Route path="/materials/:id" element={null} />
					<Route
						path="/segments/:id"
						element={<p data-segment-page="">离线片段</p>}
					/>
					<Route path="*" element={<p data-other-page="">离线页面</p>} />
				</Routes>
			</>
		);
	}
	let stored: Schema["ContextCopySettingsResponse"] = {
			...defaultContextCopySettings,
		},
		status = 200;
	let saveGate: Promise<void> | undefined,
		releaseSave: (() => void) | undefined;
	const saves: Schema["ContextCopySettingsUpdate"][] = [],
		requests: string[] = [];
	const positions = new Map<string, Schema["ReadingPositionResponse"]>();
	const initialPosition: Schema["ReadingPositionResponse"] = {
		chapter_id: "first",
		resource_id: "r",
		version_id: "v1",
		part_index: 0,
		kind: "text",
		offset: offset(60),
		at_chapter_end: false,
		progress: 0.5,
		revision: 0,
		updated_at: stamp,
		settings: {
			font_size: 26,
			line_height: 2,
			writing_mode: vertical ? "vertical-rl" : "horizontal-tb",
		},
	};
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		requests.push(`${request.method} ${path}`);
		if (path === "/api/settings/context-copy") {
			if (request.method === "GET") return Response.json(stored);
			if (request.method === "PUT") {
				const update: Schema["ContextCopySettingsUpdate"] =
					await request.json();
				saves.push(update);
				await saveGate;
				if (status !== 200) {
					const failed = status;
					status = 200;
					return Response.json(
						{ detail: "Offline save rejected" },
						{ status: failed },
					);
				}
				check(
					!("expected_revision" in update),
					"Copy save must not carry CAS metadata",
				);
				stored = { ...update, revision: stored.revision + 1 };
				return Response.json(stored);
			}
		}
		if (path === "/api/settings/segment-context")
			return Response.json({
				enabled: true,
				before_sentences: 3,
				after_sentences: 3,
				before_characters: 200,
				after_characters: 200,
				revision: 0,
			});
		if (
			path === "/api/sources/source/segments/material-provenance/matches" &&
			request.method === "POST"
		)
			return Response.json({ segments: [], truncated: false });
		check(
			request.method === "GET" ||
				(request.method === "POST" &&
					/\/(opened|readings\/prepare)$/.test(path)) ||
				(request.method === "PUT" && path.endsWith("/reading-position")),
			`Unexpected learning/model side effect ${request.method} ${path}`,
		);
		const match = path.match(/^\/api\/materials\/([^/]+)(.*)$/),
			id = match?.[1] ?? materialId,
			suffix = match?.[2];
		if (suffix === "")
			return Response.json({
				id,
				source_id: "source",
				title: "設定の本",
				version_id: "v1",
				contract_version: "1",
				product_sha256: hash,
				source_sha256: hash,
				created_at: stamp,
				warnings: [],
				chapters: ["first", "second"].map((chapterId) => ({
					id: chapterId,
					title: chapter(chapterId).title,
					level: 0,
					part_count: 1,
				})),
				reading_position: positions.get(id) ?? initialPosition,
			} satisfies Schema["MaterialResponse"]);
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "离线来源",
				description: "",
				note: "",
				segment_count: 0,
				created_at: stamp,
				updated_at: stamp,
			});
		if (suffix === "/opened" || suffix === "/usage")
			return Response.json({
				material_id: id,
				status: "in_progress",
				revision: 1,
				last_opened_at: stamp,
				updated_at: stamp,
			});
		if (suffix === "/readings/prepare")
			return Response.json({
				material_id: id,
				version_id: "v1",
				generation_id: "g1",
				token_count: 0,
			});
		if (suffix === "/readings")
			return Response.json({
				material_id: id,
				version_id: "v1",
				generation_id: "g1",
				resources: [],
			});
		if (suffix === "/chapters/first" || suffix === "/chapters/second")
			return Response.json({
				...chapter(suffix.endsWith("first") ? "first" : "second"),
				material_id: id,
			});
		if (/\/chapters\/[^/]+\/(segments|translations)$/.test(path))
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (suffix === "/translations")
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (suffix === "/reading-position") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			const saved = {
				...update,
				progress: 0.5,
				revision: update.expected_revision + 1,
				updated_at: stamp,
			};
			positions.set(id, saved);
			return Response.json(saved);
		}
		throw new Error(
			`Unmocked reader settings request ${request.method} ${path}`,
		);
	});
	localStorage.clear();
	localStorage.setItem(
		uiKey,
		JSON.stringify({
			theme: dark ? "black" : "white",
			focus: false,
			toolbarOpacity: 55,
			marks: { studySegmentUnderlines: false, studySegmentMargins: false },
		}),
	);
	localStorage.setItem(
		bookKey,
		JSON.stringify({
			font: "gothic",
			width: 900,
			ruby: "hide",
			rubyScope: "original",
		}),
	);
	const dispose = await h.mount(<Scene />, "*", `/materials/${materialId}`);
	const find = <T extends Element>(
		selector: string,
		scope: ParentNode = h.container,
	) => {
		const found = scope.querySelector<T>(selector);
		check(found, `Missing ${selector}`);
		return found;
	};
	const button = (label: string, scope: ParentNode = h.container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
		);
		check(found && !found.disabled, `Missing enabled button ${label}`);
		return found;
	};
	const field = (label: string) => {
		const found = [
			...h.container.querySelectorAll(".reader-copy-settings label"),
		]
			.find(
				(node) =>
					node.querySelector("span")?.textContent?.trim() === label ||
					node.textContent?.trim() === label,
			)
			?.querySelector("input");
		check(found, `Missing copy field ${label}`);
		return found;
	};
	const details = (label: string) => {
		const found = [
			...h.container.querySelectorAll<HTMLDetailsElement>("details"),
		].find((node) =>
			node.querySelector(":scope > summary")?.textContent?.includes(label),
		);
		check(found, `Missing disclosure ${label}`);
		return found;
	};
	const expand = async (label: string) => {
		const node = details(label);
		if (!node.open) find<HTMLElement>(":scope > summary", node).click();
		await h.until(() => details(label).open, `${label} disclosure must open`);
	};
	const go = async (to: string | number) => {
		check(navigate, "DataRouter navigation must be ready");
		if (typeof to === "number") await navigate(to);
		else await navigate(to);
	};
	const open = async () => {
		button("阅读设置").click();
		await h.until(
			() =>
				!!h.container.querySelector('[role="dialog"][aria-label="阅读设置"]'),
			"Reader settings must open",
		);
	};
	const frame = () => find<HTMLIFrameElement>("iframe.material-part"),
		viewport = () => find<HTMLElement>(".reader-viewport");
	const visible = (index: number) => {
		const outer = frame().getBoundingClientRect(),
			view = viewport().getBoundingClientRect();
		return [
			...(frame()
				.contentDocument?.querySelector(`[data-locator-leaf="${index}"]`)
				?.getClientRects() ?? []),
		].some(
			(rect) =>
				outer.left + rect.right > view.left &&
				outer.left + rect.left < view.right &&
				outer.top + rect.bottom > view.top &&
				outer.top + rect.top < view.bottom,
		);
	};
	const edit = async (value: string) => {
		h.inputValue(field("前文句数"), value);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await h.until(
			() => field("前文句数").value === value,
			"Copy draft must update",
		);
	};
	const blurBudget = async () => {
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const input = field("前文句数");
		input.focus();
		input.blur();
	};
	const noCopyLeaveDialog = () =>
		![...h.container.querySelectorAll("dialog,[role='dialog']")].some((node) =>
			node.textContent?.includes("保存后离开"),
		);
	try {
		await h.until(
			() =>
				!!h.container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector('[data-locator-leaf="60"]') &&
				positions.has(materialId),
			"Real reader must restore and save its middle paragraph",
		);
		await h.until(
			() => visible(60),
			"Initial source paragraph must be visible",
		);
		const originalFrame = frame(),
			originalDocument = frame().contentDocument;
		if (!vertical) {
			const bounds = viewport().getBoundingClientRect();
			check(
				bounds.top === 0 && Math.abs(bounds.bottom - innerHeight) <= 1,
				"Horizontal reading must extend behind chrome to both screen edges",
			);
			const tools = find<HTMLElement>(".reader-bottom nav");
			const box = tools.getBoundingClientRect();
			check(
				document
					.elementsFromPoint(innerWidth / 2, box.top + box.height / 2)
					.includes(originalFrame) &&
					document.elementFromPoint(innerWidth / 2, innerHeight - 2) ===
						originalFrame,
				"Middle-chapter text must remain behind the toolbar and reachable below it",
			);
		}
		if (preview && params.get("panel") === "reading")
			return "reader chrome preview: middle-chapter text behind floating tools";
		await open();
		const panel = find<HTMLElement>('[role="dialog"][aria-label="阅读设置"]');
		for (const label of ["更多排版", "更多界面", "带上下文复制"])
			check(!details(label).open, `${label} must begin collapsed`);
		for (const selector of [
			'input[aria-label="字号"]',
			'[aria-label="文字方向"]',
			'[aria-label="注音显示"]',
			'[aria-label="注音范围"]',
			'[aria-label="纸面主题"]',
		])
			check(
				find<HTMLElement>(selector).getClientRects().length,
				`${selector} must be directly visible`,
			);
		check(
			!panel.querySelector('[aria-label="专注阅读"]') &&
				!!h.container.querySelector('button[aria-label^="专注阅读："]'),
			"Focus reading must retain its single toolbar entry",
		);
		for (const label of [
			"重置排版",
			"重置注音",
			"重置阅读界面",
			"重置复制设置",
		]) {
			const reset = button(label);
			check(
				reset.textContent?.trim() === "重置" &&
					reset.classList.contains("reader-settings-reset-button") &&
					!reset.closest("details"),
				`${label} must be available in its group heading`,
			);
		}
		const lineHeight = find<HTMLInputElement>('input[aria-label="行距"]');
		check(
			lineHeight.value === "2",
			"A saved line height must remain unchanged when the Reader default changes",
		);
		lineHeight.focus();
		check(
			document.activeElement !== lineHeight,
			"Collapsed controls must not accept keyboard focus",
		);
		check(
			![...panel.querySelectorAll("button")].some(
				(node) => node.textContent?.trim() === "恢复默认设置",
			),
			"Cross-group reset must be removed",
		);
		for (const label of ["更多排版", "更多界面", "带上下文复制", "格式示例"])
			await expand(label);
		check(
			panel.querySelectorAll('input[type="range"]').length === 5 &&
				panel.querySelectorAll('input[type="number"]').length === 4 &&
				panel.querySelectorAll('input[role="switch"]').length === 2 &&
				panel.querySelectorAll('input[type="checkbox"]:not([role="switch"])')
					.length === 1 &&
				panel.querySelectorAll(".reader-options").length === 5,
			"17 panel values must retain one editing entry: 5 sliders, 4 budgets, 2 switches, 1 checkbox and 5 option groups",
		);
		for (const label of ["展示阅读记录下划线", "展示阅读记录页边入口"]) {
			const control = find<HTMLInputElement>(
				`input[aria-label="${label}"]`,
				panel,
			);
			check(
				control.closest("label")?.textContent?.trim() === label &&
					control.getAttribute("role") === "switch" &&
					control.getAttribute("aria-checked") === String(control.checked),
				`${label} must expose its switch state and share its visible and accessible name`,
			);
		}
		for (const control of panel.querySelectorAll<HTMLElement>(
			"input,button,summary",
		)) {
			if (
				(control instanceof HTMLInputElement ||
					control instanceof HTMLButtonElement) &&
				control.disabled
			)
				continue;
			control.scrollIntoView({ block: "nearest", inline: "nearest" });
			const rect = control.getBoundingClientRect(),
				bounds = panel.getBoundingClientRect();
			check(
				rect.width > 0 &&
					rect.left >= bounds.left - 1 &&
					rect.right <= bounds.right + 1 &&
					rect.top >= 0 &&
					rect.bottom <= innerHeight + 1,
				`Control must remain reachable at ${innerWidth}px: ${control.outerHTML}`,
			);
		}
		check(
			panel.scrollWidth <= panel.clientWidth + 1,
			"Settings panel must have no horizontal overflow",
		);
		check(
			getComputedStyle(panel).colorScheme.includes(dark ? "dark" : "light"),
			"Settings must inherit Reader paper color scheme",
		);
		const opacity = find<HTMLInputElement>(
			'input[aria-label="工具栏背景不透明度"]',
		);
		const geometry = () =>
			JSON.stringify({
				frame: frame().getBoundingClientRect().toJSON(),
				viewport: viewport().getBoundingClientRect().toJSON(),
				top: viewport().scrollTop,
				left: viewport().scrollLeft,
			});
		const beforeOpacity = geometry();
		const popoverOpacity = find<HTMLInputElement>(
			'input[aria-label="浮窗背景不透明度"]',
		);
		check(
			popoverOpacity.value === "72" &&
				popoverOpacity.min === "20" &&
				popoverOpacity.max === "100",
			"Shared popover opacity must default to 72% with a 20–100% range",
		);
		h.inputValue(popoverOpacity, "35");
		await h.until(
			() =>
				JSON.parse(localStorage.getItem(uiKey) ?? "{}").dictionaryOpacity ===
					35 &&
				getComputedStyle(find<HTMLElement>("main.reader-r1"))
					.getPropertyValue("--reader-popover-opacity")
					.trim() === "35%",
			"Shared popover opacity must apply immediately through the saved dictionary preference",
		);
		check(
			opacity.value === "55" && geometry() === beforeOpacity,
			"Popover opacity must preserve toolbar opacity and reading geometry",
		);
		const canvas = document.createElement("canvas").getContext("2d");
		check(canvas, "Toolbar alpha check requires a canvas color parser");
		for (const value of [0, 50, 100, 55]) {
			h.inputValue(opacity, String(value));
			await h.until(
				() =>
					JSON.parse(localStorage.getItem(uiKey) ?? "{}").toolbarOpacity ===
					value,
				"Toolbar background opacity must apply immediately",
			);
			for (const selector of [".reader-top", ".reader-bottom nav"]) {
				const chrome = find<HTMLElement>(selector);
				canvas.clearRect(0, 0, 1, 1);
				canvas.fillStyle = getComputedStyle(chrome).backgroundColor;
				canvas.fillRect(0, 0, 1, 1);
				check(
					Math.abs(
						(canvas.getImageData(0, 0, 1, 1).data[3] ?? Number.NaN) / 255 -
							value / 100,
					) < 0.01 &&
						getComputedStyle(chrome).opacity === "1" &&
						getComputedStyle(find("button:not(:disabled)", chrome)).opacity ===
							"1",
					"Opacity must tint only the chrome background, leaving controls clear",
				);
			}
			check(
				geometry() === beforeOpacity &&
					frame() === originalFrame &&
					frame().contentDocument === originalDocument,
				"Opacity must preserve text geometry, scroll position and iframe identity",
			);
		}
		if (preview) {
			if (params.get("panel") !== "expanded") {
				for (const label of ["更多排版", "更多界面", "带上下文复制"])
					find<HTMLElement>(":scope > summary", details(label)).click();
			}
			find<HTMLElement>(".reader-panel-body", panel).scrollTop = 0;
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			await h.until(
				() =>
					getComputedStyle(panel).opacity === "1" &&
					panel
						.getAnimations()
						.every((animation) => animation.playState === "finished"),
				"Preview must wait for the real panel entrance transition",
			);
			return `reader settings preview ${innerWidth}px/${vertical ? "vertical" : "horizontal"}/${dark ? "dark" : "light"}`;
		}
		await edit("7");
		const beforeResetUi = localStorage.getItem(uiKey);
		button("重置排版").click();
		await h.until(
			() =>
				find<HTMLInputElement>('input[aria-label="字号"]').value === "22" &&
				find<HTMLInputElement>('input[aria-label="行距"]').value === "2.4" &&
				positions.get(materialId)?.settings?.line_height === 2.4 &&
				positions.get(materialId)?.settings?.writing_mode === "horizontal-tb",
			"Typography reset must restore existing defaults",
		);
		check(
			JSON.parse(localStorage.getItem(bookKey) ?? "{}").ruby === "hide" &&
				localStorage.getItem(uiKey) === beforeResetUi &&
				field("前文句数").value === "7",
			"Typography reset must isolate ruby/interface/copy",
		);
		await h.until(
			() => visible(60),
			"Typography reset must retain source paragraph",
		);
		h.inputValue(find<HTMLInputElement>('input[aria-label="字号"]'), "25");
		button("重置注音").click();
		await h.until(
			() => JSON.parse(localStorage.getItem(bookKey) ?? "{}").ruby === "show",
			"Ruby reset must apply defaults",
		);
		check(
			find<HTMLInputElement>('input[aria-label="字号"]').value === "25" &&
				localStorage.getItem(uiKey) === beforeResetUi &&
				field("前文句数").value === "7",
			"Ruby reset must isolate typography/interface/copy",
		);
		button("隐藏", find('[aria-label="注音显示"]')).click();
		const focusBeforeInterfaceReset = JSON.parse(
			localStorage.getItem(uiKey) ?? "{}",
		).focus;
		button("重置阅读界面").click();
		await h.until(
			() =>
				find<HTMLInputElement>('input[aria-label="工具栏背景不透明度"]')
					.value === "80" && popoverOpacity.value === "72",
			"Interface reset must restore defaults",
		);
		check(
			find<HTMLInputElement>('input[aria-label="字号"]').value === "25" &&
				JSON.parse(localStorage.getItem(bookKey) ?? "{}").ruby === "hide" &&
				field("前文句数").value === "7" &&
				JSON.parse(localStorage.getItem(uiKey) ?? "{}").focus ===
					focusBeforeInterfaceReset,
			"Interface reset must isolate typography/ruby/copy and toolbar focus",
		);
		check(
			frame() === originalFrame && frame().contentDocument === originalDocument,
			"Group resets must retain iframe and Document identity",
		);
		await h.until(
			() => visible(60),
			"Group resets must preserve current original text",
		);
		button("重置复制设置").click();
		await h.until(
			() => field("前文句数").value === "2" && stored.before_sentences === 2,
			"Copy reset must automatically persist the default group",
		);
		const beforeInvalid = saves.length;
		await edit("");
		await blurBudget();
		await new Promise((resolve) => setTimeout(resolve, 0));
		check(
			field("前文句数").getAttribute("aria-invalid") === "true" &&
				saves.length === beforeInvalid,
			"Empty numeric input must remain invalid without saving zero",
		);
		find<HTMLElement>(":scope > summary", details("带上下文复制")).click();
		await h.until(
			() => !details("带上下文复制").open,
			"Copy group must collapse",
		);
		check(
			find('[data-reader-settings-group="copy"]').textContent?.includes("整数"),
			"Collapsed copy group must retain invalid input feedback",
		);
		button("关闭阅读设置").click();
		await h.until(
			() =>
				!h.container.querySelector('[role="dialog"][aria-label="阅读设置"]'),
			"Settings must close without a draft confirmation",
		);
		check(
			noCopyLeaveDialog(),
			"Closing copy settings must not open leave protection",
		);
		button("书籍信息").click();
		await h.until(
			() => !!h.container.querySelector(".reader-book-info"),
			"Right tool must replace settings",
		);
		await open();
		check(
			!details("带上下文复制").open &&
				details("更多排版").open &&
				field("前文句数").value === "",
			"Replacing tools must retain same-reader raw input and disclosure state",
		);
		await expand("带上下文复制");
		await edit("7");
		await blurBudget();
		await h.until(
			() => stored.before_sentences === 7,
			"Numeric blur must save the whole valid group",
		);
		const body = find<HTMLElement>(
			".reader-panel-body",
			find('[aria-label="阅读设置"][role="dialog"]'),
		);
		body.scrollTop = Math.min(250, body.scrollHeight - body.clientHeight);
		const panelScroll = body.scrollTop;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		button("关闭阅读设置").click();
		await h.until(
			() =>
				!h.container.querySelector('[role="dialog"][aria-label="阅读设置"]'),
			"Panel must close before scroll retention",
		);
		await open();
		check(
			Math.abs(
				find<HTMLElement>(
					".reader-panel-body",
					find('[aria-label="阅读设置"][role="dialog"]'),
				).scrollTop - panelScroll,
			) <= 2,
			"Reopened settings must retain scroll position",
		);
		button("下一章").click();
		await h.until(
			() => positions.get(materialId)?.chapter_id === "second",
			"Chapter switch must complete",
		);
		check(
			field("前文句数").value === "7" && details("带上下文复制").open,
			"Chapter switch must retain copy inputs",
		);
		await edit("");
		await go(`/materials/${materialId}/?entry=settings-test`);
		await h.until(
			() =>
				route.endsWith("/?entry=settings-test") &&
				!h.container.querySelector(".reader-opening"),
			"Same-reader query must validate without copy protection",
		);
		check(
			noCopyLeaveDialog(),
			"Same-reader validation must not expose copy draft choices",
		);
		await go("/segments/saved/");
		await h.until(
			() => !!h.container.querySelector("[data-segment-page]"),
			"Invalid copy input must not block entering Segment",
		);
		check(
			noCopyLeaveDialog(),
			"Entering Segment must not ask to save or discard copy inputs",
		);
		const retainedFrame = frame();
		check(
			retainedFrame.getClientRects().length === 0,
			"Segment must pause retained Reader",
		);
		await go(-1);
		await h.until(
			() => !!frame().getClientRects().length,
			"History POP must resume Reader without copy protection",
		);
		check(
			frame() === retainedFrame,
			"Copy route changes must preserve retained reading surface",
		);
		if (!h.container.querySelector('[role="dialog"][aria-label="阅读设置"]'))
			await open();
		await expand("带上下文复制");
		await edit("");
		// The independent Segment draft must still guard navigation.
		await new Promise((resolve) => setTimeout(resolve, 150));
		const selectionDoc = frame().contentDocument,
			nativeSelection = selectionDoc?.getSelection();
		const selectionLeaf = selectionDoc?.querySelector(
			'[data-locator-leaf="0"]',
		);
		check(
			selectionDoc && nativeSelection && selectionLeaf,
			"Study draft must start from real original text",
		);
		const selectionRange = selectionDoc.createRange();
		selectionRange.selectNodeContents(selectionLeaf);
		nativeSelection.removeAllRanges();
		nativeSelection.addRange(selectionRange);
		selectionDoc.dispatchEvent(new Event("selectionchange"));
		await h.until(
			() => !!h.container.querySelector('[aria-label="选区操作"]'),
			"Native selection must expose study creation",
		);
		button("保存为学习片段").click();
		await h.until(
			() => !!h.container.querySelector(".study-translation-field textarea"),
			"Real study editor must open",
		);
		const studyText = find<HTMLTextAreaElement>(
			".study-translation-field textarea",
		);
		h.inputValue(studyText, "保留する訳文");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const studyDialog = () =>
			[...h.container.querySelectorAll("dialog")].find((node) =>
				node.textContent?.includes("放弃本次草稿"),
			);
		await go("/materials");
		await h.until(
			() => !!studyDialog(),
			"Segment draft must still guard leaving Reader",
		);
		check(noCopyLeaveDialog(), "Only the Segment draft may guard navigation");
		button("继续编辑", studyDialog()).click();
		await h.until(() => !studyDialog(), "Continuing must retain Segment draft");
		check(
			route.startsWith(`/materials/${materialId}`) &&
				studyText.value === "保留する訳文",
			"Cancelling Segment leave must retain its text and route",
		);
		await go("/materials");
		await h.until(
			() => !!studyDialog(),
			"Second leave must still protect Segment draft",
		);
		button("放弃草稿", studyDialog()).click();
		await h.until(
			() => route === "/materials",
			"Discarding Segment draft must leave directly without copy confirmation",
		);
		check(
			noCopyLeaveDialog(),
			"Copy inputs must not add a second leave participant",
		);
		await go(`/materials/${materialId}`);
		await h.until(
			() =>
				!!h.container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector("[data-locator-leaf]"),
			"Reader must reopen for automatic saves",
		);
		await open();
		await expand("带上下文复制");
		saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		const beforePending = saves.length;
		await edit("8");
		await blurBudget();
		await h.until(
			() => saves.length === beforePending + 1,
			"Automatic blur save must enter controlled request",
		);
		check(
			!field("前文句数").disabled,
			"Saving must leave numeric inputs editable",
		);
		await edit("9");
		check(releaseSave, "Pending save must have a controlled completion");
		releaseSave();
		saveGate = undefined;
		await h.until(
			() =>
				stored.before_sentences === 8 &&
				!h.container.textContent?.includes("正在保存复制设置"),
			"First save must finish without submitting unblurred newer input",
		);
		check(
			field("前文句数").value === "9" && saves.length === beforePending + 1,
			"Old save receipt must not erase newer typed input or save it before blur",
		);
		await blurBudget();
		await h.until(
			() => stored.before_sentences === 9,
			"New numeric input must save on its own blur",
		);
		// Returning to the old baseline while B is pending is still a newer input intent.
		const oldBaseline = String(stored.before_sentences);
		saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		const beforeBaselineReturn = saves.length;
		await edit("13");
		await blurBudget();
		await h.until(
			() => saves.length === beforeBaselineReturn + 1,
			"Baseline-return test must capture submitted B",
		);
		await edit(oldBaseline);
		check(
			releaseSave,
			"Baseline-return request must have a controlled completion",
		);
		releaseSave();
		saveGate = undefined;
		await h.until(
			() =>
				stored.before_sentences === 13 &&
				!h.container.textContent?.includes("正在保存复制设置"),
			"B must finish while the newer A input remains unsubmitted",
		);
		check(
			field("前文句数").value === oldBaseline &&
				saves.length === beforeBaselineReturn + 1,
			"B's receipt and query refresh must preserve unblurred input returned to the old baseline A",
		);
		await blurBudget();
		await h.until(
			() =>
				stored.before_sentences === Number(oldBaseline) &&
				saves.length === beforeBaselineReturn + 2,
			"A must persist only when its newer input is blurred",
		);
		status = 503;
		await edit("10");
		await blurBudget();
		await h.until(
			() => !!h.container.textContent?.includes("保存失败"),
			"Automatic save failure must remain visible",
		);
		check(
			field("前文句数").value === "10",
			"Failure must preserve editable input",
		);
		find<HTMLElement>(":scope > summary", details("带上下文复制")).click();
		check(
			find('[data-reader-settings-group="copy"]').textContent?.includes(
				"保存失败",
			),
			"Collapsed group must keep save failure discoverable",
		);
		await expand("带上下文复制");
		button("重试保存复制设置").click();
		await h.until(
			() => stored.before_sentences === 10,
			"Retry must save retained current inputs",
		);
		// A submitted write belongs to the window queue and must survive its Reader leaving.
		saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		const beforeLeaving = saves.length;
		await edit("11");
		await blurBudget();
		await h.until(
			() => saves.length === beforeLeaving + 1,
			"Leaving test must capture a pending PUT",
		);
		await go("/materials");
		await h.until(
			() => route === "/materials",
			"Pending copy save must not delay navigation",
		);
		check(noCopyLeaveDialog(), "Pending copy save must not open leave choices");
		await go("/materials/other");
		await h.until(
			() =>
				!!h.container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector("[data-locator-leaf]"),
			"Other book must open while original save is pending",
		);
		await open();
		await expand("带上下文复制");
		await edit("12");
		await blurBudget();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		check(
			saves.length === beforeLeaving + 1,
			"Another Reader must share the window's serial save queue",
		);
		check(releaseSave, "Departed Reader request must still be releasable");
		releaseSave();
		saveGate = undefined;
		await h.until(
			() =>
				stored.before_sentences === 12 && saves.length === beforeLeaving + 2,
			"Departed PUT must finish before the next Reader's queued save",
		);
		check(
			saves[beforeLeaving]?.before_sentences === 11 &&
				saves[beforeLeaving + 1]?.before_sentences === 12,
			"Window queue must persist writes in submission order",
		);
		check(
			field("前文句数").value === "12",
			"Late prior Reader receipt must not overwrite current Reader input",
		);
		if (!vertical) {
			await h.until(
				() => positions.has("other"),
				"Other book must finish restoring before scrolling to its end",
			);
			viewport().scrollTop = viewport().scrollHeight;
			await h.until(() => {
				const last = frame().contentDocument?.querySelector(
					'[data-locator-leaf="119"]',
				);
				if (!last) return false;
				const bottom =
					frame().getBoundingClientRect().top +
					last.getBoundingClientRect().bottom;
				return (
					bottom > 70 &&
					bottom < find(".reader-bottom nav").getBoundingClientRect().top
				);
			}, "Trailing scroll space must reveal the complete last line above the toolbar");
		}
		await go("/settings/context-copy");
		await h.until(
			() => route === "/settings/context-copy",
			"Clean Reader must leave normally",
		);
		await go("/settings/appearance");
		await h.until(
			() => route === "/settings/appearance",
			"Retired Reader draft must not block unrelated settings",
		);
		return `reader settings: ${innerWidth}px/${vertical ? "vertical" : "horizontal"}/${dark ? "dark" : "light"}; real ReaderSessionHost + DataRouter; 17 panel controls and toolbar focus, shared popover opacity, collapsed focus, isolated resets/source position; panel/tool/chapter/scroll input retention; blur/reset autosave, invalid inputs, editable pending receipts, Segment-only guard, unblocked routes and shared serial PUTs surviving departure; ${requests.length} mocked requests`;
	} finally {
		if (!preview) dispose();
	}
}
