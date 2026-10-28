import type { Provider, Settings, SettingsPatch } from "../src/settings/api";
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
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/api/settings")
			return Response.json(persisted);
		if (request.method === "GET" && path === "/api/providers")
			return Response.json(providers);
		if (request.method === "GET" && path === "/api/runs")
			return Response.json([]);
		if (request.method === "PATCH" && path === "/api/settings") {
			const patch = (await request.json()) as SettingsPatch;
			patches.push(patch);
			persisted = {
				...persisted,
				defaults: { ...persisted.defaults, ...patch.defaults },
			};
			return Response.json(persisted);
		}
		throw new Error(`Unmocked settings request ${request.method} ${path}`);
	});
	let dispose = await h.mount(<SettingsPage />, "/settings", "/settings");
	try {
		await h.until(
			() => !!h.container.querySelector("#model-defaults-form"),
			"The existing settings URL must open default models",
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
		dispose = await h.mount(<SettingsPage />, "/settings", "/settings");
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
	return "model/service settings: default save isolation, both draft navigation guards, service management, legacy history entry/return, and empty-model recovery";
}
