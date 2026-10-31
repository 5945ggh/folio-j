import type { components } from "../src/api/schema";
import type { Provider, Run } from "../src/settings/api";
import type { BrowserHarness } from "./harness";
import { provider, settings } from "./workbench";

/** Keep connection writes, credentials and scoped verification history independent. */
export async function settingsConnectionHistory(h: BrowserHarness) {
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
	const editor = () => find<HTMLElement>(".provider-editor-dialog");
	const field = (label: string) => {
		const node = [...editor().querySelectorAll("label")]
			.find((item) => item.querySelector("span")?.textContent?.trim() === label)
			?.querySelector<HTMLInputElement>("input");
		check(node, `Missing connection field ${label}`);
		return node;
	};
	let current: Provider = structuredClone(provider);
	const patches: components["schemas"]["ProviderPatch"][] = [];
	const historyRequests: URLSearchParams[] = [];
	let hasHistory = false;
	const failed: Run = {
		id: "offline-failed-verification",
		provider_id: provider.id,
		provider_name: provider.name,
		model_id: "offline-model",
		protocol: "responses",
		purpose: "verification",
		status: "failed",
		stream: true,
		prompt_version: "offline-v1",
		output_text: "离线部分模型回复",
		error: "离线模拟：流式响应被服务中断",
		usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
		created_at: provider.created_at,
		started_at: provider.created_at,
		finished_at: provider.updated_at,
	};
	h.mock(async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/api/settings")
			return Response.json(settings);
		if (request.method === "GET" && url.pathname === "/api/providers")
			return Response.json([current]);
		if (
			request.method === "PATCH" &&
			url.pathname === `/api/providers/${provider.id}`
		) {
			const patch = (await request.json()) as (typeof patches)[number];
			patches.push(patch);
			const { api_key, ...connection } = patch;
			current = {
				...current,
				...connection,
				has_api_key: api_key === undefined ? current.has_api_key : !!api_key,
			};
			return Response.json(current);
		}
		if (request.method === "GET" && url.pathname === "/api/runs") {
			historyRequests.push(url.searchParams);
			check(
				url.searchParams.get("provider_id") === provider.id,
				"Service history requests must retain their service scope",
			);
			return Response.json(
				hasHistory && !url.searchParams.get("status") ? [failed] : [],
			);
		}
		if (request.method === "GET" && url.pathname === `/api/runs/${failed.id}`)
			return Response.json(failed);
		throw new Error(
			`Unmocked connection/history request ${request.method} ${url.pathname}`,
		);
	});
	const openService = async () => {
		const dispose = await h.mount(
			<SettingsPage />,
			"/settings",
			"/settings?section=providers",
		);
		await h.until(
			() => !!h.container.querySelector("#provider-open-provider"),
			"Connection/history fixture must load services",
		);
		find<HTMLButtonElement>("#provider-open-provider").click();
		return dispose;
	};
	// Exercise both credential states so a missing key cannot hide the separate entry.
	for (const hasKey of [true, false]) {
		current = { ...structuredClone(provider), has_api_key: hasKey };
		const dispose = await openService();
		try {
			button("连接设置").click();
			await h.until(
				() => !!document.querySelector(".provider-connection-view"),
				"Connection tab must show service connection settings",
			);
			button("编辑连接").click();
			await h.until(
				() => !!document.querySelector(".provider-editor-dialog"),
				"Edit connection must open its own editor",
			);
			check(
				editor().querySelectorAll("input").length === 2 &&
					editor().querySelectorAll("select").length === 1 &&
					!editor().querySelector(
						'input[type="password"], input[type="checkbox"]',
					),
				"Existing connection editor must contain only name, address and protocol",
			);
			const changedName = `${provider.name}已修改`;
			h.inputValue(field("名称"), changedName);
			h.inputValue(field("API 地址"), "https://updated.example.invalid/v1");
			const protocol = find<HTMLSelectElement>(
				".provider-editor-dialog select",
			);
			protocol.value = "chat_completions";
			protocol.dispatchEvent(new Event("change", { bubbles: true }));
			await h.until(
				() =>
					editor().textContent?.includes("验证状态会重置为「未验证」") === true,
				"Connection changes must explain verification status invalidation",
			);
			const beforeSave = patches.length;
			button("保存连接", editor()).click();
			await h.until(
				() => !document.querySelector(".provider-editor-dialog"),
				"Saving connection must return to service details",
			);
			const patch = patches[beforeSave];
			check(
				patches.length === beforeSave + 1 &&
					patch &&
					Object.keys(patch).sort().join() === "base_url,name,protocol" &&
					patch.name === changedName &&
					patch.base_url === "https://updated.example.invalid/v1" &&
					patch.protocol === "chat_completions" &&
					current.enabled === provider.enabled &&
					current.has_api_key === hasKey,
				"Saving connection must submit only connection fields and preserve enabled/key state",
			);
			button(hasKey ? "更换密钥" : "添加密钥").click();
			await h.until(
				() =>
					!!document.querySelector(
						'.provider-editor-dialog input[type="password"]',
					),
				"Credentials must open a separate password editor",
			);
			check(
				editor().querySelectorAll('input:not([type="password"])').length ===
					0 && !editor().querySelector("select"),
				"Credential editor must not expose connection or enabled fields",
			);
			const password = find<HTMLInputElement>(
				'.provider-editor-dialog input[type="password"]',
			);
			check(
				password.value === "",
				"Saved credentials must never reappear in the input",
			);
			h.inputValue(password, "offline-test-credential");
			await h.until(
				() =>
					editor().textContent?.includes("验证状态会重置为「未验证」") === true,
				"Credential changes must explain verification status invalidation",
			);
			button("保存密钥", editor()).click();
			await h.until(
				() => !document.querySelector(".provider-editor-dialog"),
				"Saving credentials must return to service details",
			);
			check(
				patches.length === beforeSave + 2 &&
					Object.keys(patches[beforeSave + 1] ?? {}).join() === "api_key" &&
					patches[beforeSave + 1]?.api_key === "offline-test-credential",
				"Saving credentials must write only the explicitly changed API key",
			);
		} finally {
			dispose();
		}
	}
	current = structuredClone(provider);
	let dispose = await openService();
	try {
		button("验证记录").click();
		await h.until(
			() =>
				document
					.querySelector(".provider-run-history")
					?.textContent?.includes("这个服务还没有验证记录。") === true,
			"A fixed service scope alone must show service-empty history, not filtered-empty history",
		);
		button("前往模型").click();
		await h.until(
			() =>
				document.querySelector(
					'.provider-detail-tabs button[aria-current="page"]',
				)?.textContent === "模型",
			"Empty service history must lead back to the service model tab",
		);
	} finally {
		dispose();
	}
	hasHistory = true;
	dispose = await openService();
	try {
		button("验证记录").click();
		await h.until(
			() => !!document.querySelector(".run-summary"),
			"History must load the offline failed verification",
		);
		const filterToggle = button("筛选");
		if (filterToggle.getClientRects().length) {
			check(
				filterToggle.getAttribute("aria-expanded") === "false",
				"Narrow history must initially collapse the filter controls",
			);
			filterToggle.click();
			await h.until(
				() => filterToggle.getAttribute("aria-expanded") === "true",
				"The visible narrow filter entry must expand before selection",
			);
		}
		const selects = document.querySelectorAll<HTMLSelectElement>(
			".provider-run-filters select",
		);
		check(
			selects.length === 2,
			"Scoped service history must offer model and status filters only",
		);
		const status = selects[1];
		check(
			status?.getClientRects().length,
			"History must expose visible status filtering",
		);
		status.value = "succeeded";
		status.dispatchEvent(new Event("change", { bubbles: true }));
		await h.until(
			() =>
				document
					.querySelector(".provider-run-history")
					?.textContent?.includes("没有符合筛选条件的验证记录。") === true,
			"An active status filter with no matches must show filtered-empty history",
		);
		button("清除筛选").click();
		await h.until(
			() => !!document.querySelector(".run-summary") && status.value === "",
			"Clearing active filters must restore scoped history",
		);
		check(
			historyRequests.some((query) => query.get("status") === "succeeded") &&
				historyRequests.every(
					(query) => query.get("provider_id") === provider.id,
				),
			"Filtering and clearing must always retain the service scope",
		);
		find<HTMLButtonElement>(".run-summary").click();
		await h.until(
			() =>
				document
					.querySelector(".run-detail")
					?.textContent?.includes(failed.error ?? "") === true,
			"Failed verification details must show the offline failure reason",
		);
		const detail = find<HTMLElement>(".run-detail");
		const text = detail.textContent ?? "";
		check(
			text.indexOf("失败原因") < text.indexOf(failed.output_text) &&
				text.includes("部分回复"),
			"Failure reason must precede and label the partial model response",
		);
		const technical = [...detail.querySelectorAll("details")].find(
			(node) =>
				node.querySelector("summary")?.textContent?.trim() === "调用详情",
		);
		check(
			technical && !technical.open,
			"Native call details must be collapsed initially",
		);
		technical.querySelector("summary")?.click();
		check(
			technical.open && technical.textContent?.includes(failed.prompt_version),
			"Opening native call details must reveal the recorded invocation metadata",
		);
	} finally {
		dispose();
	}
}
