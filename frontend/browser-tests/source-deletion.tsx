import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation } from "react-router";
import type { components } from "../src/api/schema";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";
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
	const { catalogBooks, catalogKeys } = await import("../src/catalog/api");
	const { container, mock, mount, until } = h;
	const check: BrowserHarness["check"] = h.check;
	let removed = false,
		directoryReads = 0,
		materialReads = 0,
		deleteRequests = 0,
		impactReads = 0;
	let holdImpact = false;
	let releaseImpact: (() => void) | undefined;
	let releaseDelete: ((response: Response) => void) | undefined;
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
			if (holdImpact)
				await new Promise<void>((resolve) => {
					releaseImpact = resolve;
				});
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
			return Response.json({ items: [], total: 0, page: 1, page_size: 3 });
		}
		if (
			request.method === "GET" &&
			/\/catalog\/(segments|analyses)$/.test(path)
		)
			return Response.json({ items: [], total: 0, page: 1, page_size: 3 });
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
		window as Window & { browserKey?: (key: "Escape") => Promise<void> }
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
	const dispose = await mount(<Routes />, "/", `/sources/${source.id}`, [
		{ path: "sources", element: <SourceIndex /> },
		{ path: "sources/:id", element: <SourceDetail /> },
	]);
	try {
		await until(
			() =>
				!!container.querySelector("#source-menu-trigger") &&
				materialReads > 0 &&
				directoryReads > 0,
			"Source detail and both directories must load",
		);
		await trustedClick(button("来源的更多操作"));
		await until(
			() => !!container.querySelector(".s2-source-menu:popover-open"),
			"Source menu must open",
		);
		await trustedClick(button("删除来源及其内容…"));
		await until(
			() => !!dialog()?.textContent?.includes("4 份讲解"),
			"Confirmation must load current analysis count",
		);
		const text = requiredDialog().textContent?.replace(/\s+/g, " ") ?? "";
		for (const expected of [
			"2 份阅读材料",
			"3 个片段",
			"4 份讲解（含全部修订）",
			"5 条讨论",
			"6 条消息",
			"1 个进行中的任务",
			"原书和派生阅读数据",
			"清理不可撤销",
			"本地 EPUB 文件不会被删除",
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
		impact.analysis_count++;
		button("确认删除").click();
		await until(
			() =>
				!!dialog()?.textContent?.includes("删除范围刚刚变化") &&
				!!dialog()?.textContent?.includes("5 份讲解"),
			"Analysis-only impact change must update counts and require reconfirmation",
		);
		check(deleteRequests === 0, "Changed analysis count must prevent DELETE");
		await until(
			() => !button("确认删除").disabled,
			"Reconfirmation must become available",
		);
		holdImpact = true;
		const beforeImpact = impactReads;
		const confirm = button("确认删除");
		// Same-task clicks exercise the guard before React commits pending state.
		confirm.click();
		confirm.click();
		await until(() => !!releaseImpact, "Submission must recheck latest impact");
		await cancelPending();
		check(
			impactReads === beforeImpact + 1 && deleteRequests === 0,
			"Duplicate clicks during recheck must not issue another mutation",
		);
		holdImpact = false;
		check(releaseImpact, "Impact recheck must be releasable");
		releaseImpact();
		await until(
			() => Number(deleteRequests) === 1,
			"Confirmed unchanged impact must submit one DELETE",
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
		return `source deletion: impact disclosure, analysis-only reconfirmation, duplicate/cancel/Escape guards, failed DELETE retry and directory refresh verified at ${innerWidth}px`;
	} finally {
		if (!preview) dispose();
	}
}
