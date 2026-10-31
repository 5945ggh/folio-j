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
	const pending: { import?: () => void; selection?: () => void } = {};
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
	localStorage.clear();
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
		fit();
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
	return `dictionary settings ${innerWidth}px: empty/existing library, ZIP progress, additional install, import/selection failure retention, single active choice and reopen persistence`;
}
