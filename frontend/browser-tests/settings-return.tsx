import { Link } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";
import {
	readerSessionFixture as fixture,
	readerSessionFixtureData,
} from "./reader-session-fixture";
import { provider, settings } from "./workbench";

type Schema = components["schemas"];

export async function settingsReturn(h: BrowserHarness): Promise<string> {
	const { App, appRoutes } = await import("../src/App");
	const { targetIdentity } = await import("../src/translation/state");
	const { container, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search);
	const preview = params.has("preview");
	document.documentElement.dataset.theme =
		params.get("theme") === "dark" ? "dark" : "light";
	if (preview)
		document.querySelector<HTMLElement>("#result")?.setAttribute("hidden", "");
	const bookTitle = params.has("long-title")
		? "夏目漱石作品集：坊っちゃん・吾輩は猫である・こころを原文で読む"
		: fixture.book.title;
	const identity = await targetIdentity(fixture.reference);
	const result: Schema["TranslationResultResponse"] = {
		id: "settings-result",
		task_id: "settings-task",
		source_id: "source",
		material_id: fixture.materialId,
		material_deleted: false,
		reader_deleted: false,
		material_provenance: fixture.reference,
		identity_sha256: identity,
		text: fixture.targetText,
		translation: "春风吹过安静的庭院。",
		context_before: "",
		context_after: "",
		target_language: "简体中文",
		scheme_name: "默认翻译",
		model_id: "model",
		run_id: "run",
		created_at: fixture.timestamp,
		adopted_segment_ids: [],
		chapter_id: fixture.chapterId,
		parts: [],
		scheme_id: "default",
		scheme_revision: 1,
		provider_name: "离线服务",
		protocol: "responses",
		prompt_version: "v1",
		temperature: null,
		reasoning_effort: null,
		max_output_tokens: 4000,
	};
	let translation: Schema["TranslationSettingsResponse"] = {
		id: "default",
		adapter: "llm",
		revision: 1,
		name: "默认翻译",
		model_id: null,
		target_language: "简体中文",
		before_sentences: 3,
		after_sentences: 0,
		before_characters: 200,
		after_characters: 0,
		max_context_characters: 2000,
		max_target_characters: 2000,
	};
	let position = fixture.book.reading_position;
	let failTranslations = false;
	let generationCalls = 0;
	let bookReads = 0;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings/context-copy")
			return Response.json(defaultContextCopySettings);
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/settings/translation") {
			if (request.method === "PUT") {
				const update: Schema["TranslationSettingsUpdate"] =
					await request.json();
				translation = {
					...translation,
					...update,
					revision: translation.revision + 1,
				};
			}
			return Response.json(translation);
		}
		if (path === `/api/materials/${fixture.materialId}`) {
			bookReads++;
			return Response.json({
				...fixture.book,
				title: bookTitle,
				reading_position: position,
			});
		}
		if (path.endsWith("/reading-position") && request.method === "PUT") {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			position = {
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: fixture.timestamp,
			};
			return Response.json(position);
		}
		if (/\/chapters\/[^/]+\/translations$/.test(path))
			return failTranslations
				? Response.json({ detail: "记录暂时读取失败" }, { status: 503 })
				: Response.json({
						items: [
							{
								identity_sha256: identity,
								result_id: result.id,
								material_provenance: fixture.reference,
								excerpt: fixture.targetText,
								translation_excerpt: result.translation,
								target_language: result.target_language,
								result_count: 1,
								created_at: fixture.timestamp,
							},
						],
						next_cursor: null,
						unavailable_count: 0,
					});
		if (path === `/api/materials/${fixture.materialId}/translations`) {
			if (request.method === "POST") generationCalls++;
			return Response.json({ results: [result], tasks: [], next_offset: null });
		}
		if (path === `/api/translation-results/${result.id}`)
			return Response.json(result);
		if (path.endsWith(`/translation-results/${result.id}/segments`))
			return Response.json({ segments: [], truncated: false });
		const data = readerSessionFixtureData(path, { studyRecords: false });
		check(
			data !== undefined,
			`Unexpected settings-return request ${request.method} ${path}`,
		);
		return Response.json(data);
	});
	function button(label: string, scope: ParentNode = container) {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) ===
					label && node.getClientRects().length > 0,
		);
		check(found && !found.disabled, `Missing settings-return action ${label}`);
		return found;
	}
	const sourceTo = "/sources/source?view=materials&page=2";
	const dispose = await h.mount(
		<App />,
		"/",
		sourceTo,
		appRoutes.map((route) =>
			route.path === "/sources/:id"
				? {
						...route,
						element: (
							<>
								<Link
									to={`/materials/${fixture.materialId}/`}
									state={{ returnTo: { to: sourceTo, label: "原来源" } }}
								>
									打开书籍
								</Link>
								<Link to="/settings?section=appearance">独立设置</Link>
							</>
						),
					}
				: route,
		),
	);
	try {
		await until(
			() =>
				!!container.querySelector(
					`a[href="/materials/${fixture.materialId}/"]`,
				),
			"Catalog fixture must mount its reader entry",
		);
		container
			.querySelector<HTMLAnchorElement>(
				`a[href="/materials/${fixture.materialId}/"]`,
			)
			?.click();
		await until(
			() => !!container.querySelector('button[aria-label="本章记录"]'),
			"Reader must open from its catalog parent",
		);
		button("本章记录").click();
		await until(
			() => !!container.querySelector(".reader-record-translation"),
			"Chapter translation list must load",
		);
		button("翻译").click();
		await until(
			() =>
				container
					.querySelector('[aria-label="翻译"][role="tab"]')
					?.getAttribute("aria-selected") === "true",
			"Chapter translation tab must be selected",
		);
		container
			.querySelector<HTMLButtonElement>(".reader-record-translation")
			?.click();
		await until(
			() => !!container.querySelector(".translation-output"),
			"Chapter record must open translation detail",
		);
		const panel = container.querySelector(".translation-card");
		const frames = [
			...container.querySelectorAll<HTMLIFrameElement>(".reader-r1 iframe"),
		];
		const documents = frames.map((frame) => frame.contentDocument);
		const before = container.querySelector<HTMLTextAreaElement>(
			".translation-card textarea",
		);
		check(before, "Expanded chapter translation must expose context");
		const details = before.closest("details");
		if (details) details.open = true;
		inputValue(before, "往返设置后保留的语境");
		const viewport = container.querySelector<HTMLElement>(".reader-viewport");
		check(viewport, "Reader viewport must remain mounted");
		await until(
			() =>
				container
					.querySelector(".reader-r1[data-presented]")
					?.getAttribute("data-presented") === "true",
			"Reading layout must be presented before scrolling",
		);
		viewport.scrollTop = 900;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		const originalScroll = viewport.scrollTop;
		const coordinates = () =>
			position
				? JSON.stringify([
						position.version_id,
						position.chapter_id,
						position.resource_id,
						position.part_index,
						position.kind,
						position.offset,
					])
				: null;
		await until(
			() => (position?.offset ?? 0) > 0,
			"Scrolled position must reach the existing position writer",
		);
		const originalCoordinates = coordinates();
		const leaf = frames[0]?.contentDocument?.querySelector<HTMLElement>(
			"[data-locator-leaf]",
		);
		check(leaf, "Reader must have measurable source text");
		const lineHeight = Number.parseFloat(
			leaf.ownerDocument.defaultView?.getComputedStyle(leaf).lineHeight ?? "0",
		);
		check(lineHeight > 0, "Reader line height must be measurable");
		check(
			originalScroll > 500,
			"Settings round trip must start away from the chapter beginning",
		);
		if (preview && params.get("scene") !== "settings")
			return "settings return preview: actual App and reader with offline translation detail";
		const openSettings = async () => {
			const link = container.querySelector<HTMLAnchorElement>(
				'.translation-card a[href="/settings?section=translation"]',
			);
			check(link, "Translation detail must expose its settings entry");
			link.click();
			await until(
				() => !!container.querySelector("#settings-reading-return"),
				"Translation settings must expose a validated return link",
			);
			check(
				frames.every(
					(frame, index) =>
						frame.isConnected &&
						frame.contentDocument === documents[index] &&
						!frame.getClientRects().length,
				),
				"Settings must suspend, not dispose, reader documents",
			);
		};
		const returnToReader = async (viaNotice = false) => {
			const reads = bookReads;
			container
				.querySelector<HTMLAnchorElement>(
					viaNotice
						? ".settings-reading-notice-action"
						: "#settings-reading-return",
				)
				?.click();
			await until(
				() =>
					bookReads > reads &&
					frames.every((frame) => !!frame.getClientRects().length),
				"Return must revalidate and resume the same reader",
			);
			await until(
				() =>
					!!container.querySelector(".translation-card textarea") &&
					!container.querySelector(
						'.reader-chapter-records[aria-hidden="true"]',
					),
				"Translation detail must resume after record refresh",
			);
			check(
				panel?.isConnected &&
					before.isConnected &&
					before.value === "往返设置后保留的语境",
				"Same translation detail and edited context must survive settings navigation",
			);
			check(
				container
					.querySelector('a[aria-label="返回原来源"]')
					?.getAttribute("href") === sourceTo,
				"Reader's original catalog parent must survive the settings return",
			);
			await until(
				() =>
					coordinates() === originalCoordinates &&
					Math.abs(viewport.scrollTop - originalScroll) < lineHeight,
				"Settings return must retain the exact saved text coordinates and restore the viewport within one line",
			);
		};
		await openSettings();
		await until(
			() =>
				container.querySelector(".settings-reading-notice-title")
					?.textContent === `《${bookTitle}》`,
			"Return notice must show the actual book title",
		);
		const notice = container.querySelector<HTMLElement>(
			".settings-reading-notice",
		);
		const headerReturn = container.querySelector<HTMLAnchorElement>(
			"#settings-reading-return",
		);
		check(notice && headerReturn, "Both return paths must be available");
		const bounds = notice.getBoundingClientRect();
		check(
			bounds.left >= 0 &&
				bounds.right <= innerWidth &&
				bounds.top >= 0 &&
				bounds.bottom <= innerHeight,
			"Return notice must fit the viewport",
		);
		check(
			notice.scrollWidth <= notice.clientWidth + 1,
			"Long book names must not overflow the notice",
		);
		const pageContent = container.querySelector<HTMLElement>(
			".settings-page > .page-content",
		);
		check(
			pageContent &&
				Number.parseFloat(getComputedStyle(pageContent).paddingBottom) >=
					bounds.height + 24,
			"Bottom settings controls must scroll clear of the floating notice",
		);
		check(
			headerReturn.textContent?.includes(bookTitle),
			"Page header must name the return book",
		);
		if (preview)
			return "settings return preview: contextual return notice and header action";
		button("关闭阅读返回提示").click();
		await until(
			() => !container.querySelector(".settings-reading-notice"),
			"Closing the notice must hide only its presentation",
		);
		check(
			document.activeElement === headerReturn,
			"Closing the notice must focus the persistent header return",
		);
		check(
			frames.every((frame) => frame.isConnected),
			"Closing a notice must retain the reading session",
		);
		await until(
			() =>
				!!container.querySelector('#translation-model option[value="model"]'),
			"Translation settings must load provider models before selection",
		);
		const model =
			container.querySelector<HTMLSelectElement>("#translation-model");
		check(model, "Translation model control must load");
		model.value = "model";
		model.dispatchEvent(new Event("change", { bubbles: true }));
		await until(
			() => translation.model_id === "model",
			"Translation setting must save independently",
		);
		container
			.querySelector<HTMLAnchorElement>('a[href="/settings?section=models"]')
			?.click();
		await until(
			() => !!container.querySelector('a[href="/settings?section=providers"]'),
			"Model section must retain the reader return",
		);
		container
			.querySelector<HTMLAnchorElement>('a[href="/settings?section=providers"]')
			?.click();
		await until(
			() => !!container.querySelector(".provider-settings"),
			"Service settings must open",
		);
		check(
			!container.querySelector(".settings-reading-notice"),
			"Dismissed notice must not reappear when changing settings sections",
		);
		await returnToReader();
		check(
			generationCalls === 0,
			"Settings round trip must not retranslate existing content",
		);
		await openSettings();
		await until(
			() => !!container.querySelector(".settings-reading-notice"),
			"A new reader-to-settings trip must show a new notice",
		);
		failTranslations = true;
		await returnToReader(true);
		await until(
			() => container.textContent?.includes("记录暂时读取失败") ?? false,
			"Failed refresh must show a retryable record error",
		);
		check(
			panel?.isConnected,
			"Failed chapter refresh must not unmount the selected translation",
		);
		failTranslations = false;
		button("重试读取本章翻译").click();
		await until(
			() => !container.textContent?.includes("记录暂时读取失败"),
			"Record retry must recover",
		);
		check(
			before.value === "往返设置后保留的语境" && generationCalls === 0,
			"Retry must preserve context without model calls",
		);
		container
			.querySelector<HTMLAnchorElement>('a[aria-label="返回原来源"]')
			?.click();
		await until(
			() => !!container.querySelector('a[href="/settings?section=appearance"]'),
			"Original source must restore its independent settings entry",
		);
		container
			.querySelector<HTMLAnchorElement>(
				'a[href="/settings?section=appearance"]',
			)
			?.click();
		await until(
			() => !!container.querySelector(".settings-topbar"),
			"Independent settings must open",
		);
		check(
			!container.querySelector("#settings-reading-return") &&
				!container.querySelector(".settings-reading-notice"),
			"Independent settings must not invent a reading return",
		);
		return `settings return ${innerWidth}px: actual App; trailing-slash entry; exact reader/catalog return trail; same documents/detail/context; model settings save; provider navigation; failed record refresh retry; dismissal and header fallback; section persistence and new-trip reset; independent settings exclusion; no translation generation`;
	} finally {
		if (!preview) dispose();
	}
}
