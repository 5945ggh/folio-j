import type { Source } from "../src/content";
import type { BrowserHarness } from "./harness";
import "../src/catalog/import-dialog.css";
import "../src/catalog/source-content.css";
import "../src/catalog/sources-s2.css";

export async function sourceOnboarding(h: BrowserHarness): Promise<string> {
	const { SourceIndex } = await import("../src/SourcePages");
	const { MaterialsPage } = await import("../src/catalog/MaterialsPage");
	const { container, until, inputValue, mount, mock } = h;
	const check: BrowserHarness["check"] = h.check;
	let sources: Source[] = [];
	let created: { title: string; description: string; note: string } | null =
		null;
	const createdRequest = () => created;
	mock(async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/api/sources")
			return Response.json(sources);
		if (request.method === "GET" && url.pathname === "/api/catalog/sources")
			return Response.json({
				items: sources,
				total: sources.length,
				page: 1,
				page_size: Number(url.searchParams.get("page_size") ?? 50),
			});
		if (request.method === "GET" && url.pathname === "/api/materials")
			return Response.json({
				items: [],
				total: 0,
				page: 1,
				page_size: Number(url.searchParams.get("page_size") ?? 50),
			});
		if (request.method === "POST" && url.pathname === "/api/sources") {
			const body = (await request.json()) as {
				title: string;
				description: string;
				note: string;
			};
			created = body;
			const source: Source = {
				id: "first-source",
				title: body.title,
				description: body.description,
				note: body.note,
				segment_count: 0,
				created_at: "2026-11-08T00:00:00Z",
				updated_at: "2026-11-08T00:00:00Z",
			};
			sources = [source, ...sources];
			return Response.json(source, { status: 201 });
		}
		throw new Error(
			`Unexpected onboarding request ${request.method} ${url.pathname}`,
		);
	});
	const action = (label: string, scope: ParentNode = container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
		);
		check(
			found && !found.disabled,
			`Missing enabled onboarding action ${label}`,
		);
		return found;
	};
	const openDialog = () =>
		container.querySelector<HTMLDialogElement>("dialog[open]");
	const cancelDialog = async () => {
		const dialog = openDialog();
		check(dialog, "Expected an open dialog");
		action("取消", dialog).click();
		await until(() => !openDialog(), "Cancel must close the dialog");
	};

	localStorage.clear();
	const disposeSources = await mount(<SourceIndex />, "*", "/sources");
	try {
		await until(
			() => !!container.querySelector(".s2-welcome"),
			"Zero-source source space must explain its starting point",
		);
		const welcome = container.querySelector<HTMLElement>(".s2-welcome");
		check(welcome, "Missing zero-source welcome");
		check(
			welcome.textContent?.includes("创建来源后") ?? false,
			"Zero-source welcome must point at source creation",
		);
		const welcomeCreate = action("新建来源", welcome);
		welcomeCreate.click();
		await until(
			() => !!container.querySelector("#create-source-title"),
			"Welcome CTA must open the source form",
		);
		await cancelDialog();
		check(
			document.activeElement === welcomeCreate,
			"Cancelling source creation must restore focus to the welcome CTA",
		);

		if (innerWidth > 900) {
			const directoryCreate = action(
				"新建来源",
				container.querySelector(".s2-directory-empty") ?? container,
			);
			directoryCreate.click();
			await until(
				() => !!container.querySelector("#create-source-title"),
				"Directory CTA must open the source form",
			);
			await cancelDialog();
			check(
				document.activeElement === directoryCreate,
				"Cancelling source creation must restore focus to the directory CTA",
			);
		}
	} finally {
		disposeSources();
	}

	const disposeMaterials = await mount(<MaterialsPage />, "*", "/materials");
	try {
		await until(
			() => !!container.querySelector("#library-empty-import"),
			"Empty library must keep its import entry",
		);
		const importArea = container.querySelector<HTMLButtonElement>(
			"#library-empty-import",
		);
		check(importArea, "Missing empty-library import entry");
		importArea.click();
		await until(
			() => !!container.querySelector(".import-source-empty"),
			"Import without sources must explain how to continue",
		);
		const dialog = openDialog();
		check(dialog, "Missing empty-source import dialog");
		check(
			dialog
				.querySelector(".import-source-empty")
				?.textContent?.includes("还没有来源") ?? false,
			"Empty-source import view must name the missing source",
		);
		check(
			!dialog.querySelector("select"),
			"Empty-source import view must not offer an unusable source select",
		);
		const importButton = [
			...dialog.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.trim() === "导入");
		check(
			importButton?.disabled,
			"Empty-source import must keep Import disabled",
		);
		const emptyAction = dialog.querySelector<HTMLButtonElement>(
			"button.import-source-empty",
		);
		check(emptyAction, "The whole empty-source region must be a button");
		emptyAction.click();
		await until(
			() =>
				container.querySelector("#import-title")?.textContent === "新建来源",
			"Empty-source CTA must open the new-source view",
		);
		const name = container.querySelector<HTMLInputElement>(
			".import-source-view input[required]",
		);
		check(name, "New-source view must expose the source name");
		await until(
			() => document.activeElement === name,
			"New-source view must focus the source name",
		);
		action("返回添加书籍").click();
		await until(
			() => document.activeElement === emptyAction,
			"Returning without sources must focus the whole-region CTA",
		);
		emptyAction.click();
		await until(
			() =>
				document.activeElement?.matches(".import-source-view input") ?? false,
			"Reopening source creation must focus its name",
		);
		const reopenedName = container.querySelector<HTMLInputElement>(
			".import-source-view input[required]",
		);
		check(reopenedName, "Missing reopened source name");
		inputValue(reopenedName, "最初の来源");
		action("创建来源").click();
		await until(
			() =>
				container.querySelector("#import-title")?.textContent === "添加书籍",
			"Creating a source must return to the import view",
		);
		const request = createdRequest();
		check(request, "Source creation request must arrive");
		check(
			request.title === "最初の来源",
			"Source creation must submit its name",
		);
		const select = container.querySelector<HTMLSelectElement>(
			".import-dialog select",
		);
		check(select, "Returning to import must restore the source select");
		await until(
			() => select.value === "first-source",
			"New source must be selected after creation",
		);
		await until(
			() => document.activeElement === select,
			"Returning to import must focus the selected source",
		);
		await cancelDialog();
		check(
			document.activeElement instanceof HTMLElement &&
				document.activeElement.id === "library-empty-import",
			`Closing the import dialog must restore the empty-library entry (active: ${document.activeElement?.outerHTML.slice(0, 160)})`,
		);
		return `source onboarding: zero-source welcome and directory CTA, empty-source import CTA, created source selected (${innerWidth}px)`;
	} finally {
		disposeMaterials();
	}
}
