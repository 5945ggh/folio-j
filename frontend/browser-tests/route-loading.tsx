import { type ComponentType, lazy } from "react";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { readerSession } from "./reader-session";
import { materialSegment } from "./segment-materials";
import { makeThread, provider, settings } from "./workbench";

type Schema = components["schemas"];

async function pageBoundaryFallbacks(h: BrowserHarness) {
	const { PageBoundary } = await import("../src/navigation/PageBoundary");
	const check: BrowserHarness["check"] = h.check;
	let release: (() => void) | undefined;
	const PendingPage = lazy(
		() =>
			new Promise<{ default: ComponentType }>((resolve) => {
				release = () =>
					resolve({ default: () => <p data-loaded-page="">延迟页面已加载</p> });
			}),
	);
	let dispose = await h.mount(
		<PageBoundary>
			<PendingPage />
		</PageBoundary>,
	);
	try {
		await h.until(
			() => !!h.container.querySelector('.loading[role="status"]'),
			"PageBoundary must show loading while the lazy module is unresolved",
		);
		check(
			!h.container.querySelector("[data-loaded-page]"),
			"Pending page must not appear before resolution",
		);
		check(release, "Lazy module must expose its controlled resolution");
		release();
		await h.until(
			() =>
				!!h.container.querySelector("[data-loaded-page]") &&
				!h.container.querySelector('.loading[role="status"]'),
			"Resolving the lazy module must replace loading with the page",
		);
	} finally {
		dispose();
	}
	let fail: (() => void) | undefined;
	const FailedPage = lazy(
		() =>
			new Promise<{ default: ComponentType }>((_resolve, reject) => {
				fail = () => reject(new Error("Offline lazy-module failure"));
			}),
	);
	dispose = await h.mount(
		<PageBoundary>
			<FailedPage />
		</PageBoundary>,
	);
	try {
		await h.until(
			() => !!h.container.querySelector('.loading[role="status"]'),
			"A second lazy module must begin in its loading state",
		);
		check(fail, "Lazy module must expose its controlled rejection");
		fail();
		await h.until(
			() => !!h.container.querySelector('[role="alert"]'),
			"Rejecting a lazy module must display the PageBoundary error",
		);
		const alert = h.container.querySelector('[role="alert"]');
		const reload = alert?.querySelector<HTMLButtonElement>("button");
		check(
			alert?.textContent?.includes("页面暂时无法打开") &&
				reload?.textContent?.trim() === "重新加载" &&
				!reload.disabled,
			"PageBoundary must offer its generic error and enabled reload action",
		);
	} finally {
		dispose();
	}
}

/** Exercise the product route tree, including lazy boundaries, with offline APIs. */
export async function routeLoading(h: BrowserHarness) {
	// Start at the actual trailing-slash URL and switch both forms without rebuilding frames.
	const readerResult = await readerSession(h, true, true);
	// main.tsx installs fetch before importing this product route tree.
	const { App, appRoutes } = await import("../src/App");
	const check: BrowserHarness["check"] = h.check;
	const find = <T extends Element>(selector: string): T => {
		const element = h.container.querySelector<T>(selector);
		check(element, `Missing ${selector}`);
		return element;
	};
	const click = (selector: string) => find<HTMLElement>(selector).click();
	const clickButton = (label: string) => {
		const button = [
			...document.querySelectorAll<HTMLButtonElement>(
				".settings-leave-dialog button",
			),
		].find((item) => item.textContent?.trim() === label);
		check(button && !button.disabled, `Missing enabled button ${label}`);
		button.click();
	};
	const mockedReads: string[] = [];
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		check(
			request.method === "GET",
			`Unexpected write ${request.method} ${path}`,
		);
		mockedReads.push(path);
		if (path === "/api/settings") return Response.json(settings);
		if (path === "/api/providers") return Response.json([provider]);
		if (path === "/api/sources") return Response.json([]);
		if (path === "/api/materials")
			return Response.json({ items: [], page: 1, page_size: 50, total: 0 });
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "离线路由来源",
				description: "",
				note: "",
				segment_count: 1,
				created_at: materialSegment.created_at,
				updated_at: materialSegment.updated_at,
			} satisfies Schema["SourceResponse"]);
		if (path === "/api/segments/segment")
			return Response.json({ ...materialSegment, material_provenance: null });
		if (
			path === "/api/segments/segment/analyses" ||
			path === "/api/segments/segment/translation-results"
		)
			return Response.json([]);
		if (path === "/api/segments/segment/threads")
			return Response.json({ items: [makeThread()], next_cursor: null });
		if (path === "/api/threads/thread") return Response.json(makeThread());
		if (path === "/api/threads/thread/messages")
			return Response.json({ items: [], next_cursor: null });
		if (path === "/api/settings/segment-context")
			return Response.json({
				enabled: true,
				before_sentences: 3,
				after_sentences: 3,
				before_characters: 200,
				after_characters: 200,
				revision: 0,
			} satisfies Schema["SegmentContextSettingsResponse"]);
		throw new Error(`Unmocked route regression ${request.method} ${path}`);
	});
	localStorage.clear();
	let dispose = await h.mount(
		<App />,
		"/",
		"/segments/segment?thread=thread&chat=1",
		appRoutes,
	);
	try {
		await h.until(
			() => !!h.container.querySelector("#chat-question"),
			"The actual Segment route must open the discussion composer",
		);
		const composer = find<HTMLTextAreaElement>("#chat-question");
		const draft = "隐藏再打开后保留的讨论草稿";
		h.inputValue(composer, draft);
		await h.until(
			() => composer.value === draft,
			"Discussion must receive the draft",
		);
		click('button[aria-label="收起讨论"], button[aria-label="返回阅读"]');
		await h.until(
			() => !!h.container.querySelector(".segment-shell.conversation-closed"),
			"Hiding discussion must return to Segment reading",
		);
		click("#segment-discussion-toggle");
		await h.until(
			() =>
				!h.container.querySelector(".segment-shell.conversation-closed") &&
				!!h.container.querySelector("#chat-question"),
			"Discussion must reopen through its actual route toggle",
		);
		check(
			find<HTMLTextAreaElement>("#chat-question").value === draft,
			"Opening, hiding and reopening discussion lost its unsent draft",
		);
	} finally {
		dispose();
	}

	dispose = await h.mount(
		<App />,
		"/",
		"/settings?section=learning",
		appRoutes,
	);
	try {
		await h.until(
			() => !!h.container.querySelector("#learning-settings-form textarea"),
			"The actual settings route must load the learning form",
		);
		const field = find<HTMLTextAreaElement>("#learning-settings-form textarea");
		const draft = "尚未保存的学习背景草稿";
		h.inputValue(field, draft);
		await h.until(
			() => h.container.textContent?.includes("有未保存的修改") === true,
			"Settings must register its unsaved draft before leaving",
		);
		click('.app-navigation a[href="/materials"]');
		await h.until(
			() => !!document.querySelector("#settings-leave-title"),
			"Leaving settings with a draft must show the product navigation guard",
		);
		check(
			field.isConnected && field.value === draft,
			"Blocked navigation must keep the current settings form and draft",
		);
		clickButton("继续编辑");
		await h.until(
			() => !document.querySelector("#settings-leave-title"),
			"Cancelling navigation must dismiss the guard",
		);
		check(
			field.isConnected && field.value === draft,
			"Cancelling navigation must preserve the unsaved settings draft",
		);
		click('.settings-tabs a[href="/settings?section=permissions"]');
		await h.until(
			() => !!document.querySelector("#settings-leave-title"),
			"Switching settings categories with the same pathname must still guard the draft",
		);
		clickButton("继续编辑");
		await h.until(
			() => !document.querySelector("#settings-leave-title"),
			"Cancelling a category change must dismiss the guard",
		);
		check(
			find<HTMLTextAreaElement>("#learning-settings-form textarea") === field &&
				field.value === draft,
			"Cancelling a query-only category change must preserve the same field node and draft",
		);
		click('.app-navigation a[href="/materials"]');
		await h.until(
			() => !!document.querySelector("#settings-leave-title"),
			"A second leave attempt must still require a decision",
		);
		clickButton("放弃修改");
		await h.until(
			() =>
				!h.container.querySelector(".settings-page") &&
				h.container.querySelector(".catalog-body") !== null,
			"Confirming departure must finish navigation to the material catalog",
		);
		check(
			mockedReads.includes("/api/materials"),
			"Catalog destination must load after confirmed departure",
		);
	} finally {
		dispose();
	}
	await pageBoundaryFallbacks(h);
	return `${readerResult}\nactual App routes: discussion draft survives hide/reopen; settings draft guards path and query changes, survives cancellation, and leaves on confirmation; PageBoundary lazy loading, resolution and rejection recovery controls`;
}
