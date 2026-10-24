import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AnalysisDetail } from "../src/analysis/api";
import type { BrowserHarness } from "./harness";
import "../src/segments/layout.css";

const originalTitle = "文脈から言葉を理解する";
const source = `# ${originalTitle}\n\n原文の講解本文。`;
const current: AnalysisDetail = {
	id: "rename-analysis",
	segment_id: "rename-segment",
	title: originalTitle,
	excerpt: "原文の講解本文。",
	current_revision_id: "revision-current",
	revision_id: "revision-current",
	parent_revision_id: "revision-history",
	origin: "manual",
	run_id: null,
	normalizer_version: 1,
	created_at: "2026-10-24T00:00:00Z",
	updated_at: "2026-10-24T00:00:00Z",
	source_md: source,
	warnings: [],
	sections: [
		{
			id: "rename-section",
			uid: "rename-uid",
			handle: "title",
			kind: "section",
			title: originalTitle,
			display_no: "1",
			start_line: 1,
			end_line: 3,
			raw: source,
		},
	],
};
const historical: AnalysisDetail = {
	...current,
	revision_id: "revision-history",
	parent_revision_id: null,
	source_md: `${source}\n\n历史正文。`,
	sections: current.sections.map((section) => ({
		...section,
		raw: `${source}\n\n历史正文。`,
	})),
};

export async function analysisRename(h: BrowserHarness) {
	const { AnalysisPanel } = await import("../src/analysis/AnalysisPanel");
	const { analysisKeys } = await import("../src/analysis/api");
	const { container, mount, mock, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const preview = new URLSearchParams(location.search).has("preview");
	let title = originalTitle;
	let mode: "success" | "conflict" | "error" | "accepted-error" | "pending" =
		"success";
	let release: (() => void) | undefined;
	let queryClient: QueryClient | undefined;
	const writes: { title: string; expected_title: string }[] = [];
	const metadata = () => ({
		id: current.id,
		segment_id: current.segment_id,
		title,
		excerpt: current.excerpt,
		current_revision_id: current.current_revision_id,
		created_at: current.created_at,
		updated_at: "2026-10-24T01:00:00Z",
	});
	mock(async (request) => {
		const url = new URL(request.url);
		if (
			request.method === "GET" &&
			url.pathname === "/api/segments/rename-segment/analyses"
		)
			return Response.json([metadata()]);
		if (
			request.method === "GET" &&
			url.pathname === "/api/analyses/rename-analysis"
		)
			return Response.json({
				...(url.searchParams.get("revision_id") === historical.revision_id
					? historical
					: current),
				title,
			});
		if (
			request.method === "PATCH" &&
			url.pathname === "/api/analyses/rename-analysis"
		) {
			const body = (await request.json()) as {
				title: string;
				expected_title: string;
			};
			writes.push(body);
			check(
				Object.keys(body).sort().join() === "expected_title,title",
				"Rename must send only metadata and concurrency baseline",
			);
			if (mode === "conflict") {
				title = "另一页面保存的名称";
				return Response.json(
					{ detail: "名称已被其他页面修改" },
					{ status: 409 },
				);
			}
			if (mode === "error")
				return Response.json({ detail: "暂时保存失败" }, { status: 500 });
			if (body.expected_title !== title && body.title !== title)
				return Response.json(
					{ detail: "名称已被其他页面修改" },
					{ status: 409 },
				);
			title = body.title;
			if (mode === "accepted-error")
				return Response.json({ detail: "响应中断，请重试" }, { status: 500 });
			if (mode === "pending")
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return Response.json(metadata());
		}
		throw new Error(
			`Unexpected rename request ${request.method} ${url.pathname}`,
		);
	});
	function Reading() {
		queryClient = useQueryClient();
		const [selection, setSelection] = useState<[string | null, string | null]>([
			current.id,
			null,
		]);
		return (
			<div
				className="app-shell segment-study-shell"
				style={{ display: "block", padding: 16 }}
			>
				<div style={{ maxWidth: 760, margin: "0 auto" }}>
					<AnalysisPanel
						segmentId={current.segment_id}
						selectedId={selection[0]}
						revisionId={selection[1]}
						onSelect={(id, revision) => setSelection([id, revision])}
					/>
					{!preview && (
						<button
							type="button"
							data-test-history
							onClick={() => setSelection([current.id, historical.revision_id])}
						>
							测试历史
						</button>
					)}
				</div>
			</div>
		);
	}
	const findButton = (label: string, scope: ParentNode = container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent?.trim() === label,
		);
		check(found, `Missing rename action ${label}`);
		return found;
	};
	const dialog = () =>
		container.querySelector<HTMLDialogElement>("dialog[open]");
	const requiredDialog = () => {
		const found = dialog();
		check(found, "Rename dialog must remain open");
		return found;
	};
	const field = () => {
		const found = dialog()?.querySelector<HTMLInputElement>("input");
		check(found, "Rename must expose its name input");
		return found;
	};
	const key = (node: HTMLElement, value: string) =>
		node.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: value,
				bubbles: true,
				cancelable: true,
			}),
		);
	async function open() {
		const trigger = container.querySelector<HTMLButtonElement>(
			".analysis-menu-trigger",
		);
		check(trigger, "Reading must expose its more-actions menu");
		trigger.click();
		await until(
			() => !!container.querySelector(".analysis-document-menu:popover-open"),
			"More-actions menu must open",
		);
		const action = findButton("重命名");
		check(
			action.getAttribute("role") === "menuitem",
			"Rename must be a menuitem",
		);
		action.click();
		await until(() => !!dialog(), "Rename dialog must open");
		check(
			dialog()?.textContent?.includes("重命名讲解"),
			"Dialog must identify the metadata operation",
		);
		check(
			field().labels?.[0]?.textContent?.trim() === "名称",
			"Name input needs its visible label",
		);
		check(
			field().value === title,
			"Opening must use the current metadata name",
		);
		const bounds = requiredDialog().getBoundingClientRect();
		check(
			bounds.left >= 0 &&
				bounds.right <= innerWidth + 1 &&
				bounds.bottom <= innerHeight + 1,
			"Rename dialog must fit the viewport",
		);
	}
	async function edit(value: string) {
		inputValue(field(), value);
		await until(() => field().value === value, "Draft must receive input");
		await new Promise((resolve) => requestAnimationFrame(resolve));
	}
	async function saved(expected: string) {
		await until(
			() =>
				!dialog() &&
				container
					.querySelector(".analysis-document-title")
					?.textContent?.trim() === expected,
			"Successful rename must update the reading header and close the dialog",
		);
	}
	const dispose = await mount(<Reading />);
	try {
		await until(
			() => !!container.querySelector(".analysis-document"),
			"Analysis must load",
		);
		const trigger = container.querySelector<HTMLButtonElement>(
			".analysis-menu-trigger",
		);
		check(trigger, "Missing analysis menu trigger");
		trigger.focus();
		key(trigger, "ArrowUp");
		await until(
			() => trigger.getAttribute("aria-expanded") === "true",
			"ArrowUp must open the menu",
		);
		const menuItems = [
			...container.querySelectorAll<HTMLButtonElement>(
				'.analysis-document-menu [role="menuitem"]',
			),
		];
		check(
			menuItems.length === 3 &&
				menuItems.some((item) => item.textContent?.trim() === "重命名"),
			"Menu must retain version/delete and add rename",
		);
		await until(
			() => document.activeElement === menuItems.at(-1),
			"ArrowUp must focus the actual last menu item",
		);
		key(document.activeElement as HTMLElement, "ArrowUp");
		check(
			document.activeElement === menuItems.at(-2),
			"ArrowUp must traverse the added item correctly",
		);
		key(document.activeElement as HTMLElement, "Escape");
		await until(
			() => trigger.getAttribute("aria-expanded") === "false",
			"Escape must close the menu",
		);
		await open();
		if (preview) return "analysis rename: interactive dialog preview";
		await edit("放弃的草稿");
		findButton("取消").click();
		await until(() => !dialog(), "Cancel must close the dialog");
		check(
			writes.length === 0 && title === originalTitle,
			"Cancel must not write metadata",
		);
		await open();
		for (const invalid of ["   ", "あ".repeat(201)]) {
			await edit(invalid);
			check(
				findButton("保存名称").disabled,
				"Blank and over-limit names must disable save",
			);
		}
		await edit("  カ\u3099の講解  ");
		findButton("保存名称").click();
		await saved("ガの講解");
		check(
			writes.at(-1)?.title === "ガの講解" &&
				writes.at(-1)?.expected_title === originalTitle,
			"Save must trim, NFC-normalize, and include the opening baseline",
		);
		check(
			container.querySelector(".analysis-section h1")?.textContent ===
				originalTitle,
			"Renaming must retain the old source heading in the body",
		);
		await open();
		mode = "conflict";
		await edit("保留的冲突草稿");
		findButton("保存名称").click();
		await until(
			() => !!dialog()?.querySelector('[role="alert"]'),
			"Conflict must be visible",
		);
		check(
			field().value === "保留的冲突草稿",
			"Conflict must preserve the draft",
		);
		const beforeReload = writes.length;
		mode = "success";
		findButton("读取最新名称").click();
		await until(
			() => !!dialog()?.textContent?.includes("另一页面保存的名称"),
			"Reload must show the latest server name",
		);
		check(
			field().value === "保留的冲突草稿" && writes.length === beforeReload,
			"Reload must preserve draft and require explicit save",
		);
		findButton("保存名称").click();
		await saved("保留的冲突草稿");
		check(
			writes.at(-1)?.expected_title === "另一页面保存的名称",
			"Explicit conflict retry must use the refreshed baseline",
		);
		for (const failure of ["error", "accepted-error"] as const) {
			await open();
			mode = failure;
			const draft = failure === "error" ? "失败后重试" : "响应中断后重试";
			await edit(draft);
			findButton("保存名称").click();
			await until(
				() => !!dialog()?.querySelector('[role="alert"]'),
				"Failed response must remain visible",
			);
			check(field().value === draft, "Failure must preserve editable draft");
			mode = "success";
			findButton("保存名称").click();
			await saved(draft);
		}
		findButton("测试历史").click();
		await until(
			() => !!container.textContent?.includes("历史版本（只读）"),
			"Historical revision must load",
		);
		await open();
		mode = "pending";
		await edit("历史阅读时的新名称");
		const beforePending = writes.length;
		findButton("保存名称").click();
		await until(() => !!release, "Save must reach the pending request");
		check(
			field().disabled && findButton("取消").disabled,
			"Pending save must lock draft and cancellation",
		);
		const save = [
			...requiredDialog().querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.includes("保存"));
		check(save?.disabled, "Pending save must disable duplicate submission");
		save.click();
		requiredDialog().dispatchEvent(new Event("cancel", { cancelable: true }));
		check(
			!!dialog() && writes.length === beforePending + 1,
			"Escape and repeat clicks must not dismiss or duplicate pending writes",
		);
		check(release, "Pending response must be releasable");
		release();
		await saved("历史阅读时的新名称");
		check(
			container.textContent?.includes("历史正文。") &&
				container.textContent.includes("历史版本（只读）"),
			"Metadata rename must keep the historical reading selection and body",
		);
		check(queryClient, "Query client must be available for cache verification");
		for (const expected of [current, historical]) {
			const cached = queryClient.getQueryData<AnalysisDetail>(
				analysisKeys.detail(
					expected.id,
					expected === current ? null : expected.revision_id,
				),
			);
			check(
				cached?.title === title &&
					cached.source_md === expected.source_md &&
					cached.revision_id === expected.revision_id &&
					JSON.stringify(cached.sections) === JSON.stringify(expected.sections),
				"Rename must update all cached names while preserving revision content and sections",
			);
		}
		container
			.querySelector<HTMLButtonElement>('[aria-label="返回讲解列表"]')
			?.click();
		await until(
			() =>
				container.querySelector(".analysis-list strong")?.textContent === title,
			"Returning to the list must show the renamed title",
		);
		return `analysis rename: ${writes.length} metadata writes; cancel/validation/NFC/conflict/reload/retry/pending/history/cache/list/menu verified at ${innerWidth}px`;
	} finally {
		if (!preview) dispose();
	}
}
