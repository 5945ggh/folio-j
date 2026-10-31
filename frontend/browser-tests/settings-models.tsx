import type { Provider, Settings, SettingsPatch } from "../src/settings/api";
import type {
	SegmentContextSettings,
	SegmentContextSettingsUpdate,
} from "../src/settings/segment-context-api";
import type { BrowserHarness } from "./harness";
import { provider, settings } from "./workbench";

/** Exercise settings navigation and saves with every API request kept offline. */
export async function settingsModels(h: BrowserHarness) {
	const { SettingsPage } = await import("../src/settings/SettingsPage");
	const check: BrowserHarness["check"] = h.check;
	const find = <T extends Element>(selector: string): T => {
		const node = document.querySelector<T>(selector);
		check(node, `Missing ${selector}`);
		return node;
	};
	const button = (label: string, scope: ParentNode = document) => {
		const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(item) => item.textContent?.trim() === label,
		);
		check(node && !node.disabled, `Missing enabled button ${label}`);
		return node;
	};
	const tab = (label: string) => {
		const node = [
			...h.container.querySelectorAll<HTMLAnchorElement>(
				'nav[aria-label="模型与服务分类"] a',
			),
		].find((item) => item.textContent?.trim() === label);
		check(node, `Missing model/service tab ${label}`);
		return node;
	};
	const choose = (value: string) => {
		const select = find<HTMLSelectElement>("#model-defaults-form select");
		select.value = value;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		return select;
	};
	const guard = () => document.querySelector(".settings-leave-dialog");
	const waitGuard = () =>
		h.until(() => !!guard(), "Switching panels must guard unsaved edits");
	const dismissGuard = async (label: string) => {
		const dialog = guard();
		check(dialog, "Missing unsaved changes dialog");
		button(label, dialog).click();
		await h.until(() => !guard(), `Guard must finish ${label}`);
	};
	let persisted: Settings = structuredClone(settings);
	const patches: SettingsPatch[] = [];
	let providers: Provider[] = [provider];
	let holdPatch: Promise<void> | undefined;
	let context: SegmentContextSettings = {
		enabled: true,
		before_sentences: 1,
		after_sentences: 1,
		before_characters: 200,
		after_characters: 200,
		revision: 0,
	};
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/api/settings")
			return Response.json(persisted);
		if (request.method === "GET" && path === "/api/providers")
			return Response.json(providers);
		if (request.method === "GET" && path === "/api/runs")
			return Response.json([]);
		if (path === "/api/settings/segment-context") {
			if (request.method === "GET") return Response.json(context);
			if (request.method === "PUT") {
				const { expected_revision, ...changes } =
					(await request.json()) as SegmentContextSettingsUpdate;
				check(
					expected_revision === context.revision,
					"Context saves must use the accepted revision",
				);
				context = { ...changes, revision: expected_revision + 1 };
				return Response.json(context);
			}
		}
		if (request.method === "PATCH" && path === "/api/settings") {
			const patch = (await request.json()) as SettingsPatch;
			if (holdPatch) await holdPatch;
			patches.push(patch);
			persisted = {
				...persisted,
				profile: patch.profile ?? persisted.profile,
				defaults: { ...persisted.defaults, ...patch.defaults },
			};
			return Response.json(persisted);
		}
		throw new Error(`Unmocked settings request ${request.method} ${path}`);
	});
	let dispose = await h.mount(<SettingsPage />, "/settings", "/settings");
	try {
		await h.until(
			() => !!h.container.querySelector("#learning-settings-form"),
			"The general settings entry must open learning preferences",
		);
		check(
			h.container
				.querySelector('.settings-tabs a[aria-current="page"]')
				?.getAttribute("href") === "/settings?section=learning" &&
				!h.container.querySelector(".settings-page-head p") &&
				!h.container.querySelector("#model-defaults-form"),
			"Learning must be the active first category with a concise heading",
		);
		find<HTMLAnchorElement>('a[href="/settings?section=models"]').click();
		await h.until(
			() => !!h.container.querySelector("#model-defaults-form"),
			"The explicit models entry must open default models",
		);
		check(
			tab("默认模型").getAttribute("aria-current") === "page" &&
				!h.container.querySelector(".provider-settings") &&
				!h.container.querySelector('a[href="/settings?section=history"]'),
			"Defaults must be active and show neither service management nor its history tools",
		);
		const select = choose("model-two");
		await h.until(
			() => !!h.container.querySelector(".settings-dirty"),
			"Selecting a model must register an unsaved default",
		);
		tab("服务管理").click();
		await waitGuard();
		await dismissGuard("继续编辑");
		check(
			select.isConnected && select.value === "model-two",
			"Cancelling a panel switch must preserve the edited default",
		);
		button("保存默认模型").click();
		await h.until(
			() =>
				h.container
					.querySelector(".settings-savebar")
					?.textContent?.includes("已保存") === true,
			"Defaults must save through their own save action",
		);
		const patch = patches[0];
		check(
			patches.length === 1 &&
				patch &&
				Object.keys(patch).join() === "defaults" &&
				Object.keys(patch.defaults ?? {})
					.sort()
					.join() === "analysis_model_id,chat_model_id" &&
				patch.defaults?.analysis_model_id === "model-two" &&
				patch.defaults.chat_model_id === "model",
			"Saving default models must update only the two model defaults",
		);
		choose("model");
		await h.until(
			() => !!h.container.querySelector(".settings-dirty"),
			"Second edit must become dirty",
		);
		tab("服务管理").click();
		await waitGuard();
		await dismissGuard("放弃修改");
		await h.until(
			() => !!h.container.querySelector(".provider-settings"),
			"Discarding must reach service management",
		);
		check(
			tab("服务管理").getAttribute("aria-current") === "page" &&
				!h.container.querySelector("#model-defaults-form") &&
				!h.container.querySelector('button[form="model-defaults-form"]'),
			"Service management must have no default model form or save bar",
		);
		find<HTMLButtonElement>("#provider-open-provider").click();
		await h.until(
			() => !!document.querySelector(".provider-detail-dialog"),
			"Service list must still open management details",
		);
		find<HTMLButtonElement>('button[aria-label="关闭服务详情"]').click();
		await h.until(
			() => !document.querySelector(".provider-detail-dialog"),
			"Service details must close",
		);
		button("添加服务").click();
		await h.until(
			() => !!document.querySelector(".provider-editor-dialog input"),
			"Service management must retain its add-service editor",
		);
		const name = find<HTMLInputElement>(".provider-editor-dialog input");
		h.inputValue(name, "尚未保存的新服务");
		tab("默认模型").click();
		await waitGuard();
		await dismissGuard("继续编辑");
		check(
			name.isConnected && name.value === "尚未保存的新服务",
			"Cancelling service-to-default navigation must preserve the provider draft",
		);
		tab("默认模型").click();
		await waitGuard();
		await dismissGuard("放弃修改");
		await h.until(
			() => !!h.container.querySelector("#model-defaults-form"),
			"Discarding provider draft must return to defaults",
		);
		check(
			find<HTMLSelectElement>("#model-defaults-form select").value ===
				"model-two",
			"Discarded default edits must not replace the saved value",
		);
		tab("服务管理").click();
		await h.until(
			() => !!h.container.querySelector(".provider-settings"),
			"Saved defaults must allow switching without a guard",
		);
		find<HTMLAnchorElement>('a[href="/settings?section=history"]').click();
		await h.until(
			() => !!h.container.querySelector(".provider-run-history"),
			"The existing verification history link must still work",
		);
		check(
			tab("服务管理").getAttribute("aria-current") === "page",
			"History must belong to service management",
		);
		find<HTMLAnchorElement>(".settings-back-link").click();
		await h.until(
			() => !!h.container.querySelector(".provider-settings"),
			"History must return to service management",
		);
		check(
			!h.container.querySelector("#model-defaults-form"),
			"History return must not open default models",
		);
		check(
			patches.length === 1,
			"Discarding drafts and navigating must not write settings",
		);
		find<HTMLAnchorElement>('.app-navigation a[href="/settings"]').click();
		await h.until(
			() => !!h.container.querySelector("#learning-settings-form"),
			"Returning through general settings must reset to learning preferences",
		);
	} finally {
		dispose();
	}
	// Old bookmarks must work when loaded directly, without prior in-app navigation.
	for (const entry of [
		"/settings?section=providers",
		"/settings?section=history",
	]) {
		dispose = await h.mount(<SettingsPage />, "/settings", entry);
		try {
			await h.until(
				() =>
					!!h.container.querySelector(
						entry.includes("history")
							? ".provider-run-history"
							: ".provider-settings",
					),
				`Direct entry ${entry} must load`,
			);
			check(
				tab("服务管理").getAttribute("aria-current") === "page",
				"Direct service/history entry must select service management",
			);
		} finally {
			dispose();
		}
	}
	for (const configuration of [[], [{ ...provider, enabled: false }]]) {
		providers = configuration;
		dispose = await h.mount(
			<SettingsPage />,
			"/settings",
			"/settings?section=models",
		);
		try {
			await h.until(
				() => !!h.container.querySelector("#model-defaults-form"),
				"Empty configuration must still show defaults",
			);
			const entry = [
				...h.container.querySelectorAll<HTMLAnchorElement>(
					".settings-content a",
				),
			].find((link) => link.textContent?.includes("前往服务管理"));
			check(entry, "No usable models must offer a service management entry");
			entry.click();
			await h.until(
				() => !!h.container.querySelector(".provider-settings"),
				"The empty-model recovery entry must reach service setup",
			);
			check(
				configuration.length
					? !!h.container.querySelector("#provider-open-provider")
					: !!h.container.querySelector(".provider-empty"),
				"Recovery must show the configured services or the add-service empty state",
			);
			check(
				patches.length === 1,
				"Empty-model recovery must not change saved defaults",
			);
		} finally {
			dispose();
		}
	}
	dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=learning",
	);
	try {
		await h.until(
			() => !!h.container.querySelector("#learning-settings-form input"),
			"Learning preferences must render their real controls",
		);
		const form = find<HTMLFormElement>("#learning-settings-form");
		const rows = form.querySelectorAll<HTMLElement>(".settings-preference-row");
		check(rows.length === 3, "Learning background must contain all three rows");
		for (const row of rows) {
			const copy = row.querySelector<HTMLElement>(".settings-row-copy");
			const control = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(
				"input, textarea",
			);
			check(
				copy && control,
				"Each preference must retain its copy and control",
			);
			const bounds = row.getBoundingClientRect();
			const field = control.getBoundingClientRect();
			check(
				field.width > 100 &&
					field.left >= bounds.left - 1 &&
					field.right <= bounds.right + 1 &&
					row.scrollWidth <= row.clientWidth + 1,
				`${control.tagName}: learning control must fit its ${innerWidth}px row`,
			);
			const description = copy.getBoundingClientRect();
			if (innerWidth > 620) {
				check(
					description.width >= 120 && description.right <= field.left,
					`Learning copy must remain readable beside ${control.tagName} at ${innerWidth}px`,
				);
			} else {
				check(
					description.bottom <= field.top &&
						Math.abs(description.width - field.width) <= 1,
					"On narrow screens, each field must fill the row below its description",
				);
			}
		}
		check(
			document.documentElement.scrollWidth <= innerWidth + 1,
			"Learning preferences must not overflow the viewport",
		);
		const note = find<HTMLTextAreaElement>("#learning-settings-form textarea");
		note.focus();
		h.inputValue(note, "能看懂短句");
		note.blur();
		await h.until(
			() => persisted.profile.level_note === "能看懂短句",
			"Finishing a profile field saves it",
		);
		find<HTMLInputElement>('input[name="default-style"]:not(:checked)').click();
		await h.until(
			() => persisted.defaults.style_id === null,
			"Selecting a preset saves immediately",
		);
		const toggle = find<HTMLInputElement>(
			'#segment-context-settings-form [role="switch"]',
		);
		toggle.click();
		await h.until(
			() => !context.enabled,
			"Switching off saves the context preference",
		);
		const limit = find<HTMLInputElement>(
			"#segment-context-settings-form input[type=number]",
		);
		check(
			limit.getBoundingClientRect().width > 0,
			"Context limits must remain visible",
		);
		limit.focus();
		h.inputValue(limit, "");
		limit.blur();
		await h.until(
			() =>
				!!h.container.querySelector(
					"#segment-context-settings-form [role=alert]",
				),
			"An empty limit must show a validation message",
		);
		check(context.before_sentences === 1, "Invalid context must remain local");
		limit.focus();
		h.inputValue(limit, "0");
		limit.blur();
		await h.until(
			() => context.before_sentences === 0,
			"A corrected zero limit must save on blur",
		);
		let finishPatch!: () => void;
		holdPatch = new Promise((resolve) => {
			finishPatch = resolve;
		});
		find<HTMLInputElement>('input[name="default-style"]:not(:checked)').click();
		await h.until(
			() => form.parentElement?.textContent?.includes("正在保存…") === true,
			"The in-flight autosave must remain visible",
		);
		find<HTMLAnchorElement>(
			'.settings-tabs a[href="/settings?section=appearance"]',
		).click();
		check(
			form.isConnected && !guard(),
			"Pending autosave must retain the page without a confirmation",
		);
		finishPatch();
		await h.until(
			() => !!h.container.querySelector("#appearance-heading"),
			"Navigation should resume after the preference is saved",
		);
		check(
			persisted.defaults.style_id === "style",
			"Leaving must retain the selected preset",
		);
	} finally {
		dispose();
	}
	return "settings defaults to learning without last-category memory; explicit model/service settings: default save isolation, both draft navigation guards, service management, legacy history entry/return, empty-model recovery, and learning preference copy/control layout";
}
