import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "react-router";
import type { components } from "../src/api/schema";
import type { Source } from "../src/content";
import { type BrowserHarness, readGate } from "./harness";
import { overviewItems, showsOverview } from "./source-overview-fixture";
import "../src/catalog/source-content.css";
import "../src/catalog/sources-s2.css";

const source: Source = {
	id: "delete-source",
	title: "削除する出典",
	description: "",
	note: "",
	segment_count: 3,
	created_at: "2026-11-01T00:00:00Z",
	updated_at: "2026-11-01T00:00:00Z",
};
const other: Source = { ...source, id: "remaining-source", title: "残る出典" };

export async function sourceDeletion(h: BrowserHarness, preview = false) {
	const { SourceDetail, SourceIndex } = await import("../src/SourcePages");
	const { SegmentSessionHost } = await import(
		"../src/segments/SegmentSessionHost"
	);
	const { BookDetailsPage } = await import("../src/catalog/BookDetailsPage");
	const { catalogBooks, catalogKeys } = await import("../src/catalog/api");
	const { container, mock, mount, until } = h;
	const check: BrowserHarness["check"] = h.check;
	let removed = false,
		directoryReads = 0,
		materialReads = 0,
		deleteRequests = 0,
		impactReads = 0;
	let releaseDelete: ((response: Response) => void) | undefined;
	let queryClient: QueryClient | undefined;
	const refreshed = overviewItems(other.id, "削除後");
	const deleted = overviewItems(source.id, "削除前");
	const kept = overviewItems(other.id, "保存済");
	let navigate!: ReturnType<typeof useNavigate>;
	let impactGate: Promise<void> | undefined;
	const returnRead = readGate();
	const overviewReads = { analyses: 0, segments: 0, materials: 0 };
	const impact: components["schemas"]["SourceDeleteImpact"] = {
		source_id: source.id,
		title: source.title,
		material_count: 2,
		segment_count: 3,
		analysis_count: 4,
		thread_count: 5,
		message_count: 6,
		active_job_count: 1,
	};
	mock(async (request) => {
		const url = new URL(request.url),
			path = url.pathname;
		for (const { segment, book } of [deleted, kept]) {
			if (
				path === `/api/segments/${segment.id}` ||
				path === `/api/materials/${book.id}/details`
			) {
				if (removed) await returnRead.promise;
				if (removed && segment.source_id === source.id)
					return Response.json({ detail: "已删除" }, { status: 404 });
				return Response.json(
					path.includes("/segments/")
						? segment
						: { ...book, chapter_count: 1, original_title: book.title },
				);
			}
			if (
				path === `/api/segments/${segment.id}/analyses` ||
				path === `/api/segments/${segment.id}/translation-results`
			)
				return Response.json([]);
			if (path === `/api/materials/${book.id}/statistics`)
				return Response.json({ detail: "统计暂不可用" }, { status: 503 });
		}
		if (request.method === "GET" && path === "/api/catalog/sources") {
			directoryReads++;
			const items = (removed ? [other] : [source, other]).map((item) => ({
				...item,
				material_count: item.id === source.id ? 2 : 0,
				analysis_count: 4,
			}));
			return Response.json({
				items,
				total: items.length,
				page: 1,
				page_size: 50,
			});
		}
		if (request.method === "GET" && path === "/api/sources")
			return Response.json(removed ? [other] : [source, other]);
		if (
			request.method === "GET" &&
			path === `/api/sources/${source.id}/delete-impact`
		) {
			impactReads++;
			await impactGate;
			return Response.json({ ...impact });
		}
		if (request.method === "GET" && path === `/api/sources/${source.id}`)
			return removed
				? Response.json({ detail: "来源不存在" }, { status: 404 })
				: Response.json(source);
		if (request.method === "GET" && path === `/api/sources/${other.id}`)
			return Response.json(other);
		if (request.method === "GET" && path === "/api/materials") {
			if (!url.searchParams.has("source_id")) materialReads++;
			if (url.searchParams.get("source_id") === other.id)
				overviewReads.materials++;
			const items =
				removed && url.searchParams.get("source_id") === other.id
					? [refreshed.book]
					: [];
			return Response.json({
				items,
				total: items.length,
				page: 1,
				page_size: 3,
			});
		}
		if (
			request.method === "GET" &&
			/\/catalog\/(segments|analyses)$/.test(path)
		) {
			if (path === `/api/sources/${other.id}/catalog/analyses`)
				overviewReads.analyses++;
			if (path === `/api/sources/${other.id}/catalog/segments`)
				overviewReads.segments++;
			const items =
				removed && path.startsWith(`/api/sources/${other.id}/`)
					? [
							path.endsWith("/segments")
								? refreshed.segment
								: refreshed.analysis,
						]
					: [];
			return Response.json({
				items,
				total: items.length,
				page: 1,
				page_size: 3,
			});
		}
		if (request.method === "DELETE" && path === `/api/sources/${source.id}`) {
			deleteRequests++;
			return new Promise<Response>((resolve) => {
				releaseDelete = resolve;
			});
		}
		throw new Error(
			`Unexpected source deletion request ${request.method} ${path}`,
		);
	});
	function Routes() {
		const location = useLocation();
		navigate = useNavigate();
		queryClient = useQueryClient();
		// An active material directory query must refresh after source deletion.
		useQuery({
			queryKey: catalogKeys.books({}),
			queryFn: () => catalogBooks({}),
		});
		return (
			<>
				<output data-test-path>{location.pathname}</output>
				<Outlet />
			</>
		);
	}
	function button(label: string, scope: ParentNode = container) {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				node.textContent?.trim() === label ||
				node.getAttribute("aria-label") === label,
		);
		check(found, `Missing source deletion action ${label}`);
		return found;
	}
	const dialog = () =>
		container.querySelector<HTMLDialogElement>(
			'dialog[open][aria-labelledby="delete-title"]',
		);
	function requiredDialog() {
		const found = dialog();
		check(found, "Source deletion confirmation must remain open");
		return found;
	}
	const browserKey = (
		window as Window & {
			browserKey?: (key: "Escape" | "Enter") => Promise<void>;
		}
	).browserKey;
	async function trustedClick(node: HTMLElement) {
		const pointer = (
			window as Window & {
				browserPointer?: (events: unknown[]) => Promise<void>;
			}
		).browserPointer;
		check(pointer, "Source deletion requires native pointer dispatch");
		const bounds = node.getBoundingClientRect();
		const x = bounds.left + bounds.width / 2;
		const y = bounds.top + bounds.height / 2;
		await pointer([
			{ type: "mouseMoved", x, y },
			{ type: "mousePressed", x, y, button: "left", clickCount: 1 },
			{ type: "mouseReleased", x, y, button: "left", clickCount: 1 },
		]);
	}
	async function cancelPending() {
		button("取消", requiredDialog()).click();
		check(dialog(), "Cancel must retain pending source deletion");
		// CloseWatcher cancellation requires trusted user activation; disabled
		// controls do not establish it, so click the dialog's visible heading.
		const heading = requiredDialog().querySelector<HTMLElement>("h2");
		check(heading, "Pending confirmation must retain its heading");
		await trustedClick(heading);
		check(browserKey, "Source deletion requires native Escape dispatch");
		const node = requiredDialog();
		let cancellable = false;
		node.addEventListener(
			"cancel",
			(event) => {
				cancellable = event.cancelable;
			},
			{ once: true },
		);
		await browserKey("Escape");
		check(
			cancellable,
			"Native Escape must exercise a cancellable user close request",
		);
		check(dialog(), "Cancel and Escape must retain pending source deletion");
	}
	localStorage.clear();
	sessionStorage.clear();
	const sourcePath = `/sources/${source.id}`;
	const history = [
		[`/segments/${kept.segment.id}`, kept.segment.text],
		[`/materials/${kept.book.id}/details`, kept.book.title],
		[`/segments/${deleted.segment.id}`, deleted.segment.text],
		[`/materials/${deleted.book.id}/details`, deleted.book.title],
	] as const;
	const dispose = await mount(
		<Routes />,
		"/",
		preview ? sourcePath : history[0][0],
		[
			{ path: "segments/:id", element: <SegmentSessionHost /> },
			{ path: "materials/:id/details", element: <BookDetailsPage /> },
			{ path: "sources", element: <SourceIndex /> },
			{ path: "sources/:id", element: <SourceDetail /> },
		],
	);
	try {
		if (!preview) {
			for (const [path, text] of history) {
				if (path !== history[0][0]) await navigate(path);
				await until(
					() => !!container.textContent?.includes(text),
					`Warm ${path}`,
				);
			}
			await navigate(sourcePath);
		}
		await until(
			() =>
				!!container.querySelector("#source-menu-trigger") &&
				materialReads > 0 &&
				directoryReads > 0,
			"Source detail and both directories must load",
		);
		const trigger = button("来源的更多操作");
		await trustedClick(trigger);
		await until(
			() => !!container.querySelector(".s2-source-menu:popover-open"),
			"Source menu must open",
		);
		if (!preview) {
			const resize = (
				window as Window & {
					browserResize?: (width: number, height: number) => Promise<void>;
				}
			).browserResize;
			check(
				resize,
				"Source menu regression requires browser viewport resizing",
			);
			const panel = container.querySelector<HTMLElement>(".s2-source-menu");
			const scroller = trigger.closest<HTMLElement>(".source-detail-content");
			check(panel && scroller, "Source menu and scroll area must exist");
			const width = innerWidth;
			const height = innerHeight;
			const viewportGeometry = () => ({
				anchor: trigger.getBoundingClientRect().toJSON(),
				menu: panel.getBoundingClientRect().toJSON(),
				style: panel.style.cssText,
				open: panel.matches(":popover-open"),
				scrollTop: scroller.scrollTop,
			});
			const anchored = () => {
				const anchor = trigger.getBoundingClientRect();
				const bounds = panel.getBoundingClientRect();
				return (
					panel.matches(":popover-open") &&
					(Math.abs(bounds.top - anchor.bottom - 6) < 1 ||
						Math.abs(anchor.top - bounds.bottom - 6) < 1) &&
					Math.abs(bounds.right - anchor.right) < 1 &&
					bounds.left >= 12 &&
					bounds.bottom <= innerHeight - 12
				);
			};
			await until(anchored, "Source menu must open beside its trigger");
			await resize(width > 900 ? 390 : 1280, 420);
			await until(anchored, "Open source menu must follow across breakpoints");
			await resize(320, 360);
			try {
				await until(anchored, "Open source menu must fit a narrow window");
			} catch (error) {
				throw new Error(JSON.stringify(viewportGeometry()), { cause: error });
			}
			// Give this compact fixture the same scroll range as a populated overview.
			scroller.style.paddingBottom = "240px";
			scroller.scrollTop = 24;
			await until(
				() => scroller.scrollTop === 24 && anchored(),
				"Open source menu must follow a trigger moving within the scroll area",
			);
			check(browserKey, "Source menu regression requires native Escape");
			await browserKey("Escape");
			await until(
				() =>
					!panel.matches(":popover-open") && document.activeElement === trigger,
				"Escape must close the source menu and restore trigger focus",
			);
			await trustedClick(trigger);
			await until(
				anchored,
				"Source menu must open beside an already scrolled trigger",
			);
			scroller.scrollTop = 180;
			await until(
				() => !panel.matches(":popover-open") && scroller.scrollTop === 180,
				"Source menu must close when scrolling hides the trigger",
			);
			scroller.scrollTop = 0;
			scroller.style.removeProperty("padding-bottom");
			const sourceSwitch = button("切换来源");
			await trustedClick(sourceSwitch);
			await until(
				() => !!container.querySelector("dialog.s2-source-drawer[open]"),
				"Narrow source detail must still provide the directory drawer",
			);
			const drawer = container.querySelector("dialog.s2-source-drawer[open]");
			check(drawer, "Expected an open source directory drawer");
			await until(
				() => !!drawer.querySelector(`a[data-source-id="${other.id}"]`),
				"The remaining source must be available for prefetch",
			);
			drawer
				.querySelector<HTMLAnchorElement>(`a[data-source-id="${other.id}"]`)
				?.focus();
			await until(
				() =>
					Object.values(overviewReads).every((count) => count > 0) &&
					queryClient?.isFetching() === 0,
				"The remaining source overview must be warm before deletion",
			);
			check(
				Object.values(overviewReads).every((count) => count === 1),
				"Each remaining source overview interface must receive one prefetch",
			);
			button("关闭", drawer).click();
			await until(() => !drawer.isConnected, "Directory drawer must close");
			await resize(width, height);
			await trustedClick(trigger);
			await until(anchored, "Source menu must reopen beside its trigger");
		}
		await trustedClick(button("删除来源及其内容…"));
		await until(
			() => !!dialog()?.textContent?.includes("4 份讲解"),
			"Confirmation must load current analysis count",
		);
		const text = requiredDialog().textContent?.replace(/\s+/g, " ") ?? "";
		for (const expected of [
			"2 本已导入的书籍及其阅读数据",
			"3 个片段",
			"4 份讲解（含历史版本）",
			"5 段对话",
			"6 条消息",
			"将停止 1 个对话任务",
			"这些书籍的翻译任务也会停止",
			"此操作无法撤销",
			"不会影响你本地保存的 EPUB 文件",
		])
			check(
				text.includes(expected),
				`Source confirmation must disclose ${expected}`,
			);
		const bounds = requiredDialog().getBoundingClientRect();
		check(
			bounds.left >= 0 &&
				bounds.right <= innerWidth + 1 &&
				bounds.bottom <= innerHeight + 1,
			"Source confirmation must fit viewport",
		);
		if (preview)
			return "source deletion: actual source detail confirmation preview";
		check(
			document.activeElement === button("取消", requiredDialog()),
			"Deletion must focus cancel",
		);
		button("取消", requiredDialog()).click();
		await until(() => !dialog(), "Cancel must close the preview");
		const reread = readGate();
		impactGate = reread.promise;
		async function reopen() {
			await trustedClick(trigger);
			await trustedClick(button("删除来源及其内容…"));
			await until(() => !!dialog(), "Deletion must reopen");
		}
		await reopen();
		check(
			button("确认删除").disabled &&
				document.activeElement === button("取消", requiredDialog()),
			"A cached impact must not enable delete or steal cancel focus during a reread",
		);
		check(browserKey, "Expected native keyboard input");
		await browserKey("Enter");
		await until(() => !dialog(), "Enter on reopen must cancel, not delete");
		check(!deleteRequests, "Keyboard cancellation cannot delete a source");
		reread.release();
		await reopen();
		await until(
			() => !button("确认删除").disabled,
			"Fresh impact unlocks explicit confirmation",
		);
		impact.analysis_count++;
		const beforeImpact = impactReads;
		const confirm = button("确认删除");
		// Same-task clicks exercise the guard before React commits pending state.
		confirm.click();
		confirm.click();
		await until(
			() => Number(deleteRequests) === 1,
			"One confirmation must submit exactly one DELETE without rereading counts",
		);
		check(
			impactReads === beforeImpact,
			"Confirmation must not recheck impact counts",
		);
		button("删除中…").click();
		await cancelPending();
		check(
			Number(deleteRequests) === 1 && button("取消").disabled,
			"Pending DELETE must lock cancellation and duplicate submission",
		);
		check(releaseDelete, "DELETE must be releasable");
		releaseDelete(
			Response.json({ detail: "来源清理失败，请重试" }, { status: 500 }),
		);
		await until(
			() =>
				!!dialog()?.textContent?.includes("来源清理失败，请重试") &&
				!button("确认删除").disabled,
			"Failure must keep confirmation open with enabled retry",
		);
		check(
			container.querySelector("[data-test-path]")?.textContent ===
				`/sources/${source.id}`,
			"Failure must retain source route",
		);
		const beforeDirectory = directoryReads,
			beforeMaterials = materialReads;
		button("确认删除").click();
		await until(
			() => Number(deleteRequests) === 2,
			"Retry must submit exactly one new DELETE",
		);
		removed = true;
		check(releaseDelete, "Retry DELETE must be releasable");
		releaseDelete(new Response(null, { status: 204 }));
		await until(
			() =>
				!dialog() &&
				container.querySelector("[data-test-path]")?.textContent ===
					`/sources/${other.id}` &&
				directoryReads > beforeDirectory &&
				materialReads > beforeMaterials,
			"Success must leave deleted source and refresh source/material directories",
		);
		await until(
			() =>
				!container.querySelector(
					`.s2-directory a[href^="/sources/${source.id}"]`,
				) &&
				!!container.querySelector(
					`.s2-directory a[href^="/sources/${other.id}"]`,
				),
			"Refreshed directory must remove deleted source and retain other sources",
		);
		await until(
			() =>
				Object.values(overviewReads).every((count) => count === 2) &&
				showsOverview(container, refreshed),
			"Deleting a source must invalidate the remaining source's prefetched overview and refresh it",
		);
		for (const [path, text] of [...history].reverse()) {
			await navigate(path === history[3][0] ? -2 : -1);
			await until(
				() => container.querySelector("[data-test-path]")?.textContent === path,
				`Return to ${path}`,
			);
			if (path.includes(source.id))
				check(
					!container.textContent?.includes(text),
					`Deleted detail flashed during return to ${path}`,
				);
			else
				await until(
					() => !!container.textContent?.includes(text),
					`Unaffected detail must render from cache during its pending GET: ${path}`,
				);
		}
		return `source deletion ${innerWidth}px: cancellation, fresh impact, scoped history and directory refresh verified`;
	} finally {
		returnRead.release();
		if (!preview) dispose();
	}
}
