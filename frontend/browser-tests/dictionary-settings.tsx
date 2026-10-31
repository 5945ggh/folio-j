import { startAppTheme } from "../src/theme/browser";
import { THEME_STORAGE_KEY } from "../src/theme/preference";
import type { BrowserHarness } from "./harness";

const meikyo = {
	dictionary_id: "meikyo",
	title: "明鏡日漢双解辞典",
	revision: "2026.1",
	entry_count: 125000,
};
const other = {
	dictionary_id: "other",
	title: "別の日本語辞典・長い名称でも設定画面から選べる辞典",
	revision: "2",
	entry_count: 23000,
};

/** Real settings page with delayed, failed and persisted local dictionary requests. */
export async function dictionarySettings(h: BrowserHarness) {
	const params = new URLSearchParams(location.search);
	const { SettingsPage } = await import("../src/settings/SettingsPage");
	const check: BrowserHarness["check"] = h.check;
	let library = {
		dictionaries: [] as (typeof meikyo)[],
		active_dictionary_id: null as string | null,
	};
	let reads = 0;
	let imports = 0;
	let failImport = false;
	let failSelection = false;
	let holdImport = false;
	let holdSelection = false;
	let failDelete = false;
	let holdDelete = false;
	const deletions: { id: string; replacement: string | null }[] = [];
	const pending: {
		import?: () => void;
		selection?: () => void;
		delete?: () => void;
	} = {};
	const selected: string[] = [];
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/api/dictionary/library") {
			reads++;
			return Response.json(library);
		}
		if (
			request.method === "POST" &&
			path === "/api/dictionary/library/import"
		) {
			imports++;
			check(
				request.headers.get("content-type") === "application/zip" &&
					(await request.text()) === "offline dictionary fixture",
				"Import must send the selected ZIP bytes to the library endpoint",
			);
			if (holdImport)
				await new Promise<void>((resolve) => {
					pending.import = resolve;
				});
			if (failImport)
				return Response.json(
					{ detail: "这份词典暂不支持导入。" },
					{ status: 422 },
				);
			const dictionary = library.dictionaries.length ? other : meikyo;
			library = {
				dictionaries: [...library.dictionaries, dictionary],
				active_dictionary_id:
					library.active_dictionary_id ?? dictionary.dictionary_id,
			};
			return Response.json({
				library,
				dictionary_id: dictionary.dictionary_id,
				already_installed: false,
			});
		}
		if (
			request.method === "PUT" &&
			path === "/api/dictionary/library/selection"
		) {
			const body: unknown = await request.json();
			check(
				typeof body === "object" &&
					body !== null &&
					"dictionary_id" in body &&
					typeof body.dictionary_id === "string" &&
					Object.keys(body).join() === "dictionary_id",
				"Selection must submit exactly the selected dictionary identity",
			);
			selected.push(body.dictionary_id);
			if (holdSelection)
				await new Promise<void>((resolve) => {
					pending.selection = resolve;
				});
			if (failSelection)
				return Response.json(
					{ detail: "词典选择保存失败，请重试。" },
					{ status: 503 },
				);
			library = { ...library, active_dictionary_id: body.dictionary_id };
			return Response.json(library);
		}
		if (
			request.method === "DELETE" &&
			path.startsWith("/api/dictionary/library/")
		) {
			const id = path.split("/").at(-1) ?? "";
			const replacement = new URL(request.url).searchParams.get(
				"replacement_dictionary_id",
			);
			deletions.push({ id, replacement });
			if (holdDelete)
				await new Promise<void>((resolve) => {
					pending.delete = resolve;
				});
			if (failDelete)
				return Response.json(
					{ detail: "词典删除失败，请重试。" },
					{ status: 503 },
				);
			check(
				library.active_dictionary_id !== id ||
					library.dictionaries.length === 1 ||
					library.dictionaries.some(
						(item) =>
							item.dictionary_id === replacement && item.dictionary_id !== id,
					),
				"Deleting the current dictionary must atomically select an explicitly chosen replacement",
			);
			library = {
				dictionaries: library.dictionaries.filter(
					(item) => item.dictionary_id !== id,
				),
				active_dictionary_id:
					library.active_dictionary_id === id
						? replacement
						: library.active_dictionary_id,
			};
			return Response.json(library);
		}
		throw new Error(`Unexpected dictionary settings ${request.method} ${path}`);
	});
	const find = <T extends Element>(selector: string): T => {
		const node = h.container.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const radio = (title: string) =>
		find<HTMLInputElement>(`input[type="radio"][aria-label="使用${title}"]`);
	const picker = () =>
		find<HTMLInputElement>('input[aria-label="选择词典 ZIP"]');
	const upload = async () => {
		await h.until(
			() => !picker().disabled,
			"The dictionary ZIP picker must be available",
		);
		const file = new File(["offline dictionary fixture"], "dictionary.zip", {
			type: "application/zip",
		});
		const transfer = new DataTransfer();
		transfer.items.add(file);
		const input = picker();
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const ready = () =>
		h.until(
			() =>
				!!h.container.querySelector('input[aria-label="选择词典 ZIP"]:enabled'),
			"Dictionary settings must open directly",
		);
	const fit = () => {
		const content = find<HTMLElement>(".settings-content");
		check(
			content.scrollWidth <= content.clientWidth + 1 &&
				document.documentElement.scrollWidth <= innerWidth + 1,
			`Dictionary settings must fit the ${innerWidth}px viewport`,
		);
	};
	const emptyState = () => {
		const empty = find<HTMLElement>(".dictionary-empty");
		const style = getComputedStyle(empty);
		check(
			parseFloat(style.paddingTop) >= 30 &&
				parseFloat(style.paddingInlineStart) >= 18,
			"Empty dictionary card must preserve generous padding inside the settings group",
		);
		check(
			!h.container.querySelector("#installed-dictionaries") &&
				[...h.container.querySelectorAll("button")].filter((button) =>
					button.textContent?.includes("导入词典"),
				).length === 1 &&
				empty.querySelector("#dictionary-import") &&
				empty.textContent?.includes("Yomitan format 3"),
			"An empty library must show one import action and format guidance inside the card, without an installed count",
		);
		fit();
	};
	const openDelete = async (dictionary: typeof meikyo) => {
		find<HTMLButtonElement>(
			`#dictionary-menu-${dictionary.dictionary_id}`,
		).click();
		await h.until(
			() => !!h.container.querySelector(".dictionary-menu:popover-open"),
			"Dictionary more menu must open",
		);
		find<HTMLButtonElement>(".dictionary-menu:popover-open button").click();
		await h.until(
			() => !!h.container.querySelector(".dictionary-delete-dialog[open]"),
			"Delete must open a confirmation",
		);
		check(
			find<HTMLElement>(".dictionary-delete-dialog").textContent?.includes(
				"之后可以重新导入",
			),
			"Delete confirmation must explain local removal and reimport",
		);
		fit();
	};
	const confirmDelete = () =>
		find<HTMLButtonElement>(".dictionary-delete-dialog .danger");
	const refreshDelete = async () => {
		const refresh = [
			...h.container.querySelectorAll<HTMLButtonElement>(
				".dictionary-delete-dialog button",
			),
		].find((button) => button.textContent === "刷新词典列表");
		check(refresh, "Delete failures must offer a library refresh");
		refresh.click();
		await h.until(() => !refresh.disabled, "Library refresh must finish");
	};
	const cancelDelete = async () => {
		find<HTMLButtonElement>(
			".dictionary-delete-dialog [data-dialog-cancel]",
		).click();
		await h.until(
			() => !h.container.querySelector(".dictionary-delete-dialog"),
			"Cancel must close deletion confirmation",
		);
	};
	localStorage.clear();
	localStorage.setItem(
		THEME_STORAGE_KEY,
		params.get("theme") === "dark" ? "dark" : "light",
	);
	startAppTheme().select(params.get("theme") === "dark" ? "dark" : "light");
	let dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=dictionary",
	);
	try {
		await ready();
		await h.until(() => reads === 1, "Empty library must be read");
		check(
			find<HTMLAnchorElement>(
				'nav[aria-label="设置分类"] a[href="/settings?section=dictionary"]',
			).getAttribute("aria-current") === "page" &&
				!h.container.querySelector("#model-defaults-form,.provider-settings"),
			"Dictionary must be its own active settings category",
		);
		check(
			h.container.querySelectorAll('input[type="radio"]').length === 0,
			"An empty library must not invent an installed dictionary",
		);
		emptyState();
		holdImport = true;
		await upload();
		await h.until(
			() => !!pending.import,
			"Import must start after choosing a ZIP",
		);
		await h.until(
			() =>
				picker().disabled &&
				/正在.*(导入|索引|建立)/.test(h.container.textContent ?? ""),
			"Import must visibly show progress and prevent duplicate uploads",
		);
		check(
			imports === 1 && library.dictionaries.length === 0,
			"Pending import must not replace the empty library",
		);
		pending.import?.();
		holdImport = false;
		await h.until(
			() =>
				!!h.container.querySelector('input[aria-label="使用明鏡日漢双解辞典"]'),
			"The first imported dictionary must appear",
		);
		check(
			radio(meikyo.title).checked,
			"The first dictionary must become active",
		);
		fit();
	} finally {
		dispose();
	}
	// A fresh query client models reopening settings against the persisted library.
	dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=dictionary",
	);
	try {
		await ready();
		await h.until(
			() =>
				!!h.container.querySelector('input[aria-label="使用明鏡日漢双解辞典"]'),
			"An existing Meikyo installation must be listed",
		);
		check(
			radio(meikyo.title).checked && imports === 1,
			"Reopening must restore the active dictionary without reimporting",
		);
		await upload();
		await h.until(
			() => h.container.querySelectorAll('input[type="radio"]').length === 2,
			"A different supported dictionary must be added alongside Meikyo",
		);
		check(
			radio(meikyo.title).checked && !radio(other.title).checked,
			"Adding another dictionary must preserve the user's selection",
		);
		fit();
		failImport = true;
		await upload();
		await h.until(
			() =>
				h.container.textContent?.includes("这份词典暂不支持导入。") === true,
			"A failed import must explain the failure",
		);
		check(
			h.container.querySelectorAll('input[type="radio"]').length === 2 &&
				radio(meikyo.title).checked &&
				!picker().disabled,
			"Import failure must retain both installed dictionaries and the selected one",
		);
		holdSelection = true;
		radio(other.title).click();
		await h.until(
			() => !!pending.selection,
			"Choosing a dictionary must immediately start saving",
		);
		check(
			radio(meikyo.title).checked && !radio(other.title).checked,
			"Pending selection must continue showing the saved active dictionary",
		);
		check(
			[
				...h.container.querySelectorAll<HTMLInputElement>(
					'input[type="radio"]',
				),
			].every((input) => input.matches(":disabled")),
			"Pending selection must prevent competing saves",
		);
		pending.selection?.();
		holdSelection = false;
		await h.until(
			() => radio(other.title).checked && !radio(other.title).disabled,
			"Successful selection must display the newly active dictionary",
		);
		check(
			!radio(meikyo.title).checked &&
				library.active_dictionary_id === other.dictionary_id,
			"Exactly one installed dictionary must be active",
		);
		failSelection = true;
		radio(meikyo.title).click();
		await h.until(
			() =>
				h.container.textContent?.includes("词典选择保存失败，请重试。") ===
				true,
			"Failed selection must expose the save error",
		);
		check(
			radio(other.title).checked &&
				!radio(meikyo.title).checked &&
				!radio(meikyo.title).disabled,
			"Failed selection must retain the last saved dictionary and allow retry",
		);
		fit();
	} finally {
		dispose();
	}
	dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=dictionary",
	);
	try {
		await ready();
		await h.until(
			() => h.container.querySelectorAll('input[type="radio"]').length === 2,
			"Reopened library must read both persisted installations",
		);
		check(
			radio(other.title).checked && !radio(meikyo.title).checked,
			"Reopening must restore the successful selection despite the later failed save",
		);
		check(
			selected.join() === "other,meikyo" &&
				Number(imports) === 3 &&
				reads === 3,
			"Library reads, imports and immediate selections must each run exactly once",
		);
	} finally {
		dispose();
	}
	// Removal has its own confirmation and must preserve the saved choice on failure.
	dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=dictionary",
	);
	try {
		await ready();
		await openDelete(meikyo);
		check(
			radio(other.title).checked &&
				!radio(meikyo.title).checked &&
				selected.join() === "other,meikyo",
			"Opening a row menu and deletion confirmation must not select that dictionary",
		);
		check(
			!h.container.querySelector(".dictionary-delete-dialog select"),
			"Deleting an inactive dictionary must not ask for a replacement",
		);
		await cancelDelete();
		check(
			deletions.length === 0 && Number(library.dictionaries.length) === 2,
			"Cancel must leave the library untouched",
		);
		await openDelete(meikyo);
		failDelete = true;
		holdDelete = true;
		confirmDelete().click();
		await h.until(
			() => !!pending.delete,
			"Confirmed removal must start one delete request",
		);
		check(
			confirmDelete().disabled &&
				picker().disabled &&
				[
					...h.container.querySelectorAll<HTMLInputElement>(
						'input[type="radio"]',
					),
				].every((input) => input.matches(":disabled")),
			"Pending removal must disable confirmation, imports and competing selection",
		);
		confirmDelete().click();
		const leaving = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(leaving);
		check(
			leaving.defaultPrevented && Number(deletions.length) === 1,
			"Pending removal must protect leaving and prevent duplicate requests",
		);
		find<HTMLDialogElement>(".dictionary-delete-dialog").dispatchEvent(
			new Event("cancel", { cancelable: true }),
		);
		check(
			!!h.container.querySelector(".dictionary-delete-dialog[open]"),
			"Pending removal cannot dismiss its confirmation",
		);
		pending.delete?.();
		holdDelete = false;
		await h.until(
			() =>
				h.container
					.querySelector(".dictionary-delete-dialog")
					?.textContent?.includes("词典删除失败") === true,
			"Delete failure must remain in the confirmation for retry",
		);
		check(
			radio(other.title).checked &&
				!confirmDelete().disabled &&
				Number(library.dictionaries.length) === 2,
			"Failed removal must preserve both installations and the current selection",
		);
		failDelete = false;
		confirmDelete().click();
		await h.until(
			() =>
				!h.container.querySelector(".dictionary-delete-dialog") &&
				h.container.querySelectorAll('input[type="radio"]').length === 1,
			"Retry must remove only the inactive dictionary",
		);
		check(
			radio(other.title).checked &&
				deletions.every(
					(entry) => entry.id === "meikyo" && entry.replacement === null,
				),
			"Removing an inactive dictionary must preserve the current dictionary without sending a replacement",
		);
	} finally {
		dispose();
	}
	library = {
		dictionaries: [meikyo, other],
		active_dictionary_id: other.dictionary_id,
	};
	dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=dictionary",
	);
	try {
		await ready();
		await openDelete(other);
		const replacement = find<HTMLSelectElement>(
			".dictionary-delete-dialog select",
		);
		check(
			replacement.value === "" &&
				confirmDelete().disabled &&
				replacement.closest(".native-select"),
			"Removing the current dictionary must require an explicit replacement using the shared native select",
		);
		const beforeSelection = deletions.length;
		confirmDelete().click();
		check(
			deletions.length === beforeSelection,
			"An unselected replacement must prevent deletion",
		);
		replacement.value = meikyo.dictionary_id;
		replacement.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() => !confirmDelete().disabled,
			"An explicit replacement must enable removal",
		);
		failDelete = true;
		confirmDelete().click();
		await h.until(
			() =>
				h.container
					.querySelector(".dictionary-delete-dialog")
					?.textContent?.includes("词典删除失败") === true,
			"Failed current-dictionary removal must remain retryable",
		);
		check(
			find<HTMLSelectElement>(".dictionary-delete-dialog select").value ===
				"meikyo" && radio(other.title).checked,
			"A failed removal must retain the explicit replacement and last saved current dictionary",
		);
		library = {
			dictionaries: [
				other,
				{ ...meikyo, dictionary_id: "backup", title: "予備辞典" },
			],
			active_dictionary_id: other.dictionary_id,
		};
		await refreshDelete();
		await h.until(
			() =>
				find<HTMLSelectElement>(".dictionary-delete-dialog select").value ===
					"" && confirmDelete().disabled,
			"Refreshing a removed replacement must clear that choice and prevent a stale submission",
		);
		library = {
			dictionaries: [meikyo, other],
			active_dictionary_id: other.dictionary_id,
		};
		await refreshDelete();
		await h.until(
			() =>
				!!h.container.querySelector(
					'.dictionary-delete-dialog option[value="meikyo"]',
				),
			"Refreshed replacement options must be visible before choosing one",
		);
		const restoredReplacement = find<HTMLSelectElement>(
			".dictionary-delete-dialog select",
		);
		restoredReplacement.value = meikyo.dictionary_id;
		restoredReplacement.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() => !confirmDelete().disabled,
			"A fresh explicit replacement must allow retry after refreshing",
		);
		failDelete = false;
		confirmDelete().click();
		await h.until(
			() =>
				!h.container.querySelector(".dictionary-delete-dialog") &&
				radio(meikyo.title).checked,
			"Successful current-dictionary removal must atomically show its chosen replacement",
		);
		check(
			deletions.at(-1)?.id === "other" &&
				deletions.at(-1)?.replacement === "meikyo" &&
				library.dictionaries.length === 1,
			"The delete endpoint must receive the replacement in the same request",
		);
		await openDelete(meikyo);
		check(
			find<HTMLElement>(".dictionary-delete-dialog").textContent?.includes(
				"删除后将不能即时查词",
			) && !h.container.querySelector(".dictionary-delete-dialog select"),
			"Deleting the final dictionary must explain loss of instant lookup",
		);
		confirmDelete().click();
		await h.until(
			() =>
				!!h.container.querySelector(".dictionary-empty") &&
				!h.container.querySelector(".dictionary-delete-dialog"),
			"Deleting the final dictionary must return to the import card",
		);
		check(
			library.active_dictionary_id === null &&
				Number(library.dictionaries.length) === 0 &&
				!!localStorage.getItem("folio-j:dictionary-library-changed"),
			"Successful removal must update the library and notify other tabs",
		);
		emptyState();
	} finally {
		dispose();
	}
	if (params.has("capture") || params.has("preview")) {
		library =
			params.get("scene") === "delete"
				? {
						dictionaries: [meikyo, other],
						active_dictionary_id: other.dictionary_id,
					}
				: { dictionaries: [], active_dictionary_id: null };
		await h.mount(
			<SettingsPage />,
			"/settings",
			"/settings?section=dictionary",
		);
		await ready();
		if (params.get("scene") === "delete") await openDelete(other);
		else emptyState();
		await Promise.allSettled(
			document.getAnimations().map((animation) => animation.finished),
		);
		check(
			document.documentElement.dataset.theme ===
				(params.get("theme") === "dark" ? "dark" : "light"),
			"Dictionary scenes must render their requested application theme",
		);
	}
	return `dictionary settings ${innerWidth}px: empty/existing library, ZIP progress, additional install, import/selection failure retention, single active choice, reopen persistence, removal confirmation/cancel, inactive removal, required replacement, pending protection, failure retry and final removal`;
}
