import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, type Location, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";
import {
	readerSessionFixture as fixture,
	readerSessionFixtureData,
} from "./reader-session-fixture";
import { makeThread, provider, settings } from "./workbench";

type Schema = components["schemas"];
const sourceTo = "/sources/source?view=materials&page=2";
const analysis: Schema["AnalysisDetail"] = {
	id: "navigation-analysis",
	segment_id: "saved",
	title: "往返设置时保留的独立讲解",
	excerpt: "离线讲解摘要",
	current_revision_id: "navigation-revision",
	revision_id: "navigation-revision",
	parent_revision_id: null,
	origin: "manual",
	run_id: null,
	normalizer_version: 1,
	created_at: fixture.timestamp,
	updated_at: fixture.timestamp,
	source_md: Array.from(
		{ length: 45 },
		(_, index) => `第 ${index + 1} 段讲解。春の風が静かな庭を通り抜ける。`,
	).join("\n\n"),
	warnings: [],
	sections: [],
};

/** Real routes and controls; every request is handled by an offline fixture. */
export async function focusedNavigation(h: BrowserHarness) {
	const { App, appRoutes } = await import("../src/App");
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search);
	const metadataScene = params.get("notice-metadata");
	if (metadataScene === "failed" || metadataScene === "long")
		return segmentNoticeMetadata(h, metadataScene);
	const capture = params.has("capture") || params.has("preview");
	// Keep the harness output from displacing the full-height application surface.
	document.querySelector<HTMLElement>("#result")?.setAttribute("hidden", "");
	let client: ReturnType<typeof useQueryClient> | undefined;
	let route: Location | undefined;
	let navigate: ReturnType<typeof useNavigate> | undefined;
	function Navigator() {
		client = useQueryClient();
		const current = useLocation();
		const go = useNavigate();
		useEffect(() => {
			route = current;
			navigate = go;
		}, [current, go]);
		return null;
	}
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	let position = fixture.book.reading_position;
	let failSegment = false;
	let staleRead: Promise<Response> | undefined;
	let releaseStaleRead: ((response: Response) => void) | undefined;
	let deletedSegment = false;
	let releaseSegment: (() => void) | undefined;
	let segmentGate: Promise<void> | undefined;
	const requests: Array<{ method: string; path: string }> = [];
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		requests.push({ method: request.method, path });
		check(
			request.method === "GET" ||
				(request.method === "POST" &&
					(path.endsWith("/readings/prepare") || path.endsWith("/opened"))) ||
				(request.method === "PUT" && path.endsWith("/reading-position")),
			`Navigation must not write content or invoke a model: ${request.method} ${path}`,
		);
		if (path === "/api/segments/saved") {
			if (deletedSegment)
				return Response.json({ detail: "片段已删除" }, { status: 404 });
			if (staleRead) return staleRead;
			await segmentGate;
			if (failSegment)
				return Response.json(
					{ detail: "离线回归：片段暂不可读取" },
					{ status: 503 },
				);
		}
		if (path === "/api/settings/context-copy")
			return Response.json(defaultContextCopySettings);
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/settings/segment-context")
			return Response.json({
				enabled: true,
				before_sentences: 3,
				after_sentences: 3,
				before_characters: 200,
				after_characters: 200,
				revision: 0,
			} satisfies Schema["SegmentContextSettingsResponse"]);
		if (path === "/api/sources") return Response.json([]);
		if (path === "/api/materials")
			return Response.json({ items: [], page: 1, page_size: 50, total: 0 });
		if (path === `/api/materials/${fixture.materialId}`)
			return Response.json({ ...fixture.book, reading_position: position });
		if (path.endsWith("/reading-position")) {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			position = {
				...update,
				revision: update.expected_revision + 1,
				progress: 0,
				updated_at: fixture.timestamp,
			};
			return Response.json(position);
		}
		if (path === "/api/segments/saved/analyses")
			return Response.json([analysis]);
		if (path === `/api/analyses/${analysis.id}`) return Response.json(analysis);
		if (/^\/api\/segments\/(saved|other)\/threads$/.test(path))
			return Response.json({
				items: [
					{
						...makeThread(),
						id: path.includes("/other/") ? "other-thread" : "thread",
						segment_id: path.includes("/other/") ? "other" : "saved",
					},
				],
				next_cursor: null,
			});
		if (path === "/api/threads/thread" || path === "/api/threads/other-thread")
			return Response.json({
				...makeThread(),
				id: path.endsWith("other-thread") ? "other-thread" : "thread",
				segment_id: route?.pathname.endsWith("/other") ? "other" : "saved",
			});
		if (
			path === "/api/threads/thread/messages" ||
			path === "/api/threads/other-thread/messages"
		)
			return Response.json({ items: [], next_cursor: null });
		const data = readerSessionFixtureData(
			path.replace("/api/segments/other", "/api/segments/saved"),
		);
		check(
			data !== undefined,
			`Unmocked focused navigation ${request.method} ${path}`,
		);
		return Response.json(
			path === "/api/segments/other"
				? {
						...(data as Schema["SegmentResponse"]),
						id: "other",
						text: "別の片段。",
					}
				: path === "/api/segments/other/analyses"
					? []
					: data,
		);
	});
	function find<T extends Element>(selector: string): T {
		const node = h.container.querySelector<T>(selector);
		check(node, `Missing focused navigation element ${selector}`);
		return node;
	}
	const click = (selector: string) => find<HTMLElement>(selector).click();
	const frames = () => [
		...h.container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	const readyReader = () =>
		h.until(
			() =>
				frames().length === 3 &&
				frames().every(
					(frame) =>
						!!frame.getClientRects().length &&
						!!frame.contentDocument?.querySelector("[data-locator-leaf]"),
				),
			"Reader must present three real source documents",
		);
	const openSettings = async (scope: string) => {
		click(`${scope} a[aria-label="全局设置"]`);
		await h.until(
			() =>
				route?.pathname === "/settings" &&
				!!h.container.querySelector("#settings-reading-return"),
			"Focused page must open standalone settings with its explicit return",
		);
	};
	const changeCategory = async () => {
		click('.settings-tabs a[href="/settings?section=appearance"]');
		await h.until(
			() => route?.search === "?section=appearance",
			"Settings category must navigate through its real Link",
		);
	};
	const dispose = await h.mount(
		<>
			<Navigator />
			<App />
		</>,
		"/",
		`/materials/${fixture.materialId}`,
		appRoutes,
	);
	try {
		await readyReader();
		assertReaderChrome(h);
		check(navigate, "Data router navigation must be available");
		navigate(`/materials/${fixture.materialId}`, {
			replace: true,
			state: { returnTo: { to: sourceTo, label: "原来源" } },
		});
		await h.until(
			() => !!h.container.querySelector('a[aria-label="返回原来源"]'),
			"Reader must resolve its explicit catalog parent",
		);
		const originalFrames = frames();
		const documents = originalFrames.map((frame) => frame.contentDocument);
		const assertReaderIdentity = (message: string) =>
			check(
				originalFrames.every(
					(frame, index) =>
						frame.isConnected && frame.contentDocument === documents[index],
				),
				message,
			);
		check(
			find<HTMLAnchorElement>('.reader-r1 a[href="/"]').getAttribute("href") ===
				"/",
			"Reader Home must target the canonical index route",
		);
		await openSettings(".reader-r1");
		check(
			find<HTMLElement>(".settings-reading-notice-context").textContent ===
				"刚才在读" &&
				find<HTMLElement>(".settings-reading-notice-title").textContent ===
					`《${fixture.book.title}》`,
			"Reader notice must describe the last reading context and preserve the full book name",
		);
		check(
			find<HTMLAnchorElement>("#settings-reading-return").textContent?.includes(
				"继续阅读",
			),
			"Reader settings must return directly to reading",
		);
		await changeCategory();
		click("#settings-reading-return");
		await readyReader();
		assertReaderIdentity(
			"Reader settings category round trip must preserve iframe and Document identities",
		);
		click('button[aria-label="本章记录"]');
		await h.until(
			() =>
				!!h.container.querySelector(
					'.reader-study-preview-candidates button[data-segment-id="saved"]',
				),
			"Chapter records must expose the saved segment",
		);
		click('.reader-study-preview-candidates button[data-segment-id="saved"]');
		await h.until(
			() => !!h.container.querySelector(".reader-study-preview-open"),
			"Saved segment must expose its actual open action",
		);
		click(".reader-study-preview-open");
		await h.until(
			() => !!h.container.querySelector(".analysis-document"),
			"Actual reader action must open selected Segment explanation",
		);
		check(
			route?.pathname === "/segments/saved" &&
				new URLSearchParams(route.search).get("analysis") === analysis.id &&
				new URLSearchParams(route.search).get("revision") ===
					analysis.revision_id,
			"Segment URL must preserve the selected explanation and revision",
		);
		assertSegmentTools(h);
		const reading = find<HTMLElement>(".segment-reader");
		const article = find<HTMLElement>(".segment-reader .analysis-document");
		reading.scrollTop = 400;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		check(
			reading.scrollTop > 200,
			"Long explanation must start scrolled away from the top",
		);

		click("#segment-discussion-toggle");
		await h.until(
			() => !!h.container.querySelector(".chat-thread"),
			"Existing discussion must load",
		);
		click(".chat-thread");
		await h.until(
			() => !!h.container.querySelector("#chat-question"),
			"Discussion composer must open on the Segment route",
		);
		const composer = find<HTMLTextAreaElement>("#chat-question");
		const draft = "尚未发送，设置往返后仍应留在当前片段的讨论草稿。";
		h.inputValue(composer, draft);
		await h.until(
			() => composer.value === draft,
			"Discussion draft must settle before settings navigation",
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		reading.scrollTop = 400;
		const scrollTop = reading.scrollTop;
		navigate(`${route?.pathname}${route?.search}#navigation-anchor`, {
			replace: true,
			state: route?.state,
		});
		await h.until(
			() => route?.hash === "#navigation-anchor",
			"Segment route must retain an explicit reading anchor before settings navigation",
		);
		const segmentTo = `${route?.pathname}${route?.search}${route?.hash}`;
		check(
			find<HTMLAnchorElement>('.segment-tools a[href="/"]').getAttribute(
				"href",
			) === "/",
			"Segment Home must target the canonical index route",
		);
		check(
			client,
			"Metadata regression must share the actual learning-page query cache",
		);
		await h.until(
			() =>
				Boolean(client?.getQueryData(["source", "source"])) &&
				Boolean(
					client?.getQueryData(["segments", "saved", "material-provenance"]),
				),
			"Source and reliable material identity must be cached before entering settings",
		);
		const metadataPaths = new Set([
			"/api/segments/saved",
			"/api/sources/source",
			"/api/segments/saved/material-provenance",
		]);
		const metadataReads = () =>
			requests.filter(({ path }) => metadataPaths.has(path)).length;
		const cachedReads = metadataReads();
		await openSettings(".segment-tools");
		await h.until(
			() =>
				h.container.querySelector(".settings-reading-notice-source")
					?.textContent === `来源：Source · 《${fixture.book.title}》`,
			"Segment notice must combine its actual source with the verified material title",
		);
		check(
			find<HTMLElement>(".settings-reading-notice-context").textContent ===
				"刚才在看" &&
				find<HTMLElement>(".settings-reading-notice-excerpt").textContent ===
					`「${fixture.targetText}」` &&
				find<HTMLElement>(".settings-reading-notice-excerpt").title ===
					fixture.targetText,
			"Segment notice must show the actual original excerpt and preserve its full text",
		);
		check(
			find<HTMLAnchorElement>(
				".settings-reading-notice-action",
			).textContent?.trim() === "返回片段 →" &&
				find<HTMLAnchorElement>(".settings-reading-notice-action").getAttribute(
					"href",
				) === segmentTo,
			"Segment notice action must consistently return to the Segment URL",
		);
		assertSegmentNoticeLayout(h);
		check(
			metadataReads() === cachedReads,
			"Settings must reuse cached Segment, Source and verified provenance without extra reads",
		);
		const back = find<HTMLAnchorElement>("#settings-reading-return");
		check(
			back.getAttribute("href") === segmentTo &&
				back.textContent?.includes("返回片段"),
			"Settings opened from Segment must return to its full URL, rather than jumping to the parent reader",
		);
		check(
			composer.isConnected &&
				!composer.getClientRects().length &&
				!reading.getClientRects().length,
			"Settings must conceal the retained Segment and composer",
		);
		assertReaderIdentity(
			"Reader must remain retained while its Segment opens settings",
		);
		click('.settings-reading-notice-close[aria-label="关闭片段返回提示"]');
		await h.until(
			() => !h.container.querySelector(".settings-reading-notice"),
			"Dismissing the Segment notice must hide its presentation",
		);
		check(
			document.activeElement === back,
			"Dismissing the Segment notice must focus its persistent header return",
		);
		await changeCategory();
		check(
			!h.container.querySelector(".settings-reading-notice") &&
				metadataReads() === cachedReads,
			"Dismissed Segment notice must stay dismissed across categories without fetching metadata again",
		);
		check(
			find<HTMLAnchorElement>("#settings-reading-return").getAttribute(
				"href",
			) === segmentTo,
			"Changing settings category must preserve the direct Segment return",
		);
		click("#settings-reading-return");
		await h.until(
			() =>
				route?.pathname === "/segments/saved" &&
				!!composer.getClientRects().length,
			"Settings must resume the existing Segment discussion",
		);
		check(
			`${route?.pathname}${route?.search}${route?.hash}` === segmentTo,
			"Settings round trip must preserve Segment query and hash",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question") === composer &&
				composer.value === draft &&
				find<HTMLElement>(".segment-reader .analysis-document") === article,
			"Settings round trip must preserve draft, composer and selected explanation DOM",
		);
		await h.until(
			() =>
				!!reading.getClientRects().length &&
				Math.abs(reading.scrollTop - scrollTop) < 2,
			`Settings round trip must restore the exact Segment reading scroll (before=${scrollTop}, current=${reading.scrollTop})`,
		);
		await openSettings(".segment-tools");
		await h.until(
			() => !!h.container.querySelector(".settings-reading-notice-excerpt"),
			"A new Segment settings trip must show a fresh contextual notice",
		);
		check(
			find<HTMLAnchorElement>(".settings-reading-notice-action").getAttribute(
				"href",
			) === segmentTo,
			"Fresh notice must preserve the exact Segment return URL",
		);
		failSegment = true;
		segmentGate = new Promise<void>((resolve) => {
			releaseSegment = resolve;
		});
		const readsBeforeRetry = requests.filter(
			({ path }) => path === "/api/segments/saved",
		).length;
		click(".settings-reading-notice-action");
		await h.until(
			() =>
				requests.filter(({ path }) => path === "/api/segments/saved").length >
					readsBeforeRetry &&
				!!h.container.querySelector('.segment-page-state[role="status"]'),
			"Returning from settings must revalidate Segment before presenting saved content",
		);
		check(
			composer.isConnected &&
				article.isConnected &&
				!composer.getClientRects().length &&
				!reading.getClientRects().length,
			"Pending Segment revalidation must conceal retained content without losing the draft",
		);
		check(releaseSegment, "Revalidation fixture must expose its response gate");
		releaseSegment();
		segmentGate = undefined;
		await h.until(
			() =>
				!!h.container.querySelector('.segment-page-state[role="alert"] button'),
			"Failed return revalidation must offer a real retry action",
		);
		check(
			composer.isConnected &&
				composer.value === draft &&
				article.isConnected &&
				!reading.getClientRects().length,
			"Failed revalidation must retain the draft and explanation while concealing stale content",
		);
		failSegment = false;
		click('.segment-page-state[role="alert"] button');
		await h.until(
			() =>
				!!composer.getClientRects().length &&
				!h.container.querySelector('.segment-page-state[role="alert"]'),
			"Retry must resume the retained Segment after successful validation",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question") === composer &&
				composer.value === draft &&
				find<HTMLElement>(".segment-reader .analysis-document") === article &&
				Math.abs(reading.scrollTop - scrollTop) < 2,
			"Successful revalidation retry must preserve composer, draft, selected explanation and scroll",
		);
		click("#segment-discussion-toggle");
		const segmentBack = find<HTMLAnchorElement>(
			'.segment-tools a[href^="/materials/"]',
		);
		check(
			segmentBack.getAttribute("href") ===
				`/materials/${fixture.materialId}?segment=saved`,
			"Segment settings return must retain its original reader parent",
		);
		segmentBack.click();
		await readyReader();
		assertReaderIdentity(
			"Reader→Segment→settings→Segment→reader must preserve all source documents",
		);
		check(
			find<HTMLAnchorElement>('a[aria-label="返回原来源"]').getAttribute(
				"href",
			) === sourceTo,
			"Full return chain must preserve the reader's original source URL",
		);

		// A different Segment replaces the sole retained Segment, even while the reader is paused.
		navigate(segmentTo, {
			state: {
				returnTo: {
					to: `/materials/${fixture.materialId}`,
					label: "阅读",
					parent: { to: sourceTo, label: "原来源" },
				},
			},
		});
		await h.until(
			() => !!h.container.querySelector(".segment-workspace"),
			"Segment must reopen after leaving its temporary settings range",
		);
		await h.until(
			() => !!h.container.querySelector("#chat-question"),
			"Fresh Segment must reopen its URL-selected composer",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question").value === "",
			"Leaving the Segment/settings range must release its unsent session draft",
		);
		h.inputValue(
			find<HTMLTextAreaElement>("#chat-question"),
			"旧片段草稿不可泄漏",
		);
		const replacedComposer = find<HTMLTextAreaElement>("#chat-question");
		navigate("/segments/other?thread=other-thread&chat=1");
		await h.until(
			() =>
				!!h.container.querySelector("#chat-question") &&
				!replacedComposer.isConnected,
			"Switching Segment must dispose the previous composer",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question").value === "" &&
				!article.isConnected,
			"Another Segment must not inherit the previous draft or selected explanation",
		);
		click('.segment-tools a[href="/"]');
		await h.until(
			() =>
				route?.pathname === "/materials" &&
				new URLSearchParams(route.search).get("type") === "book" &&
				!!h.container.querySelector(".catalog-body"),
			"Segment Home must resolve the canonical index redirect to the book material catalog",
		);
		check(
			originalFrames.every((frame) => !frame.isConnected) &&
				!replacedComposer.isConnected,
			"Home must release paused reader frames and Segment session",
		);
		navigate(`/materials/${fixture.materialId}`);
		await readyReader();
		check(
			frames().every((frame, index) => frame !== originalFrames[index]),
			"Reopening after Home must create fresh reader frames",
		);
		click('.reader-r1 a[href="/"]');
		await h.until(
			() =>
				route?.pathname === "/materials" &&
				new URLSearchParams(route.search).get("type") === "book",
			"Reader Home must also land on the canonical material catalog",
		);
		check(client, "Fixture must share the real query cache");
		client.removeQueries({ queryKey: ["segment", "saved"], exact: true });
		check(
			client.getQueryData(["segment", "saved"]) === undefined,
			"Cold pending regression must not reuse cached Segment data",
		);
		// An initial GET may still be in flight when the always-available settings link is used.
		const staleReadIndex = requests.filter(
			({ path }) => path === "/api/segments/saved",
		).length;
		staleRead = new Promise<Response>((resolve) => {
			releaseStaleRead = resolve;
		});
		navigate(
			`/segments/saved?analysis=${analysis.id}&revision=${analysis.revision_id}&thread=thread&chat=1`,
		);
		await h.until(
			() =>
				requests.filter(({ path }) => path === "/api/segments/saved").length >
					staleReadIndex &&
				!!h.container.querySelector('.segment-tools a[aria-label="全局设置"]'),
			"Initial Segment read must remain pending while its settings entry is available",
		);
		await openSettings(".segment-tools");
		check(
			find<HTMLElement>(".settings-reading-notice-context").textContent ===
				"刚才在看" &&
				find<HTMLElement>(".settings-reading-notice-excerpt").textContent ===
					"学习片段" &&
				find<HTMLElement>(".settings-reading-notice-source").textContent ===
					"正在读取来源…",
			"Pending Segment metadata must show readable placeholders while keeping return available",
		);
		deletedSegment = true;
		const freshReadIndex = requests.filter(
			({ path }) => path === "/api/segments/saved",
		).length;
		click("#settings-reading-return");
		await h.until(
			() =>
				requests.filter(({ path }) => path === "/api/segments/saved").length >
					freshReadIndex &&
				h.container
					.querySelector('.segment-page-state[role="alert"]')
					?.textContent?.includes("找不到这条记录") === true,
			"Return must start a fresh GET and honor deletion while the old initial GET is still unresolved",
		);
		check(releaseStaleRead, "Test must control the obsolete Segment response");
		releaseStaleRead(
			Response.json(readerSessionFixtureData("/api/segments/saved")),
		);
		staleRead = undefined;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		check(
			route?.pathname === "/segments/saved" &&
				!h.container.querySelector(".segment-reader .analysis-document") &&
				!h.container.querySelector("#chat-question") &&
				h.container
					.querySelector('.segment-page-state[role="alert"]')
					?.textContent?.includes("找不到这条记录"),
			"Late obsolete response must not reveal deleted Segment content, start a model or change the return URL",
		);
		deletedSegment = false;
		navigate("/");
		await h.until(
			() => route?.pathname === "/materials",
			"Deleted Segment regression must release its failed session before preview",
		);
		if (capture) {
			navigate(
				params.get("scene") === "reader"
					? `/materials/${fixture.materialId}`
					: `/segments/saved?analysis=${analysis.id}&revision=${analysis.revision_id}&chat=0`,
				{
					state:
						params.get("scene") === "reader"
							? { returnTo: { to: sourceTo, label: "原来源" } }
							: {
									returnTo: {
										to: `/materials/${fixture.materialId}?segment=saved`,
										label: fixture.book.title,
										parent: { to: sourceTo, label: "原来源" },
									},
								},
				},
			);
			if (params.get("scene") === "reader") await readyReader();
			else
				await h.until(
					() =>
						!!h.container.querySelector(".segment-reader .analysis-document"),
					"Capture must show the focused Segment page",
				);
			check(
				document.documentElement.scrollWidth <= innerWidth + 1,
				"Focused navigation must fit the viewport without horizontal overflow",
			);
		}
		return `focused navigation ${innerWidth}px: real App/DataRouter; reader and Segment Home reach book catalog; direct settings/category returns preserve full Segment URL, discussion draft, explanation, scroll, gated revalidation/retry, reader iframe/Document identities and original source parent; replacement/Home evict sessions; cold pending GET cannot override fresh return 404; no model or content writes`;
	} finally {
		releaseSegment?.();
		releaseStaleRead?.(
			Response.json(readerSessionFixtureData("/api/segments/saved")),
		);
		if (!capture) dispose();
	}
}

function assertSegmentNoticeLayout(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const notice = h.container.querySelector<HTMLElement>(
		".settings-reading-notice",
	);
	const excerpt = notice?.querySelector<HTMLElement>(
		".settings-reading-notice-excerpt",
	);
	const source = notice?.querySelector<HTMLElement>(
		".settings-reading-notice-source",
	);
	check(
		notice && excerpt && source,
		"Segment notice must expose excerpt and source identity",
	);
	const excerptStyle = getComputedStyle(excerpt);
	const sourceStyle = getComputedStyle(source);
	check(
		excerptStyle.getPropertyValue("-webkit-line-clamp") === "2" &&
			excerptStyle.overflow === "hidden" &&
			excerpt.getBoundingClientRect().height <=
				Number.parseFloat(excerptStyle.lineHeight) * 2 + 1,
		"Segment excerpt must preserve its text while occupying at most two rendered lines",
	);
	check(
		sourceStyle.whiteSpace === "nowrap" &&
			sourceStyle.textOverflow === "ellipsis" &&
			sourceStyle.overflow === "hidden" &&
			source.getBoundingClientRect().height <=
				Number.parseFloat(sourceStyle.lineHeight) + 1,
		"Segment attribution must occupy one line with ellipsis",
	);
	const bounds = notice.getBoundingClientRect();
	check(
		bounds.left >= 0 &&
			bounds.right <= innerWidth &&
			bounds.top >= 0 &&
			bounds.bottom <= innerHeight &&
			notice.scrollWidth <= notice.clientWidth + 1,
		"Segment notice must fit the actual viewport without horizontal overflow",
	);
	const page = h.container.querySelector<HTMLElement>(
		".settings-page > .page-content",
	);
	check(
		page &&
			Number.parseFloat(getComputedStyle(page).paddingBottom) >=
				bounds.height + 24,
		"Settings controls must scroll clear of the full Segment return notice",
	);
}

/** Prepared optional scenes: ?suite=focused-navigation&notice-metadata=failed|long. */
async function segmentNoticeMetadata(
	h: BrowserHarness,
	scene: "failed" | "long",
) {
	const { App, appRoutes } = await import("../src/App");
	const check: BrowserHarness["check"] = h.check;
	const capture = new URLSearchParams(location.search).has("capture");
	// Keep the harness output from displacing the full-height application surface.
	document.querySelector<HTMLElement>("#result")?.setAttribute("hidden", "");
	let client: ReturnType<typeof useQueryClient> | undefined;
	let navigate: ReturnType<typeof useNavigate> | undefined;
	const segmentTo = "/segments/notice?chat=0#original-context";
	const text = `  ${"𠮷野の長い原文をそのまま保存し、設定から戻る場所を確かめる。\n".repeat(18)}  `;
	const normalizedText = text.trim().replace(/\s+/gu, " ");
	const excerpt = `${Array.from(normalizedText).slice(0, 120).join("")}…`;
	const sourceTitle = "長い来源名：日语原版内容与个人学习资料的完整出处".repeat(
		5,
	);
	const segment: Schema["SegmentResponse"] = {
		...(readerSessionFixtureData(
			"/api/segments/saved",
		) as Schema["SegmentResponse"]),
		id: "notice",
		text,
		material_provenance: null,
	};
	let route: Location | undefined;
	let allowReturn = false;
	const requests: string[] = [];
	function Navigator() {
		client = useQueryClient();
		const go = useNavigate();
		const current = useLocation();
		useEffect(() => {
			route = current;
			navigate = go;
		}, [current, go]);
		return null;
	}
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		check(
			request.method === "GET",
			`Return metadata must be read-only: ${request.method} ${path}`,
		);
		requests.push(path);
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/settings/context-copy")
			return Response.json(defaultContextCopySettings);
		if (path === "/api/segments/notice")
			return scene === "failed" && !allowReturn
				? Response.json({ detail: "片段元信息暂不可读" }, { status: 503 })
				: Response.json(segment);
		if (path === "/api/sources/source")
			return Response.json({
				...(readerSessionFixtureData(path) as Schema["SourceResponse"]),
				title: sourceTitle,
			});
		if (
			path === "/api/segments/notice/analyses" ||
			path === "/api/segments/notice/translation-results"
		)
			return Response.json([]);
		throw new Error(
			`Unexpected notice metadata request ${request.method} ${path}`,
		);
	});
	const dispose = await h.mount(
		<>
			<Navigator />
			<App />
		</>,
		"/",
		"/sources/source",
		appRoutes.map((item) =>
			item.path === "/sources/:id"
				? {
						...item,
						element: (
							<Link
								to="/settings?section=appearance"
								state={{
									returnTo: {
										to: segmentTo,
										label: "片段",
										parent: { to: sourceTo, label: "原来源" },
									},
								}}
							>
								设置元信息回归入口
							</Link>
						),
					}
				: item,
		),
	);
	try {
		await h.until(
			() =>
				!!h.container.querySelector('a[href="/settings?section=appearance"]'),
			"Metadata fixture must expose its actual settings entry",
		);
		h.container
			.querySelector<HTMLAnchorElement>(
				'a[href="/settings?section=appearance"]',
			)
			?.click();
		await h.until(
			() =>
				route?.pathname === "/settings" &&
				!!h.container.querySelector(".settings-reading-notice-excerpt"),
			"Explicit Segment settings must present optional contextual identity",
		);
		const noticeExcerpt = h.container.querySelector<HTMLElement>(
			".settings-reading-notice-excerpt",
		);
		const source = h.container.querySelector<HTMLElement>(
			".settings-reading-notice-source",
		);
		const back = h.container.querySelector<HTMLAnchorElement>(
			"#settings-reading-return",
		);
		const action = h.container.querySelector<HTMLAnchorElement>(
			".settings-reading-notice-action",
		);
		check(
			noticeExcerpt && source && back && action,
			"Metadata availability must never remove either Segment return link",
		);
		check(
			back.getAttribute("href") === segmentTo &&
				action.getAttribute("href") === segmentTo &&
				back.textContent?.includes("返回片段") &&
				action.textContent?.trim() === "返回片段 →",
			"Both actions must keep the explicit Segment URL regardless of metadata availability",
		);
		if (scene === "failed") {
			await h.until(
				() => source.textContent === "来源信息暂不可用",
				"Failed metadata must expose its fallback without replacing return actions",
			);
			check(
				noticeExcerpt.textContent === "学习片段",
				"Failed Segment metadata must retain a readable excerpt placeholder",
			);
		} else {
			await h.until(
				() => source.textContent === `来源：${sourceTitle}`,
				"Manual Segment attribution must preserve the actual source without inventing a material title",
			);
			check(
				noticeExcerpt.textContent === `「${excerpt}」` &&
					noticeExcerpt.title === excerpt &&
					source.title === `来源：${sourceTitle}`,
				"Long identity must limit the normalized excerpt and its title to 120 Unicode code points plus ellipsis while retaining the full source title",
			);
			assertSegmentNoticeLayout(h);
			check(
				!requests.some((path) => path.endsWith("/material-provenance")),
				"A manual Segment must not fetch provenance to invent a material title",
			);
		}
		assertSegmentNoticeLayout(h);
		allowReturn = true;
		action.click();
		await h.until(
			() =>
				route?.pathname === "/segments/notice" &&
				route.search === "?chat=0" &&
				route.hash === "#original-context" &&
				!!h.container.querySelector(".segment-workspace"),
			"Optional identity failure or long content must not block returning to the actual Segment route",
		);
		if (capture) {
			check(
				navigate && client,
				"Metadata capture must use the actual router and query cache",
			);
			navigate("/sources/source");
			await h.until(
				() =>
					route?.pathname === "/sources/source" &&
					!!h.container.querySelector('a[href="/settings?section=appearance"]'),
				"Metadata capture must release the Segment before restoring its notice",
			);
			client.removeQueries({ queryKey: ["segment", "notice"], exact: true });
			allowReturn = false;
			h.container
				.querySelector<HTMLAnchorElement>(
					'a[href="/settings?section=appearance"]',
				)
				?.click();
			await h.until(
				() =>
					h.container.querySelector(".settings-reading-notice-source")
						?.textContent ===
					(scene === "failed" ? "来源信息暂不可用" : `来源：${sourceTitle}`),
				"Metadata capture must show the final failed or long return notice",
			);
			assertSegmentNoticeLayout(h);
		}
		return `Segment notice metadata ${scene}: exact return URL; read-only identity; fallback or bounded two-line excerpt and full manual-source metadata`;
	} finally {
		if (!capture) dispose();
	}
}

function assertSegmentTools(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const tools = [
		...h.container.querySelectorAll<HTMLElement>(
			".segment-tools .segment-tool",
		),
	];
	const [home, back, discussion, more, settingsLink] = tools;
	check(
		tools.length === 5 &&
			home instanceof HTMLAnchorElement &&
			home.getAttribute("href") === "/" &&
			back instanceof HTMLAnchorElement &&
			back.getAttribute("aria-label")?.startsWith("返回") &&
			discussion?.id === "segment-discussion-toggle" &&
			more?.id === "segment-more-trigger" &&
			settingsLink?.getAttribute("aria-label") === "全局设置",
		"Segment controls must keep Home, return, discussion, more and global settings in their intended order",
	);
	check(
		tools.every((node) => !!node.querySelector('svg[aria-hidden="true"]')),
		"Each Segment control must retain its decorative SVG icon and accessible control label",
	);
	const bounds = tools.map((node) => node.getBoundingClientRect());
	const horizontal =
		getComputedStyle(home.parentElement as Element).flexDirection === "row";
	const gaps = bounds
		.slice(1)
		.map((rect, index) =>
			horizontal
				? rect.left - (bounds[index]?.right ?? 0)
				: rect.top - (bounds[index]?.bottom ?? 0),
		);
	check(
		gaps.every((gap) => gap >= -0.5) &&
			gaps[0] !== undefined &&
			gaps[1] !== undefined &&
			gaps[2] !== undefined &&
			gaps[3] !== undefined &&
			Math.max(gaps[0], gaps[3]) < Math.min(gaps[1], gaps[2]),
		"Home/return and more/settings must form closer groups around the separate discussion control without overlaps",
	);
	check(
		bounds.every(
			(rect) =>
				rect.left >= 0 &&
				rect.right <= innerWidth &&
				rect.top >= 0 &&
				rect.bottom <= innerHeight,
		),
		`All Segment controls must remain within the viewport: ${JSON.stringify(bounds.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })))}`,
	);
}

function assertReaderChrome(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const navigation = h.container.querySelector(".reader-heading-navigation");
	const home =
		navigation?.querySelector<HTMLAnchorElement>(".reader-home-link");
	const divider = navigation?.querySelector(".reader-navigation-divider");
	const back = navigation?.querySelector<HTMLAnchorElement>(
		".reader-return-link",
	);
	check(
		home &&
			divider &&
			back &&
			home.nextElementSibling === divider &&
			divider.nextElementSibling === back &&
			divider.getAttribute("aria-hidden") === "true" &&
			!!back.querySelector('svg[aria-hidden="true"]') &&
			back.textContent?.trim().startsWith("返回"),
		"Reader navigation must retain Home, decorative separator, SVG back control and explicit return text",
	);
	const actions = [
		...h.container.querySelectorAll<HTMLElement>(
			".reader-heading-actions > button, .reader-heading-actions > a",
		),
	];
	check(
		actions.map((node) => node.getAttribute("aria-label")).join("|") ===
			"本章记录|书籍信息|全局设置",
		"Reader actions must keep chapter records, book information and global settings in order",
	);
	const bounds = actions.map((node) => node.getBoundingClientRect());
	check(
		bounds.every(
			(rect, index) =>
				rect.width > 0 &&
				rect.left >= 0 &&
				rect.right <= innerWidth &&
				(index === 0 || rect.left >= (bounds[index - 1]?.right ?? 0) - 0.5),
		),
		"Reader actions must remain visible and separate at desktop and narrow widths",
	);
}
