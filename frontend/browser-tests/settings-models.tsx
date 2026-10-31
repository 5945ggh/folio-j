import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	ModelInput,
	Provider,
	Settings,
	SettingsPatch,
} from "../src/settings/api";
import type {
	SegmentContextSettings,
	SegmentContextSettingsUpdate,
} from "../src/settings/segment-context-api";
import type { BrowserHarness } from "./harness";
import { settingsConnectionHistory } from "./settings-connection-history";
import { provider, settings } from "./workbench";

/** Exercise settings navigation and saves with every API request kept offline. */
export async function settingsModels(h: BrowserHarness) {
	const { SettingsPage } = await import("../src/settings/SettingsPage");
	const { settingsKeys } = await import("../src/settings/api");
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
	let failModelSave = false;
	let failPermissionSave = false;
	const registrations: ModelInput[] = [];
	let failRegistration = true;
	let verificationRequests = 0;
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
		if (path.endsWith("/verifications")) {
			verificationRequests++;
			throw new Error("Registration must never trigger model verification");
		}
		if (
			request.method === "POST" &&
			path === "/api/providers/provider/models"
		) {
			const input = (await request.json()) as ModelInput;
			registrations.push(input);
			if (input.model_id === "retry-model" && failRegistration)
				return Response.json({ detail: "离线模拟登记失败" }, { status: 503 });
			const current = providers[0];
			const template = provider.models[0];
			check(
				current && template,
				"Registration fixture must have a provider and model",
			);
			const saved = {
				...template,
				...input,
				id: `registered-${input.model_id}`,
				text_status: "unknown" as const,
				stream_status: "unknown" as const,
			};
			providers = [{ ...current, models: [...current.models, saved] }];
			return Response.json(saved);
		}
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
			if (failModelSave && patch.defaults?.chat_model_id)
				return Response.json(
					{ detail: "离线模拟模型保存失败" },
					{ status: 503 },
				);
			if (failPermissionSave && patch.defaults?.permission_mode)
				return Response.json({ detail: "离线模拟保存失败" }, { status: 503 });
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
			tab("模型配置").getAttribute("aria-current") === "page" &&
				!h.container.querySelector(".provider-settings") &&
				!h.container.querySelector('a[href="/settings?section=history"]'),
			"Defaults must be active and show neither service management nor its history tools",
		);
		let finishModelSave!: () => void;
		holdPatch = new Promise((resolve) => {
			finishModelSave = resolve;
		});
		choose("model-two");
		await h.until(
			() => h.container.textContent?.includes("正在保存…") === true,
			"Selecting a default must start saving immediately",
		);
		tab("服务管理").click();
		check(
			!guard(),
			"A pending model selection should finish before navigation",
		);
		finishModelSave();
		holdPatch = undefined;
		await h.until(
			() => !!h.container.querySelector(".provider-settings"),
			"Successful autosave should resume navigation",
		);
		const patch = patches[0];
		check(
			patches.length === 1 &&
				patch &&
				Object.keys(patch).join() === "defaults" &&
				Object.keys(patch.defaults ?? {}).join() === "chat_model_id" &&
				patch.defaults?.chat_model_id === "model-two",
			"Changing the discussion default must save only that model selection",
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
		tab("模型配置").click();
		await waitGuard();
		await dismissGuard("继续编辑");
		check(
			name.isConnected && name.value === "尚未保存的新服务",
			"Cancelling service-to-default navigation must preserve the provider draft",
		);
		tab("模型配置").click();
		await waitGuard();
		await dismissGuard("放弃修改");
		await h.until(
			() => !!h.container.querySelector("#model-defaults-form"),
			"Discarding provider draft must return to defaults",
		);
		check(
			find<HTMLSelectElement>("#model-defaults-form select").value ===
				"model-two",
			"Returning to model configuration must show the saved selection",
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
	providers = [
		{
			...structuredClone(provider),
			discovered_models: [
				"offline-model",
				"new-model",
				"retry-model",
				"draft-model",
			],
			discovery_status: "succeeded",
		},
	];
	dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=providers",
	);
	try {
		await h.until(
			() => !!h.container.querySelector("#provider-open-provider"),
			"Registration setup must load services",
		);
		find<HTMLButtonElement>("#provider-open-provider").click();
		await h.until(
			() => !!document.querySelector(".provider-detail-dialog"),
			"Registration setup must open service details",
		);
		const registration = () =>
			[
				...document.querySelectorAll<HTMLElement>('dialog, [role="dialog"]'),
			].find(
				(node) =>
					node.textContent?.includes("从列表选择") &&
					node.textContent?.includes("手动填写"),
			);
		const openRegistration = async () => {
			const node = [
				...document.querySelectorAll<HTMLButtonElement>(
					".provider-detail-dialog button",
				),
			].find(
				(item) => item.textContent?.replace("＋", "").trim() === "登记模型",
			);
			check(node, "Service models must offer one registration entry");
			node.click();
			await h.until(
				() => !!registration(),
				"Registration must open one dialog with list and manual modes",
			);
			const dialog = registration();
			check(dialog, "Registration dialog must exist");
			return dialog;
		};
		const modelChoice = (id: string) => {
			const label = [
				...(registration()?.querySelectorAll(".provider-discovery-item") ?? []),
			].find((node) => node.querySelector("span")?.textContent?.trim() === id);
			const input = label?.querySelector<HTMLInputElement>(
				'input[type="checkbox"]',
			);
			check(input, `Missing discovered model choice ${id}`);
			return input;
		};
		const modeGuard = () =>
			[...document.querySelectorAll("button")].some(
				(node) => node.textContent?.trim() === "放弃并切换",
			);
		const switchDirtyMode = async (
			dialog: HTMLElement,
			mode: string,
			decision: string,
		) => {
			button(mode, dialog).click();
			await h.until(
				modeGuard,
				"Changing registration mode must guard its draft",
			);
			button(decision).click();
			await h.until(() => !modeGuard(), "Mode confirmation must finish");
		};
		let dialog = await openRegistration();
		check(
			!dialog.querySelector('input:not([type="checkbox"])'),
			"Registration must begin in list selection mode",
		);
		check(
			modelChoice("offline-model").disabled &&
				modelChoice("offline-model").checked,
			"Already registered models must remain checked and disabled",
		);
		modelChoice("new-model").click();
		modelChoice("retry-model").click();
		await h.until(
			() => dialog.textContent?.includes("登记所选模型（2）") === true,
			"Registration action must count selected models",
		);
		button("登记所选模型（2）", dialog).click();
		await h.until(
			() => dialog.textContent?.includes("未成功") === true,
			"Partial registration failure must stay in the dialog",
		);
		check(
			registrations.map((item) => item.model_id).join() ===
				"new-model,retry-model" && modelChoice("retry-model").checked,
			"Partial success must write each selection once and preserve failed selections",
		);
		check(
			modelChoice("new-model").disabled && modelChoice("new-model").checked,
			"Successful registrations must become disabled registered items",
		);
		failRegistration = false;
		button("登记所选模型（1）", dialog).click();
		await h.until(
			() => !registration(),
			"Successful retry must return to the registered model list",
		);
		check(
			registrations.map((item) => item.model_id).join() ===
				"new-model,retry-model,retry-model",
			"Retry must submit only failed models",
		);
		check(
			document
				.querySelector(".provider-model-list")
				?.textContent?.includes("retry-model"),
			"Successful retry must appear in registered models",
		);
		dialog = await openRegistration();
		modelChoice("draft-model").click();
		await switchDirtyMode(dialog, "手动填写", "继续编辑");
		check(
			modelChoice("draft-model").checked,
			"Continuing list editing must retain selected models",
		);
		await switchDirtyMode(dialog, "手动填写", "放弃并切换");
		const manualId = () => {
			const label = [...(registration()?.querySelectorAll("label") ?? [])].find(
				(node) => node.textContent?.includes("上游模型 ID"),
			);
			return label?.querySelector<HTMLInputElement>("input");
		};
		await h.until(
			() => !!manualId(),
			"Discarding selection must open manual entry",
		);
		const id = manualId();
		check(id, "Manual registration must label the upstream model ID");
		const advanced = [
			...dialog.querySelectorAll<HTMLDetailsElement>("details"),
		].find(
			(node) =>
				node.querySelector("summary")?.textContent?.trim() === "高级设置",
		);
		check(
			advanced && !advanced.open,
			"Manual registration must initially collapse native advanced settings",
		);
		h.inputValue(id, "manual-draft");
		await switchDirtyMode(dialog, "从列表选择", "继续编辑");
		check(
			manualId()?.value === "manual-draft",
			"Continuing manual entry must preserve the model ID",
		);
		tab("模型配置").click();
		await waitGuard();
		await dismissGuard("继续编辑");
		check(
			manualId()?.value === "manual-draft",
			"Cancelling navigation must preserve the registration draft",
		);
		await switchDirtyMode(dialog, "从列表选择", "放弃并切换");
		await h.until(
			() => !manualId(),
			"Discarding manual entry must return to list mode",
		);
		check(
			!modelChoice("draft-model").checked,
			"Discarded list selection must not reappear",
		);
		button("手动填写", dialog).click();
		await h.until(
			() => !!manualId(),
			"A clean list must switch without confirmation",
		);
		const freshId = manualId();
		check(
			freshId && freshId.value === "",
			"Discarded manual input must not reappear",
		);
		h.inputValue(freshId, "manual-model");
		button("登记模型", dialog).click();
		await h.until(
			() => !registration(),
			"Manual registration success must return to model list",
		);
		check(
			registrations.at(-1)?.model_id === "manual-model" &&
				registrations.length === 4,
			"Only explicitly submitted registrations may be persisted",
		);
		check(
			verificationRequests === 0,
			"Registration, retry and navigation must never start verification",
		);
	} finally {
		dispose();
	}
	providers = [provider];
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
		holdPatch = undefined;
		find<HTMLAnchorElement>(
			'.settings-tabs a[href="/settings?section=permissions"]',
		).click();
		await h.until(
			() => !!h.container.querySelector('input[name="permission"]'),
			"The permissions tab must show the default mode choices",
		);
		check(
			!h.container.querySelector('.settings-savebar, button[type="submit"]'),
			"Permission selection must not require a save button",
		);
		const permissionPatchStart = patches.length;
		let finishPermissionSave!: () => void;
		holdPatch = new Promise((resolve) => {
			finishPermissionSave = resolve;
		});
		find<HTMLInputElement>('input[value="full_access"]').click();
		await h.until(
			() => h.container.textContent?.includes("正在保存…") === true,
			"Selecting full access must immediately start saving",
		);
		find<HTMLInputElement>('input[value="review"]').click();
		finishPermissionSave();
		holdPatch = undefined;
		await h.until(
			() =>
				patches.length === permissionPatchStart + 2 &&
				h.container.textContent?.includes("已自动保存") === true,
			"Rapid permission changes must save the final selection in order",
		);
		check(
			persisted.defaults.permission_mode === "review" &&
				find<HTMLInputElement>('input[value="review"]').checked &&
				patches
					.slice(permissionPatchStart)
					.every(
						(patch) =>
							Object.keys(patch).join() === "defaults" &&
							Object.keys(patch.defaults ?? {}).join() === "permission_mode",
					),
			"Permission autosave must retain the last choice and only patch its field",
		);
		failPermissionSave = true;
		find<HTMLInputElement>('input[value="full_access"]').click();
		await h.until(
			() => !!h.container.querySelector('[role="alert"]'),
			"A failed permission save must show an error",
		);
		check(
			find<HTMLInputElement>('input[value="full_access"]').checked &&
				persisted.defaults.permission_mode === "review",
			"A failed save must keep the chosen mode as an unsaved draft",
		);
		failPermissionSave = false;
		button("重试保存").click();
		await h.until(
			() =>
				persisted.defaults.permission_mode === "full_access" &&
				h.container.textContent?.includes("已自动保存") === true &&
				!h.container.querySelector('[role="alert"]'),
			"Retry must persist the selected permission and clear its error",
		);
		await h.until(
			() => !h.container.textContent?.includes("已自动保存"),
			"The autosave success message must disappear after a short delay",
		);
		check(
			find<HTMLInputElement>('input[value="full_access"]').checked,
			"Dismissing the success message must retain the saved permission",
		);
		find<HTMLInputElement>('input[value="review"]').click();
		await h.until(
			() =>
				persisted.defaults.permission_mode === "review" &&
				h.container.textContent?.includes("已自动保存") === true,
			"A subsequent save must show its own fresh success message",
		);
	} finally {
		dispose();
	}
	persisted = {
		...persisted,
		defaults: {
			...persisted.defaults,
			analysis_model_id: "model",
			chat_model_id: "model",
		},
	};
	providers = [structuredClone(provider)];
	const modelClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	dispose = await h.mount(
		<QueryClientProvider client={modelClient}>
			<SettingsPage />
		</QueryClientProvider>,
		"/settings",
		"/settings?section=models",
	);
	try {
		await h.until(
			() => !!h.container.querySelector("#model-defaults-form"),
			"Model retry setup must load defaults",
		);
		failModelSave = true;
		choose("model-two");
		await h.until(
			() => h.container.textContent?.includes("离线模拟模型保存失败") === true,
			"Failed model selection must retain a retryable draft",
		);
		persisted = {
			...persisted,
			defaults: { ...persisted.defaults, analysis_model_id: "model-two" },
		};
		modelClient.setQueryData(settingsKeys.settings, persisted);
		const selections = () =>
			h.container.querySelectorAll<HTMLSelectElement>(
				"#model-defaults-form select",
			);
		check(
			selections()[0]?.value === "model-two" &&
				selections()[1]?.value === "model",
			"A settings refresh must preserve the unsaved model draft",
		);
		const retryPatchStart = patches.length;
		failModelSave = false;
		button("重试保存").click();
		await h.until(
			() =>
				patches.length === retryPatchStart + 1 &&
				h.container.textContent?.includes("已自动保存") === true,
			"Model retry must finish successfully",
		);
		check(
			Object.keys(patches[retryPatchStart]?.defaults ?? {}).join() ===
				"chat_model_id" &&
				persisted.defaults.analysis_model_id === "model-two" &&
				selections()[1]?.value === "model-two",
			"Retry must save only the edited purpose and adopt the other purpose's newer value",
		);
		let finishQueuedModels!: () => void;
		holdPatch = new Promise((resolve) => {
			finishQueuedModels = resolve;
		});
		choose("model");
		await h.until(
			() => h.container.textContent?.includes("正在保存…") === true,
			"The first model selection must enter the save queue",
		);
		const analysis = selections()[1];
		check(analysis, "Legacy model selection must remain available");
		analysis.value = "model";
		analysis.dispatchEvent(new Event("change", { bubbles: true }));
		choose("model-two");
		finishQueuedModels();
		holdPatch = undefined;
		await h.until(
			() =>
				patches.length === retryPatchStart + 3 &&
				h.container.textContent?.includes("已自动保存") === true,
			"Queued model edits must save their final choices",
		);
		check(
			persisted.defaults.chat_model_id === "model-two" &&
				String(persisted.defaults.analysis_model_id) === "model" &&
				selections()[0]?.value === "model-two" &&
				selections()[1]?.value === "model",
			"The queue must retain both purposes and the latest discussion selection",
		);
		failModelSave = true;
		choose("model");
		await h.until(
			() => h.container.textContent?.includes("离线模拟模型保存失败") === true,
			"Another failed selection must remain discardable",
		);
		button("放弃修改").click();
		await h.until(
			() =>
				selections()[0]?.value === "model-two" &&
				!h.container.querySelector('[role="alert"]'),
			"Discard must restore the persisted model and clear the failure",
		);
		failModelSave = false;
		let finishRevertedModel!: () => void;
		holdPatch = new Promise((resolve) => {
			finishRevertedModel = resolve;
		});
		const revertedPatchStart = patches.length;
		choose("model");
		await h.until(
			() => h.container.textContent?.includes("正在保存…") === true,
			"A model change must remain pending before the original choice is restored",
		);
		choose("model-two");
		persisted = {
			...persisted,
			defaults: { ...persisted.defaults, chat_model_id: "model" },
		};
		modelClient.setQueryData(settingsKeys.settings, persisted);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		check(
			selections()[0]?.value === "model-two",
			"A refresh during pending saves must preserve the queued return to the original choice",
		);
		finishRevertedModel();
		holdPatch = undefined;
		await h.until(
			() =>
				patches.length === revertedPatchStart + 2 &&
				h.container.textContent?.includes("已自动保存") === true,
			"The final original choice must finish saving without an unsaved draft",
		);
		check(
			String(persisted.defaults.chat_model_id) === "model-two" &&
				selections()[0]?.value === "model-two" &&
				!h.container.textContent?.includes("有未保存的修改"),
			"The final saved model and visible selection must agree after the refresh",
		);
		failModelSave = true;
		choose("model");
		await h.until(
			() => h.container.textContent?.includes("离线模拟模型保存失败") === true,
			"A failed edit must retain the choice before another settings refresh",
		);
		persisted = {
			...persisted,
			defaults: { ...persisted.defaults, chat_model_id: "model" },
		};
		modelClient.setQueryData(settingsKeys.settings, persisted);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		choose("model-two");
		check(
			selections()[0]?.value === "model-two",
			"An explicit selection of the previous baseline must retain the user's choice",
		);
		failModelSave = false;
		button("重试保存").click();
		await h.until(
			() =>
				String(persisted.defaults.chat_model_id) === "model-two" &&
				h.container.textContent?.includes("已自动保存") === true &&
				selections()[0]?.value === "model-two",
			"Retrying the explicit baseline choice must synchronize the model and clear the draft",
		);
		failModelSave = true;
		let finishFailedReversion!: () => void;
		holdPatch = new Promise((resolve) => {
			finishFailedReversion = resolve;
		});
		choose("model");
		await h.until(
			() => h.container.textContent?.includes("正在保存…") === true,
			"The failing first write must be pending before its queued reversion",
		);
		choose("model-two");
		persisted = {
			...persisted,
			defaults: { ...persisted.defaults, chat_model_id: "model" },
		};
		modelClient.setQueryData(settingsKeys.settings, persisted);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
		finishFailedReversion();
		holdPatch = undefined;
		await h.until(
			() => h.container.textContent?.includes("离线模拟模型保存失败") === true,
			"Failure must stop the queued save without replacing the latest choice",
		);
		check(
			selections()[0]?.value === "model-two" &&
				h.container.textContent?.includes("有未保存的修改"),
			"The restored choice must remain unsaved against the confirmed remote model after failure",
		);
		tab("服务管理").click();
		await waitGuard();
		await dismissGuard("继续编辑");
		failModelSave = false;
		button("重试保存").click();
		await h.until(
			() =>
				String(persisted.defaults.chat_model_id) === "model-two" &&
				h.container.textContent?.includes("已自动保存") === true &&
				selections()[0]?.value === "model-two",
			"Retry must save the protected final choice after the first write failed",
		);
	} finally {
		failModelSave = false;
		holdPatch = undefined;
		dispose();
		modelClient.clear();
	}
	await settingsConnectionHistory(h);
	return "settings defaults to learning without last-category memory; explicit model/service settings: default autosave and navigation, provider draft navigation guard, unified list/manual registration, partial registration retry, registration mode draft protection, service management, legacy history entry/return, empty-model recovery, learning preference copy/control layout, isolated connection/credential saves, scoped history recovery/filter clearing, and failure-first expandable call details";
}
