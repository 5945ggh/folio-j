import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import type { components } from "../src/api/schema";
import type { CatalogSegment } from "../src/catalog/api";
import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";
import "../src/catalog/source-content.css";
import "../src/catalog/sources-s2.css";

const sourceId = "segment-catalog-source";
const otherId = "segment-catalog-other";
const created = "2026-10-20T00:00:00Z";
const updated = "2026-10-29T00:00:00Z";
const material: components["schemas"]["MaterialProvenance"] = {
	contract_version: "1",
	material_id: "catalog-material",
	version_id: "catalog-version",
	ranges: [],
};
function segment(
	id: string,
	patch: Partial<CatalogSegment> = {},
): CatalogSegment {
	return {
		id,
		source_id: sourceId,
		text: `回帰用の原文「${id}」。`,
		text_sha256: "a".repeat(64),
		context_before: "",
		context_after: "",
		created_at: created,
		updated_at: updated,
		text_locked_at: null,
		revision: 1,
		note: "",
		source_ref: "",
		transcription: "",
		translation: "",
		material_provenance: null,
		provenance_summary: {
			status: "none",
			display: null,
			title: null,
			chapter_title: null,
		},
		...patch,
	};
}

/** Real source and detail routes with every API response confined to this fixture. */
export async function segmentCatalog(
	h: BrowserHarness,
	preview = false,
): Promise<string> {
	const { getSource, listSources, queries } = await import("../src/content");
	const { SourceContent } = await import("../src/catalog/SourceViews");
	const { SegmentDetail } = await import("../src/SegmentPage");
	const { container, until, mock, mount } = h;
	const check: BrowserHarness["check"] = h.check;
	let items: CatalogSegment[] = [];
	let analysisCount = 2;
	let impactFailure = false;
	let deleteMode: "success" | "failure" | "pending" = "success";
	let releaseDelete: (() => void) | undefined;
	const deletes: string[] = [];
	const reads: string[] = [];
	const otherSegment = segment("other-preserved", { source_id: otherId });
	const source = (id: string): Source => ({
		id,
		title: id === sourceId ? "片段目录来源" : "其他来源保留",
		description: "",
		note: "",
		segment_count: id === sourceId ? items.length : 1,
		created_at: created,
		updated_at: updated,
	});
	const analyses = () =>
		items.some((item) => item.id === "material")
			? [
					{
						id: "catalog-analysis",
						segment_id: "material",
						title: "随片段删除的讲解",
						excerpt: "讲解正文摘要",
						segment_excerpt: "回帰用の原文",
						current_revision_id: "catalog-revision",
						created_at: created,
						updated_at: updated,
					},
				]
			: [];
	mock(async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		if (request.method === "GET") reads.push(`${path}${url.search}`);
		if (request.method === "GET" && path === "/api/sources")
			return Response.json([source(sourceId), source(otherId)]);
		if (request.method === "GET" && path.startsWith("/api/sources/")) {
			const id = path.split("/")[3] ?? "";
			if (path === `/api/sources/${id}`) return Response.json(source(id));
			const scoped = id === sourceId ? items : [otherSegment];
			const page = Number(url.searchParams.get("page") ?? 1);
			const pageSize = Number(url.searchParams.get("page_size") ?? 50);
			if (path.endsWith("/catalog/segments"))
				return Response.json({
					items: scoped.slice((page - 1) * pageSize, page * pageSize),
					total: scoped.length,
					page,
					page_size: pageSize,
				});
			if (path.endsWith("/catalog/analyses")) {
				const found = id === sourceId ? analyses() : [];
				return Response.json({
					items: found,
					total: found.length,
					page,
					page_size: pageSize,
				});
			}
		}
		if (request.method === "GET" && path === "/api/materials")
			return Response.json({ items: [], total: 0, page: 1, page_size: 3 });
		const match = path.match(/^\/api\/segments\/([^/]+)(.*)$/);
		if (match) {
			const id = match[1] ?? "";
			const suffix = match[2];
			if (request.method === "GET" && suffix === "/delete-impact") {
				if (impactFailure)
					return Response.json(
						{ detail: "影响范围暂时不可读" },
						{ status: 500 },
					);
				const impact: components["schemas"]["SegmentDeleteImpact"] = {
					segment_id: id,
					analysis_count: id === "material" ? analysisCount : 0,
					thread_count: 1,
					message_count: 3,
					active_job_count: 0,
				};
				return Response.json(impact);
			}
			if (request.method === "DELETE" && suffix === "") {
				deletes.push(id);
				if (deleteMode === "pending")
					await new Promise<void>((resolve) => {
						releaseDelete = resolve;
					});
				if (deleteMode === "failure")
					return Response.json(
						{ detail: "删除暂时失败，请重试" },
						{ status: 500 },
					);
				items = items.filter((item) => item.id !== id);
				return new Response(null, { status: 204 });
			}
			if (request.method === "GET" && suffix === "") {
				const found = items.find((item) => item.id === id);
				return found
					? Response.json(found)
					: Response.json({ detail: "已删除" }, { status: 404 });
			}
			if (
				request.method === "GET" &&
				["/analyses", "/translation-results"].includes(suffix ?? "")
			)
				return Response.json([]);
		}
		throw new Error(
			`Unexpected segment catalog request ${request.method} ${url.pathname}`,
		);
	});
	function Shell() {
		const location = useLocation();
		const navigate = useNavigate();
		const sources = useQuery({
			queryKey: queries.sources,
			queryFn: listSources,
		});
		return (
			<>
				<nav aria-label="回归导航">
					<button
						type="button"
						onClick={() => navigate(`/sources/${sourceId}?view=segments`)}
					>
						原来源片段
					</button>
					<button
						type="button"
						onClick={() => navigate(`/sources/${otherId}?view=segments`)}
					>
						其他来源片段
					</button>
				</nav>
				<output data-test-path>
					{location.pathname}
					{location.search}
				</output>
				<output data-test-counts>
					{sources.data
						?.map((item) => `${item.id}:${item.segment_count}`)
						.join(",")}
				</output>
				<Outlet />
			</>
		);
	}
	function SourceScreen() {
		const { id = "" } = useParams();
		const current = useQuery({
			queryKey: queries.source(id),
			queryFn: () => getSource(id),
		});
		return current.data ? (
			<main
				className="source-detail-content"
				style={{ maxWidth: 960, padding: 12, margin: "auto" }}
			>
				<output data-test-source-count>{current.data.segment_count}</output>
				<SourceContent
					key={id}
					source={current.data}
					onAddSegment={() => {}}
					onShowInfo={() => {}}
				/>
			</main>
		) : null;
	}
	const start = async (entry: string) => {
		localStorage.clear();
		sessionStorage.clear();
		return mount(<Shell />, "/", entry, [
			{ path: "sources/:id", element: <SourceScreen /> },
			{ path: "segments/:id", element: <SegmentDetail /> },
		]);
	};
	const action = (label: string, scope: ParentNode = container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent?.trim() === label,
		);
		check(found, `Missing segment action ${label}`);
		return found;
	};
	const path = () =>
		container.querySelector("[data-test-path]")?.textContent ?? "";
	const row = (id: string, selector = ".segment-row") =>
		[...container.querySelectorAll<HTMLElement>(selector)].find((node) =>
			node.querySelector(`a[href="/segments/${id}"]`),
		);
	const dialog = () =>
		container.querySelector<HTMLDialogElement>(
			'dialog[aria-labelledby="delete-segment-title"][open]',
		);
	const requiredDialog = () => {
		const found = dialog();
		check(found, "Delete confirmation must remain open");
		return found;
	};
	const tab = async (name: string) => {
		const found = container.querySelector<HTMLButtonElement>(
			`#source-content-tab-${name}`,
		);
		check(found, `Missing content tab ${name}`);
		found.click();
		await until(
			() => found.getAttribute("aria-selected") === "true",
			`Tab ${name} must activate`,
		);
	};
	async function openDelete(id: string) {
		const trigger = row(id)?.querySelector<HTMLButtonElement>(
			".segment-menu-trigger",
		);
		check(trigger, `Missing segment menu for ${id}`);
		const before = path();
		trigger.focus();
		trigger.click();
		await until(
			() => !!container.querySelector(".segment-list-menu:popover-open"),
			"Segment menu must open as native popover",
		);
		const menu = container.querySelector<HTMLElement>(
			".segment-list-menu:popover-open",
		);
		check(
			menu && menu.querySelectorAll('[role="menuitem"]').length === 1,
			"Segment menu must contain only one deletion action",
		);
		const bounds = menu.getBoundingClientRect();
		check(
			bounds.left >= 0 && bounds.right <= innerWidth + 1,
			"Segment menu must fit viewport",
		);
		check(path() === before, "Opening segment menu must not navigate");
		action("删除片段…", menu).click();
		await until(() => !!dialog(), "Delete dialog must open");
		check(path() === before, "Choosing delete must not navigate");
		return trigger;
	}
	const loadedImpact = () =>
		until(
			() => !action("确认删除", requiredDialog()).disabled,
			"Delete must wait for current impact",
		);
	async function longMetadata(previewMode: boolean) {
		const longTitle =
			"とても長い書名である『日本語の文章を読みながら言葉と物語の奥深い関係を丁寧に考え続けるための読書案内』".repeat(
				3,
			);
		const longChapter =
			"第三章　物語の中で出会う言葉と登場人物の心の変化を一つずつ確かめながら読み進める長い章の名前".repeat(
				3,
			);
		const position = "章内约 12%";
		const origin = `${longTitle} · ${longChapter} · ${position} · 出处补充：手填页码 42`;
		items = [
			segment("long-material", {
				material_provenance: material,
				source_ref: "手填页码 42",
				provenance_summary: {
					status: "resolved",
					chapter_percent: 12,
					title: longTitle,
					chapter_title: longChapter,
					display: `${longTitle} · ${longChapter} · ${position}`,
				},
			}),
			segment("long-deleted", {
				material_provenance: material,
				provenance_summary: {
					status: "material_deleted",
					title: longTitle,
					chapter_title: null,
					display: null,
				},
			}),
		];
		const disposeLong = await start(`/sources/${sourceId}`);
		const assertLayout = (selector: string) => {
			const current = row("long-material", selector);
			const deleted = row("long-deleted", selector);
			check(current && deleted, "Long-origin fixtures must be visible");
			const metadata = current.querySelector<HTMLElement>(".segment-meta");
			const label = current.querySelector<HTMLElement>(".segment-origin-label");
			const date = current.querySelector<HTMLElement>(".segment-created-at");
			check(
				metadata && label && date,
				"Long origin must retain its metadata structure",
			);
			check(
				label.title === origin && label.textContent === origin,
				"Ellipsis must preserve the complete origin in title and textContent",
			);
			for (const [className, text] of [
				["segment-origin-title", longTitle],
				["segment-origin-chapter", longChapter],
				["segment-origin-supplement", "出处补充：手填页码 42"],
			] as const) {
				const node = current.querySelector<HTMLElement>(
					`.${className} .segment-origin-value`,
				);
				check(
					node && node.textContent === text,
					`Long ${className} must retain full text`,
				);
				const style = getComputedStyle(node);
				check(
					style.whiteSpace === "nowrap" &&
						style.textOverflow === "ellipsis" &&
						node.clientWidth > 0 &&
						node.scrollWidth > node.clientWidth,
					`Long ${className} must actually ellipsize on a single line`,
				);
			}
			for (const [owner, className, text] of [
				[current, "segment-origin-position", position],
				[deleted, "segment-origin-state", "材料已删除"],
			] as const) {
				const node = owner.querySelector<HTMLElement>(
					`.${className} .segment-origin-value`,
				);
				check(node, `Origin must expose ${className}`);
				check(
					node.textContent?.includes(text),
					`Origin must retain ${className}`,
				);
				const range = document.createRange();
				range.selectNodeContents(node);
				const rects = [...range.getClientRects()].filter(
					(rect) => rect.width > 0,
				);
				check(
					getComputedStyle(node).whiteSpace === "nowrap" &&
						node.scrollWidth <= node.clientWidth + 1 &&
						rects.length > 0 &&
						rects.every(
							(rect) => Math.abs(rect.top - (rects[0]?.top ?? 0)) < 1,
						),
					`${className} must remain one unbroken text line`,
				);
			}
			const labelBounds = label.getBoundingClientRect();
			const dateBounds = date.getBoundingClientRect();
			const metadataBounds = metadata.getBoundingClientRect();
			if (metadata.clientWidth <= 600)
				check(
					dateBounds.top >= labelBounds.bottom - 1,
					"Narrow metadata must move the whole date below the origin",
				);
			else
				check(
					Math.abs(dateBounds.right - metadataBounds.right) <= 1,
					"Desktop date must align with the metadata row's right edge",
				);
			for (const owner of [current, deleted]) {
				const bounds = owner.getBoundingClientRect();
				check(
					bounds.left >= 0 &&
						bounds.right <= innerWidth + 1 &&
						owner.scrollWidth <= owner.clientWidth + 1,
					"Long metadata must not overflow its overview or list row horizontally",
				);
			}
		};
		try {
			await until(
				() =>
					!!row("long-material", ".overview-segment") &&
					!!row("long-deleted", ".overview-segment"),
				"Long-origin overview must load",
			);
			assertLayout(".overview-segment");
			const panel = new URLSearchParams(location.search).get("panel");
			if (previewMode && panel === "overview")
				return `long segment origin preview: overview at ${innerWidth}px`;
			await tab("segments");
			await until(
				() => !!row("long-material"),
				"Long-origin full list must load",
			);
			assertLayout(".segment-row");
			if (previewMode && panel === "delete") {
				await openDelete("long-material");
				await loadedImpact();
			}
			return `long segment origin: title/chapter ellipsis, unbroken position/state, date alignment and overflow at ${innerWidth}px`;
		} finally {
			if (!previewMode) disposeLong();
		}
	}
	if (preview) return longMetadata(true);

	items = [
		segment("material", {
			material_provenance: material,
			source_ref: "手填页码 42",
			provenance_summary: {
				status: "resolved",
				chapter_percent: 12,
				title: "確かな本",
				chapter_title: "第三章",
				display: "確かな本 · 第三章 · 章内约 12%",
			},
		}),
		segment("manual", { source_ref: "手填出处" }),
		segment("deleted-material", {
			material_provenance: material,
			provenance_summary: {
				status: "material_deleted",
				title: "消えた本",
				display: null,
				chapter_title: null,
			},
		}),
		segment("no-origin"),
	];
	let dispose = await start(`/sources/${sourceId}`);
	try {
		await until(
			() =>
				!!row("material", ".overview-segment") &&
				!!row("deleted-material", ".overview-segment"),
			"Overview metadata must load",
		);
		check(
			container.textContent?.includes("随片段删除的讲解"),
			"Overview must start with saved analysis",
		);
		const overviewMetadata = new Map(
			["material", "manual", "deleted-material"].map((id) => [
				id,
				row(id, ".overview-segment")?.querySelector(".segment-meta")
					?.textContent,
			]),
		);
		await tab("segments");
		await until(() => !!row("no-origin"), "Full segment list must load");
		for (const node of container.querySelectorAll<HTMLElement>(
			".segment-row",
		)) {
			const bounds = node.getBoundingClientRect();
			check(
				bounds.left >= 0 &&
					bounds.right <= innerWidth + 1 &&
					node.scrollWidth <= node.clientWidth + 1,
				"Segment metadata and actions must fit the viewport without horizontal overflow",
			);
		}
		for (const [id, metadata] of overviewMetadata)
			check(
				metadata &&
					row(id)?.querySelector(".segment-meta")?.textContent === metadata,
				"Overview and list must share origin and added date",
			);
		const origin =
			row("material")?.querySelector(".segment-origin-label")?.textContent ??
			"";
		check(
			origin.startsWith("確かな本 · 第三章") &&
				origin.includes("出处补充：手填页码 42"),
			"Material origin must precede handwritten supplement",
		);
		check(
			row("manual")?.querySelector(".segment-origin-label")?.textContent ===
				"手填出处",
			"Manual origin must remain visible",
		);
		check(
			row("no-origin")?.querySelector(".segment-origin-label")?.textContent ===
				"未保存出处",
			"Missing origin must be explicit",
		);
		check(
			row("deleted-material")?.textContent?.includes("消えた本 · 材料已删除"),
			"Deleted material must retain its saved origin state",
		);
		for (const node of container.querySelectorAll<HTMLTimeElement>(
			".segment-meta time",
		))
			check(
				node.dateTime === created &&
					!node.closest(".segment-meta")?.textContent?.includes("更新于"),
				"Metadata must show creation time rather than last update",
			);
		const trigger = await openDelete("material");
		await loadedImpact();
		check(
			requiredDialog().textContent?.includes("2 份讲解") &&
				/1\s*条讨论和\s*3\s*条消息/.test(requiredDialog().textContent ?? ""),
			"Confirmation must include analysis and discussion scope",
		);
		action("取消", requiredDialog()).click();
		await until(
			() => !dialog() && document.activeElement === trigger,
			"Cancel must restore original menu trigger focus",
		);
		check(deletes.length === 0, "Cancellation must not delete");
		impactFailure = true;
		await openDelete("material");
		await until(
			() => !!dialog()?.textContent?.includes("影响范围暂时不可读"),
			"Impact failure must be visible",
		);
		check(
			action("确认删除", requiredDialog()).disabled && deletes.length === 0,
			"Unreadable impact must prevent delete",
		);
		impactFailure = false;
		action("重试读取影响范围", requiredDialog()).click();
		await loadedImpact();
		analysisCount = 3;
		action("确认删除", requiredDialog()).click();
		await until(
			() => !!dialog()?.textContent?.includes("删除范围刚刚变化"),
			"Changed analysis count must require a second confirmation",
		);
		check(
			deletes.length === 0 && dialog()?.textContent?.includes("3 份讲解"),
			"Changed analysis count must refresh scope without DELETE",
		);
		deleteMode = "failure";
		action("确认删除", requiredDialog()).click();
		await until(
			() => !!dialog()?.textContent?.includes("删除暂时失败，请重试"),
			"Delete failure must preserve confirmation for retry",
		);
		check(
			!!row("material") && Number(deletes.length) === 1,
			"Failed delete must retain list content",
		);
		deleteMode = "pending";
		action("确认删除", requiredDialog()).click();
		await until(() => !!releaseDelete, "Retry must enter pending DELETE");
		const pending = action("删除中…", requiredDialog());
		check(
			pending.disabled && action("取消", requiredDialog()).disabled,
			"Pending deletion must disable submission and cancel",
		);
		pending.click();
		requiredDialog().dispatchEvent(new Event("cancel", { cancelable: true }));
		check(
			!!dialog() && Number(deletes.length) === 2,
			"Escape and repeated click must not dismiss or duplicate pending DELETE",
		);
		check(releaseDelete, "Pending delete must be releasable");
		releaseDelete();
		await until(
			() =>
				!dialog() &&
				!row("material") &&
				container.querySelector("[data-test-source-count]")?.textContent ===
					"3",
			"Successful deletion must refresh list and source count",
		);
		check(
			container
				.querySelector("[data-test-counts]")
				?.textContent?.includes(`${sourceId}:3`),
			"Sources directory count must refresh",
		);
		await until(
			() =>
				document.activeElement ===
				row("manual")?.querySelector(".segment-menu-trigger"),
			"Successful deletion must focus next surviving menu",
		);
		await tab("analyses");
		await until(
			() => !!container.textContent?.includes("还没有保存的讲解"),
			"Deleted segment analysis must disappear from analysis catalog",
		);
		await tab("overview");
		await until(
			() => !!row("manual", ".overview-segment"),
			"Overview must refetch surviving content",
		);
		check(
			!row("material", ".overview-segment") &&
				!container.textContent?.includes("随片段删除的讲解"),
			"Overview must not retain deleted segment or analysis",
		);
		action("其他来源片段").click();
		await until(
			() => !!row(otherSegment.id),
			"Other source must remain readable",
		);
		check(
			container.querySelector("[data-test-source-count]")?.textContent === "1",
			"Other source count must remain unchanged",
		);
		action("原来源片段").click();
		await until(() => !!row("manual"), "Original source must remain readable");
		row("manual")
			?.querySelector<HTMLAnchorElement>('a[href="/segments/manual"]')
			?.click();
		await until(
			() =>
				container.querySelector<HTMLButtonElement>("#segment-more-trigger")
					?.disabled === false,
			"Real segment detail must load",
		);
		container
			.querySelector<HTMLButtonElement>("#segment-more-trigger")
			?.click();
		await until(
			() => !!container.querySelector("#segment-tools-menu"),
			"Detail more menu must open",
		);
		action(
			"删除片段…",
			container.querySelector("#segment-tools-menu") ?? container,
		).click();
		await until(
			() => !!dialog(),
			"Detail more menu must use shared deletion dialog",
		);
		await loadedImpact();
		deleteMode = "success";
		action("确认删除", requiredDialog()).click();
		await until(
			() =>
				path().split("?")[0] === `/sources/${sourceId}` &&
				!!row("no-origin", ".overview-segment"),
			"Detail deletion must return to its source with refreshed content",
		);
		check(
			items.length === 2 && !row("manual", ".overview-segment"),
			"Detail deletion must remove the segment",
		);
	} finally {
		dispose();
	}

	// Keep pagination realistic: the server returns exactly the requested 50 rows.
	items = Array.from({ length: 51 }, (_, index) => segment(`page-${index}`));
	dispose = await start(`/sources/${sourceId}?view=segments&page=2`);
	try {
		await until(() => !!row("page-50"), "Last catalog page must load");
		await openDelete("page-50");
		await loadedImpact();
		action("确认删除", requiredDialog()).click();
		await until(
			() =>
				!dialog() &&
				!!row("page-0") &&
				Number(new URLSearchParams(path().split("?")[1]).get("page") ?? 1) ===
					1,
			"Deleting last row on last page must return to valid first page",
		);
		check(
			!row("page-50") &&
				container.querySelectorAll(".segment-row").length === 50,
			"Page correction must show only surviving segments",
		);
	} finally {
		dispose();
	}
	items = [segment("last")];
	dispose = await start(`/sources/${sourceId}?view=segments`);
	try {
		await until(() => !!row("last"), "Single final segment must load");
		await openDelete("last");
		await loadedImpact();
		action("确认删除", requiredDialog()).click();
		await until(
			() => !dialog() && !!container.textContent?.includes("从第一段内容开始"),
			"Deleting final segment must show source empty state",
		);
		await until(
			() =>
				document.activeElement ===
				container.querySelector("#source-add-segment"),
			"Empty state must focus add-segment action",
		);
		check(
			container.querySelector("[data-test-source-count]")?.textContent === "0",
			"Final deletion must refresh zero count",
		);
	} finally {
		dispose();
	}
	const longResult = await longMetadata(false);
	return `segment catalog: shared origin/date, menu/focus, impact retry/count conflict, failure/pending retry, list/count/analysis/overview refresh, source isolation, detail deletion and pagination/empty state at ${innerWidth}px (${deletes.length} mocked DELETE requests; ${reads.length} local reads); ${longResult}`;
}
