import { useState } from "react";
import type { AnalysisDetail } from "../src/analysis/api";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import "../src/segments/layout.css";

const title =
	"同じ言葉でも文脈によって意味が変わることを理解するための詳しい講解";
const current: AnalysisDetail = {
	id: "analysis-first",
	segment_id: "analysis-segment",
	title,
	excerpt: "第一份讲解的独立摘要",
	current_revision_id: "revision-current",
	revision_id: "revision-current",
	parent_revision_id: "revision-old",
	origin: "manual",
	run_id: null,
	normalizer_version: 1,
	created_at: "2026-10-24T00:00:00Z",
	updated_at: "2026-10-24T00:00:00Z",
	source_md: `# ${title}\n\n标题所属段落的正文。\n\n## 語彙\n\n文脈に応じて意味を考える。`,
	warnings: [],
	sections: [
		{
			id: "title-section",
			uid: "title-uid",
			handle: "title",
			kind: "section",
			title,
			display_no: "1",
			start_line: 1,
			end_line: 3,
			raw: `# ${title}\n\n标题所属段落的正文。`,
		},
		{
			id: "vocabulary-section",
			uid: "vocabulary-uid",
			handle: "vocabulary",
			kind: "section",
			title: "語彙",
			display_no: "2",
			start_line: 5,
			end_line: 7,
			raw: "## 語彙\n\n文脈に応じて意味を考える。",
		},
	],
};
const second: AnalysisDetail = {
	...current,
	id: "analysis-second",
	title: "另一份独立讲解",
	excerpt: "第二份独立摘要",
	current_revision_id: "revision-second",
	revision_id: "revision-second",
};
const historical: AnalysisDetail = {
	...current,
	revision_id: "revision-old",
	parent_revision_id: null,
};

export async function analysisReading(h: BrowserHarness) {
	const { AnalysisPanel } = await import("../src/analysis/AnalysisPanel");
	const { NewAnalysisActions } = await import(
		"../src/segments/NewAnalysisActions"
	);
	const { container, mount, mock, until } = h;
	const check: BrowserHarness["check"] = h.check;
	const selected: [string | null, string | null][] = [];
	const edits: AnalysisDetail[] = [];
	const writes: string[] = [];
	let creates = 0;
	let generates = 0;
	const geometry: string[] = [];
	const preview = new URLSearchParams(location.search).has("preview");
	let detailMode: "normal" | "pending" | "error" = "normal";
	let releaseDetail: ((response: Response) => void) | undefined;
	const rawBefore = JSON.stringify([current, second, historical]);
	mock(async (request) => {
		const url = new URL(request.url);
		if (request.method !== "GET") {
			writes.push(`${request.method} ${url.pathname}`);
			throw new Error(
				"Analysis reading regression must never write or generate",
			);
		}
		if (
			url.pathname === "/api/segments/analysis-segment/analyses" ||
			url.pathname === "/api/segments/other-segment/analyses"
		)
			return Response.json(
				[current, second].map(
					({
						id,
						segment_id,
						title,
						excerpt,
						current_revision_id,
						created_at,
						updated_at,
					}) => ({
						id,
						segment_id,
						title,
						excerpt,
						current_revision_id,
						created_at,
						updated_at,
					}),
				) satisfies components["schemas"]["AnalysisListItem"][],
			);
		if (url.pathname === "/api/analyses/analysis-first/delete-impact")
			return Response.json({
				analysis_id: current.id,
				title,
				revision_count: 2,
				section_count: 4,
				occurrence_count: 3,
			} satisfies components["schemas"]["AnalysisDeleteImpact"]);
		if (url.pathname === "/api/analyses/analysis-first") {
			if (detailMode === "pending")
				return new Promise<Response>((resolve) => {
					releaseDetail = resolve;
				});
			if (detailMode === "error")
				return Response.json({ detail: "讲解读取失败" }, { status: 500 });
			return Response.json(
				url.searchParams.get("revision_id") === historical.revision_id
					? historical
					: current,
			);
		}
		if (url.pathname === "/api/analyses/analysis-second")
			return Response.json(second);
		throw new Error(`Unexpected analysis reading request ${url.pathname}`);
	});
	function Reading({
		initialId = null,
		initialRevision = null,
		segmentId = "analysis-segment",
		disabled = false,
	}: {
		initialId?: string | null;
		initialRevision?: string | null;
		segmentId?: string;
		disabled?: boolean;
	}) {
		const [selection, setSelection] = useState<[string | null, string | null]>([
			initialId,
			initialRevision,
		]);
		return (
			<div
				className="app-shell segment-study-shell"
				style={{ display: "block", padding: 16 }}
			>
				<div style={{ maxWidth: 760, margin: "0 auto" }}>
					<AnalysisPanel
						segmentId={segmentId}
						selectedId={selection[0]}
						revisionId={selection[1]}
						onSelect={(id, revision) => {
							selected.push([id, revision]);
							setSelection([id, revision]);
						}}
						onEdit={(document) => edits.push(document)}
						toolbarActions={
							<NewAnalysisActions
								disabled={disabled}
								onCreate={() => creates++}
								onExplain={() => generates++}
							/>
						}
					/>
					{!preview && (
						<button
							type="button"
							data-outside-create
							style={{ position: "fixed", bottom: 12, left: 12 }}
						>
							外部焦点
						</button>
					)}
				</div>
			</div>
		);
	}
	const button = (label: string, scope: ParentNode = container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent?.trim() === label,
		);
		check(
			found && !found.disabled,
			`Missing reachable analysis action ${label}`,
		);
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
	const menu = () => {
		const trigger = container.querySelector<HTMLButtonElement>(
			".analysis-menu-trigger",
		);
		check(trigger, "Selected analysis must expose its own more-actions menu");
		return trigger;
	};
	async function creationMenu() {
		const trigger = container.querySelector<HTMLButtonElement>(
			"#manual-analysis-create",
		);
		check(
			trigger &&
				!trigger.disabled &&
				container.querySelectorAll(".segment-new-analysis > button").length ===
					1,
			"The list must offer one creation-menu trigger and preserve its focus-return ID",
		);
		const before: [number, number, number] = [creates, generates, edits.length];
		const open = async () => {
			await until(
				() => trigger.getAttribute("aria-expanded") === "false",
				"Creation menu closure must settle before another user action",
			);
			trigger.focus();
			trigger.click();
			await until(
				() => !!container.querySelector(".segment-create-menu:popover-open"),
				"New analysis must open a menu before choosing a creation method",
			);
			await until(
				() => document.activeElement === button("自己编写"),
				"Opening creation choices must focus the first reachable menu item",
			);
			check(
				container.querySelector('.segment-create-menu[role="menu"]') &&
					container.querySelectorAll('.segment-create-menu [role="menuitem"]')
						.length === 2,
				"The creation menu must expose both choices with keyboard menu semantics",
			);
			check(
				JSON.stringify([creates, generates, edits.length]) ===
					JSON.stringify(before),
				"Opening creation choices must not create, generate or edit an Analysis",
			);
			const box = container
				.querySelector(".segment-create-menu")
				?.getBoundingClientRect();
			check(
				box && box.left >= -1 && box.right <= innerWidth + 1,
				"Creation choices must fit the narrow viewport",
			);
		};
		await open();
		key(button("自己编写"), "Escape");
		await until(
			() =>
				!container.querySelector(":popover-open") &&
				document.activeElement === trigger,
			"Escape must dismiss creation choices and restore their trigger",
		);
		await open();
		trigger.click();
		await until(
			() =>
				!container.querySelector(":popover-open") &&
				document.activeElement === trigger,
			"Toggling creation closed must preserve trigger focus",
		);
		await open();
		const outside = container.querySelector<HTMLButtonElement>(
			"[data-outside-create]",
		);
		const pointer = (
			window as unknown as {
				browserPointer: (
					events: {
						type: string;
						x: number;
						y: number;
						button: string;
						buttons: number;
						clickCount: number;
					}[],
				) => Promise<void>;
			}
		).browserPointer;
		check(
			outside && pointer,
			"Creation light-dismiss regression needs an external focus target and native pointer",
		);
		const bounds = outside.getBoundingClientRect();
		const x = bounds.left + bounds.width / 2,
			y = bounds.top + bounds.height / 2;
		await pointer([
			{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
			{
				type: "mouseReleased",
				x,
				y,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		]);
		await until(
			() =>
				!container.querySelector(":popover-open") &&
				document.activeElement === outside,
			`Outside clicks must dismiss creation choices without stealing focus from the clicked target: ${JSON.stringify({ bounds: bounds.toJSON(), focus: document.activeElement?.getAttribute("data-outside-create"), hit: document.elementFromPoint(x, y)?.tagName, open: Boolean(container.querySelector(":popover-open")) })}`,
		);
		await open();
		button("自己编写").click();
		await until(
			() =>
				creates === before[0] + 1 &&
				!container.querySelector(":popover-open") &&
				trigger.getAttribute("aria-expanded") === "false" &&
				document.activeElement === trigger,
			"Choosing manual creation must invoke only its callback and restore trigger focus",
		);
		check(
			generates === before[1] && edits.length === before[2],
			"Manual creation must not generate or edit an existing Analysis",
		);
		trigger.click();
		await until(
			() => !!container.querySelector(".segment-create-menu:popover-open"),
			"Creation choices must reopen for the independent AI action",
		);
		button("创建 AI 讲解").click();
		await until(
			() =>
				generates === before[1] + 1 &&
				!container.querySelector(":popover-open") &&
				document.activeElement === trigger,
			"Choosing AI creation must invoke only its callback and restore trigger focus",
		);
		check(
			creates === before[0] + 1 && edits.length === before[2],
			"AI creation must retain its independent callback",
		);
	}
	async function compactLayout(doc: AnalysisDetail) {
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);

		const article = container.querySelector<HTMLElement>(".analysis-document");
		const header = article?.querySelector<HTMLElement>(
			".analysis-document-header",
		);
		const heading = header?.querySelector<HTMLElement>(
			".analysis-document-title :is(h1,h2)",
		);
		const status = header?.querySelector<HTMLElement>(
			".analysis-revision-status",
		);
		const toc = article?.querySelector<HTMLElement>(".analysis-toc-disclosure");
		check(
			article && header && heading && status && toc,
			"Reading layout must retain document title, revision status and TOC",
		);
		check(
			article.getAttribute("aria-label") === doc.title,
			"The reading article must retain its independent Analysis name",
		);
		check(
			status.querySelector("span")?.textContent ===
				(doc.revision_id === doc.current_revision_id
					? "当前版本"
					: "历史版本（只读）") &&
				!article.querySelector(".analysis-historical-notice"),
			"Current and historical status must live with the document title without a separate banner",
		);
		check(
			header.querySelector(".analysis-document-heading")?.contains(status),
			"Revision status must remain inside the title heading group",
		);
		const back = header.querySelector<HTMLButtonElement>(
			'[aria-label="返回讲解列表"]',
		);
		check(
			back &&
				back.title === "返回讲解列表" &&
				!container.querySelector(
					".analysis-toolbar,#manual-analysis-create,.analysis-list",
				),
			"Reading must place an accessible list-return icon inside the document header and hide collection/new actions",
		);
		const backBox = back.getBoundingClientRect();
		const headerBox = header.getBoundingClientRect();
		const titleBox = heading.getBoundingClientRect();
		const actions = header.querySelector<HTMLElement>(
			".analysis-document-actions",
		);
		check(
			actions,
			"Document actions must remain grouped with the selected title",
		);
		const actionsBox = actions.getBoundingClientRect();
		check(
			backBox.right <= titleBox.left + 1 &&
				backBox.top >= headerBox.top - 1 &&
				backBox.bottom <= headerBox.bottom + 1,
			"Return icon and long title must share a header without overlap",
		);
		check(
			Math.min(titleBox.right, actionsBox.right) -
				Math.max(titleBox.left, actionsBox.left) <=
				1 ||
				Math.min(titleBox.bottom, actionsBox.bottom) -
					Math.max(titleBox.top, actionsBox.top) <=
					1,
			"Long document titles and their actions must not overlap",
		);
		for (const [name, node] of [
			["article", article],
			["header", header],
			["long title", heading],
			["revision status", status],
		] as const) {
			const box = node.getBoundingClientRect();
			check(
				box.left >= -1 &&
					box.right <= innerWidth + 1 &&
					node.scrollWidth <= node.clientWidth + 1,
				`${name} must remain readable without horizontal overflow at ${innerWidth}px`,
			);
		}
		const body = article.querySelector<HTMLElement>(".analysis-section");
		check(body, "Compact header must still lead to the original section body");
		const headerSpan = body.getBoundingClientRect().top - headerBox.top;
		const fixedSpace = headerSpan - titleBox.height;
		check(
			fixedSpace >= 0 && fixedSpace <= 120,
			`Navigation, revision status and TOC must fit the compact reading budget after allowing for title wrapping: ${JSON.stringify({ viewport: innerWidth, revision: doc.revision_id, headerSpan, titleHeight: titleBox.height, fixedSpace })}`,
		);
		for (const control of header.querySelectorAll<HTMLButtonElement>(
			'.analysis-document-actions > button,.analysis-revision-status button,[aria-label="返回讲解列表"]',
		)) {
			const box = control.getBoundingClientRect();
			check(
				!control.disabled &&
					box.width > 0 &&
					box.height > 0 &&
					box.left >= -1 &&
					box.right <= innerWidth + 1 &&
					getComputedStyle(control).visibility === "visible",
				"Document and historical revision actions must remain visible and reachable on narrow screens",
			);
			control.focus({ preventScroll: true });
			check(
				document.activeElement === control,
				"Document and historical revision actions must remain keyboard reachable",
			);
		}
		geometry.push(
			`${doc.revision_id === doc.current_revision_id ? "current" : "historical"}: header→body block ${headerSpan.toFixed(2)}px, excluding wrapped title ${fixedSpace.toFixed(2)}px`,
		);
	}
	async function versionInfo(doc: AnalysisDetail) {
		const trigger = menu();
		trigger.focus();
		key(trigger, "ArrowDown");
		await until(
			() => document.activeElement === button("版本信息"),
			"ArrowDown must open the version menu and focus its first action",
		);
		key(button("版本信息"), "ArrowDown");
		check(
			document.activeElement === button("重命名"),
			"Version menu ArrowDown must reach rename without activating it",
		);
		key(button("重命名"), "ArrowDown");
		check(
			document.activeElement === button("删除此讲解"),
			"Version menu ArrowDown must reach delete without activating it",
		);
		key(button("删除此讲解"), "Home");
		check(
			document.activeElement === button("版本信息"),
			"Version menu Home must return to version information",
		);
		key(button("版本信息"), "Escape");
		await until(
			() =>
				trigger.getAttribute("aria-expanded") === "false" &&
				document.activeElement === trigger,
			"Escape must close version menu and restore its trigger focus",
		);
		key(trigger, "ArrowDown");
		await until(
			() => document.activeElement === button("版本信息"),
			"Version menu must reopen by keyboard",
		);
		button("版本信息").click();
		await until(
			() => !!container.querySelector("dialog[open]"),
			"Version information must open a modal",
		);
		const details = new Map(
			[...container.querySelectorAll("dialog dt")].map((node) => [
				node.textContent,
				node.nextElementSibling?.textContent,
			]),
		);
		check(
			details.get("所读修订") === doc.revision_id &&
				details.get("当前修订") === doc.current_revision_id,
			"Version dialog must preserve the exact read/current revision identities",
		);
		check(
			container.querySelector(".analysis-version-title")?.textContent ===
				doc.title && details.get("讲解 ID") === doc.id,
			"Version information must identify its independent Analysis as well as both Revision identities",
		);
		check(
			container
				.querySelector("dialog")
				?.textContent?.includes(
					doc.revision_id === doc.current_revision_id
						? "正在阅读当前版本"
						: "正在阅读历史版本，此版本只读",
				),
			"Version dialog must correctly describe current versus historical revision",
		);
		button("关闭", container.querySelector("dialog") ?? container).click();
		await until(
			() =>
				!container.querySelector("dialog[open]") &&
				document.activeElement === trigger,
			"Closing version information must restore its analysis menu trigger",
		);
	}
	if (preview) {
		await mount(
			<Reading
				initialId={
					new URLSearchParams(location.search).has("list") ? null : current.id
				}
				initialRevision={
					new URLSearchParams(location.search).has("historical")
						? historical.revision_id
						: null
				}
			/>,
		);
		await until(
			() =>
				!!container.querySelector(
					new URLSearchParams(location.search).has("list")
						? ".analysis-list"
						: ".analysis-document",
				),
			"Analysis preview must open its requested independent reading/list view",
		);
		return "analysis reading preview: saved independent Analysis and Revision";
	}
	let dispose = await mount(<Reading />);
	try {
		await until(
			() => container.querySelectorAll(".analysis-list button").length === 2,
			"Multiple independent analyses must load as a list",
		);
		await creationMenu();
		const items = [
			...container.querySelectorAll<HTMLButtonElement>(".analysis-list button"),
		];
		items[1]?.click();
		await until(
			() => !!container.querySelector("#manual-analysis-edit-analysis-second"),
			"Second analysis list choice must open its own detail",
		);
		check(
			JSON.stringify(selected.at(-1)) === JSON.stringify([second.id, null]),
			"List selection must send the exact Analysis identity and current revision selection",
		);
		button("编辑").click();
		check(
			JSON.stringify(edits.at(-1)) === JSON.stringify(second),
			"Editing must receive the exact selected current document",
		);
		container
			.querySelector<HTMLButtonElement>('[aria-label="返回讲解列表"]')
			?.click();
		await until(
			() => !!container.querySelector(".analysis-list"),
			"Back must return to the independent analysis list",
		);
		check(
			JSON.stringify(selected.at(-1)) === "[null,null]",
			"Back must clear Analysis and Revision identity together",
		);
		container
			.querySelector<HTMLButtonElement>(".analysis-list button")
			?.click();
		await until(
			() => !!container.querySelector("#manual-analysis-edit-analysis-first"),
			"First analysis must open with an editable current revision",
		);
		const article = container.querySelector<HTMLElement>(".analysis-document");
		check(article, "Selected analysis must render its own article");
		check(
			creates === 1 &&
				generates === 1 &&
				!container.querySelector("#manual-analysis-create"),
			"Reading an existing Analysis must not offer creation or implicitly create/generate",
		);
		await compactLayout(current);
		check(
			article.querySelectorAll("h1").length === 1 &&
				article.querySelector("h1")?.textContent === title,
			"Markdown title extraction must render one title only",
		);
		check(
			article.querySelector(
				"#analysis-section-title-section.analysis-document-header",
			) && article.querySelector("#analysis-section-vocabulary-section"),
			"Title extraction must preserve both title and body Section anchors",
		);
		check(
			article.textContent?.includes("标题所属段落的正文。") &&
				article.textContent.includes("文脈に応じて意味を考える。"),
			"Title extraction must retain complete original Markdown body content",
		);
		const toc = article.querySelector<HTMLDetailsElement>(
			".analysis-toc-disclosure",
		);
		check(
			toc,
			"Saved Section identities must remain available in the table of contents",
		);
		toc.open = true;
		check(
			[...toc.querySelectorAll("a")]
				.map((node) => node.getAttribute("href"))
				.join("|") ===
				"#analysis-section-title-section|#analysis-section-vocabulary-section",
			"TOC must retain exact Section anchor destinations",
		);
		await versionInfo(current);
		menu().click();
		await until(
			() => menu().getAttribute("aria-expanded") === "true",
			"Delete action menu must open",
		);
		button("删除此讲解").click();
		await until(
			() =>
				container.querySelector("dialog")?.textContent?.includes("2 个修订") ===
				true,
			"Delete confirmation must read the affected revision count",
		);
		check(
			container.querySelector("dialog")?.textContent?.includes("4 个讲解块") &&
				container
					.querySelector("dialog")
					?.textContent?.includes("3 个关联学习条目"),
			"Delete confirmation must retain section and occurrence impact",
		);
		button("取消", container.querySelector("dialog") ?? container).click();
		await until(
			() => !container.querySelector("dialog[open]"),
			"Cancel must leave the independent analysis saved and visible",
		);
		check(
			!!container.querySelector(".analysis-document") && writes.length === 0,
			"Reading and cancelling deletion must not call any write API",
		);
	} finally {
		dispose();
	}
	dispose = await mount(
		<Reading
			initialId={historical.id}
			initialRevision={historical.revision_id}
		/>,
	);
	try {
		await until(
			() => container.textContent?.includes("历史版本（只读）") === true,
			"Historical revision must explicitly remain read-only",
		);
		check(
			!container.querySelector("[id^='manual-analysis-edit-']"),
			"Historical revision must not offer editing",
		);
		await compactLayout(historical);
		await versionInfo(historical);
		button("查看当前版本").click();
		await until(
			() => !!container.querySelector("#manual-analysis-edit-analysis-first"),
			"Viewing current must return to editable current revision",
		);
		check(
			JSON.stringify(selected.at(-1)) === JSON.stringify([current.id, null]),
			"Viewing current must keep Analysis identity and clear only the historical revision selection",
		);
	} finally {
		dispose();
	}
	dispose = await mount(
		<Reading segmentId="other-segment" initialId={current.id} />,
	);
	try {
		await until(
			() => container.textContent?.includes("这份讲解不属于当前片段") === true,
			"A mismatched Segment detail must be rejected",
		);
		check(
			!container.querySelector(
				".analysis-document,.analysis-menu-trigger,[id^='manual-analysis-edit-']",
			),
			"Cross-Segment detail must not expose body or mutation actions",
		);
		const back = container.querySelector<HTMLButtonElement>(
			'[aria-label="返回讲解列表"]',
		);
		check(
			back &&
				!container.querySelector(".analysis-list,#manual-analysis-create"),
			"Mismatched selected detail must keep a return action without automatically opening list/creation",
		);
		back.click();
		await until(
			() => !!container.querySelector(".analysis-list"),
			"Explicit return must recover from a mismatched Segment",
		);
	} finally {
		dispose();
	}
	for (const mode of ["pending", "error"] as const) {
		detailMode = mode;
		dispose = await mount(<Reading initialId={current.id} />);
		try {
			await until(
				() =>
					mode === "pending"
						? !!releaseDetail &&
							container.textContent?.includes("正在打开讲解") === true
						: container.textContent?.includes("重试打开讲解") === true,
				"Selected detail loading/error state must remain explicit",
			);
			const back = container.querySelector<HTMLButtonElement>(
				'[aria-label="返回讲解列表"]',
			);
			check(
				back && !back.disabled && back.title === "返回讲解列表",
				"Loading and failed detail must retain an accessible return-to-list action",
			);
			check(
				!container.querySelector(
					".analysis-document,.analysis-list,#manual-analysis-create,.segment-create-menu",
				),
				"Loading and failed selections must not expose a stale document, creation menu or automatic list",
			);
			back.click();
			await until(
				() => !!container.querySelector(".analysis-list"),
				"Explicit list return must recover from loading and failed selections",
			);
			check(
				JSON.stringify(selected.at(-1)) === "[null,null]",
				"Error/loading return must clear Analysis and Revision together",
			);
		} finally {
			releaseDetail?.(Response.json(current));
			releaseDetail = undefined;
			detailMode = "normal";
			dispose();
		}
	}
	for (const disabled of [false, true]) {
		const before: [number, number] = [creates, generates];
		dispose = await mount(<Reading disabled={disabled} />);
		try {
			await until(
				() => !!container.querySelector("#manual-analysis-create"),
				"Creation gates must mount the same stable trigger",
			);
			const trigger = container.querySelector<HTMLButtonElement>(
				"#manual-analysis-create",
			);
			check(
				trigger && trigger.disabled === disabled,
				"The overall disabled gate must apply to the creation trigger",
			);
			trigger.click();
			if (disabled) {
				check(
					!container.querySelector(":popover-open"),
					"Disabled creation must not open a menu",
				);
			} else {
				await until(
					() => !!container.querySelector(".segment-create-menu:popover-open"),
					"Generation-disabled creation must still allow manual creation choices",
				);
				const generate = [
					...container.querySelectorAll<HTMLButtonElement>(
						".segment-create-menu button",
					),
				].find((node) => node.textContent?.trim() === "创建 AI 讲解");
				check(
					generate && !generate.disabled && !button("自己编写").disabled,
					"Available material must allow both manual writing and AI explanation",
				);
				button("自己编写").focus();
				key(button("自己编写"), "ArrowDown");
				check(
					document.activeElement === generate,
					"Keyboard navigation must reach the AI explanation option",
				);
				generate.click();
				check(
					generates === before[1] + 1,
					"AI explanation must call its own callback once",
				);
			}
			check(
				generates === before[1] + (disabled ? 0 : 1) && creates === before[0],
				"Creation gates must preserve independent callbacks without writes",
			);
		} finally {
			dispose();
		}
	}
	check(
		JSON.stringify([current, second, historical]) === rawBefore &&
			writes.length === 0,
		"Reading presentation must not mutate stored Markdown, revisions or API state",
	);
	await savedAnalysisFocus(h);
	return `analysis reading ${innerWidth}px: exact Analysis/Revision callbacks, current edit and historical read-only, complete version info, keyboard creation/versions, gated choices and light dismiss, cancel deletion, title deduplication and Section anchors, cross-Segment/loading/error return; read-only browsing plus explicit mocked manual save/cancel focus; ${geometry.join("; ")}`;
}

async function savedAnalysisFocus(h: BrowserHarness) {
	const { SegmentDetail } = await import("../src/SegmentPage");
	const { container, mount, mock, until, inputValue } = h;
	const check: BrowserHarness["check"] = h.check;
	const segment: components["schemas"]["SegmentResponse"] = {
		id: "focus-segment",
		source_id: "focus-source",
		text: "保存後の焦点を確認する。",
		translation: "",
		context_before: "",
		context_after: "",
		transcription: "",
		source_ref: "",
		note: "",
		material_provenance: null,
		revision: 1,
		text_sha256: "f".repeat(64),
		text_locked_at: null,
		created_at: current.created_at,
		updated_at: current.updated_at,
	};
	const sourceMd = "# 焦点测试讲解\n\n手写保存后的完整正文。";
	const saved: AnalysisDetail = {
		...current,
		id: "saved-focus-analysis",
		segment_id: segment.id,
		title: "焦点测试讲解",
		source_md: sourceMd,
		current_revision_id: "saved-focus-revision",
		revision_id: "saved-focus-revision",
		parent_revision_id: null,
		sections: [
			{
				id: "saved-focus-section",
				uid: "saved-focus-uid",
				handle: "focus",
				kind: "section",
				title: "焦点测试讲解",
				display_no: "1",
				start_line: 1,
				end_line: 3,
				raw: sourceMd,
			},
		],
	};
	let posts = 0;
	mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (
			request.method === "POST" &&
			path === "/api/segments/focus-segment/analyses"
		) {
			const body: components["schemas"]["ManualAnalysisCreate"] =
				await request.json();
			check(
				body.source_md === sourceMd &&
					body.expected_text_sha256 === segment.text_sha256 &&
					body.origin === "manual",
				"Focus integration must save only the explicit manual draft against its Segment snapshot",
			);
			posts++;
			return Response.json(saved);
		}
		check(
			request.method === "GET",
			`Focus integration must not perform any other write or model operation: ${request.method} ${path}`,
		);
		if (path === "/api/segments/focus-segment") return Response.json(segment);
		if (path === "/api/sources/focus-source")
			return Response.json({
				id: segment.source_id,
				title: "焦点测试来源",
				description: "",
				note: "",
				created_at: segment.created_at,
				updated_at: segment.updated_at,
			});
		if (path === "/api/segments/focus-segment/analyses")
			return Response.json(posts ? [saved] : []);
		if (path === "/api/segments/focus-segment/translation-results")
			return Response.json([]);
		if (path === "/api/analyses/saved-focus-analysis")
			return Response.json(saved);
		throw new Error(`Unexpected saved-focus integration request ${path}`);
	});
	const dispose = await mount(
		<SegmentDetail />,
		"/segments/:id",
		"/segments/focus-segment",
	);
	const action = (label: string, scope: ParentNode = container) => {
		const button = [
			...scope.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.trim() === label);
		check(button && !button.disabled, `Missing saved-focus action ${label}`);
		return button;
	};
	try {
		await until(
			() => !!container.querySelector("#manual-analysis-create"),
			"Real Segment list must expose its creation trigger",
		);
		const trigger = container.querySelector<HTMLButtonElement>(
			"#manual-analysis-create",
		);
		check(
			trigger,
			"Manual editor focus return requires the stable creation trigger",
		);
		const open = async () => {
			trigger.focus({ preventScroll: true });
			trigger.click();
			await until(
				() => !!container.querySelector(".segment-create-menu:popover-open"),
				"Real Segment must open creation choices before editing",
			);
			action("自己编写").click();
			await until(
				() => !!container.querySelector(".analysis-editor-dialog[open] form"),
				"Manual choice must open the real analysis editor",
			);
		};
		await open();
		action(
			"取消",
			container.querySelector(".analysis-editor-dialog[open]") ?? container,
		).click();
		await until(
			() =>
				!container.querySelector("dialog[open]") &&
				document.activeElement === trigger,
			"Cancelling manual creation must restore the still-mounted creation trigger",
		);
		check(posts === 0, "Cancelling manual creation must not save a draft");
		await open();
		const titleField = container.querySelector<HTMLInputElement>(
			".analysis-editor-dialog[open] input",
		);
		const source = container.querySelector<HTMLTextAreaElement>(
			".analysis-editor-dialog[open] textarea",
		);
		check(
			titleField && source,
			"Real manual editor must expose title and original Markdown inputs",
		);
		inputValue(titleField, saved.title);
		inputValue(source, sourceMd);
		await until(
			() =>
				!container.querySelector<HTMLButtonElement>(
					".analysis-editor-dialog[open] button[type='submit']",
				)?.disabled,
			"Explicit manual draft must become savable",
		);
		container
			.querySelector<HTMLFormElement>(".analysis-editor-dialog[open] form")
			?.requestSubmit();
		await until(
			() =>
				posts === 1 &&
				!container.querySelector("dialog[open]") &&
				!!container.querySelector(".analysis-document"),
			"Saving manual analysis must open its independent saved document",
		);
		await until(
			() =>
				document.activeElement ===
				container.querySelector("#analysis-list-return"),
			`Saving must focus the new document's list-return control after its creation trigger unmounts: ${JSON.stringify({ focus: document.activeElement?.id || document.activeElement?.tagName, targetMounted: Boolean(container.querySelector("#analysis-list-return")) })}`,
		);
		check(
			!container.querySelector("#manual-analysis-create") &&
				container
					.querySelector(".analysis-document")
					?.getAttribute("aria-label") === saved.title &&
				container.textContent?.includes("手写保存后的完整正文。"),
			"Saved document must retain its identity and body while hiding collection creation controls",
		);
	} finally {
		dispose();
	}
}
