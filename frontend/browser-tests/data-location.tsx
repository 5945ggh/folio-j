import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

export async function dataLocation(h: BrowserHarness, preview = false) {
	const { SettingsPage } = await import("../src/settings/SettingsPage");
	const { startAppTheme } = await import("../src/theme/browser");
	const check: BrowserHarness["check"] = h.check;
	const params = new URLSearchParams(location.search);
	startAppTheme().select(params.get("theme") === "dark" ? "dark" : "light");
	const directory = `C:\\Users\\日本語と中文😀\\${"学习资料と読書記録".repeat(12)}\\Folio-J`;
	const data: components["schemas"]["DataLocationResponse"] = {
		database_path: `${directory}\\folio.db`,
		data_directory: directory,
	};
	const clipboardDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		"clipboard",
	);
	let copied = "";
	let copyFails = false;
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			async writeText(text: string) {
				if (copyFails) throw new Error("Clipboard denied");
				copied = text;
			},
		},
	});
	const pending: { release?: () => void; signal?: AbortSignal } = {};
	const finishPending = () => pending.release?.();
	let scenario: "pending" | "failed" | "success" = preview
		? "success"
		: "pending";
	let requests = 0;
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		check(
			request.method === "GET" && path === "/api/settings/data-location",
			`Data location must only read its endpoint: ${request.method} ${path}`,
		);
		requests++;
		if (scenario === "pending") {
			pending.signal = request.signal;
			await new Promise<void>((resolve) => {
				pending.release = resolve;
			});
		}
		return scenario === "failed"
			? Response.json({ detail: "数据位置暂不可用" }, { status: 503 })
			: Response.json(data);
	});
	const button = (label: string) => {
		const node = [...h.container.querySelectorAll("button")].find(
			(node) => node.textContent?.trim() === label,
		);
		check(node && !node.disabled, `Missing enabled action ${label}`);
		return node;
	};
	const category = (section: string) => {
		const node = h.container.querySelector<HTMLAnchorElement>(
			`.settings-tabs a[href="/settings?section=${section}"]`,
		);
		check(node, `Missing category ${section}`);
		return node;
	};
	let dispose = await h.mount(
		<SettingsPage />,
		"/settings",
		"/settings?section=data-location",
	);
	try {
		if (!preview) {
			await h.until(
				() =>
					!!pending.release &&
					h.container.textContent?.includes("正在读取数据位置") === true,
				"Pending location must show loading",
			);
			check(
				!h.container.querySelector(".data-location-path"),
				"Pending reads must not invent a default path",
			);
			scenario = "success";
			finishPending();
		}
		await h.until(
			() => h.container.querySelectorAll(".data-location-path").length === 2,
			"Actual runtime paths must load",
		);
		check(
			category("data-location").getAttribute("aria-current") === "page",
			"Data location must be the active settings category",
		);
		const paths = [...h.container.querySelectorAll(".data-location-path")];
		check(
			paths[0]?.textContent === data.data_directory &&
				paths[1]?.textContent === data.database_path,
			"Runtime paths must retain all Unicode and path separators",
		);
		check(
			!h.container.querySelector("input,textarea,select") &&
				[...h.container.querySelectorAll(".settings-content button")].every(
					(node) => node.textContent?.startsWith("复制"),
				),
			"Location view must only expose copy actions",
		);
		for (const path of paths) {
			const box = path.getBoundingClientRect();
			check(
				box.left >= 0 &&
					box.right <= innerWidth &&
					path.scrollWidth <= path.clientWidth + 1,
				"Long paths must wrap inside the viewport",
			);
		}
		check(
			document.documentElement.scrollWidth <= innerWidth + 1,
			"Data location must not make the page overflow horizontally",
		);
		if (preview) return `data location preview ${innerWidth}px`;
		button("复制数据目录路径").click();
		await h.until(
			() => h.container.textContent?.includes("已复制数据目录") === true,
			"Successful copy must be visible",
		);
		check(copied === directory, "Copy must preserve the exact directory");
		copyFails = true;
		button("复制数据库文件路径").click();
		await h.until(
			() => h.container.textContent?.includes("复制失败") === true,
			"Rejected clipboard access must show manual-copy guidance",
		);
		check(
			h.container.querySelectorAll(".data-location-path").length === 2,
			"Clipboard failure must keep paths available for manual selection",
		);
		dispose();
		scenario = "failed";
		dispose = await h.mount(
			<SettingsPage />,
			"/settings",
			"/settings?section=data-location",
		);
		await h.until(
			() => h.container.textContent?.includes("数据位置暂不可用") === true,
			"Failed read must show the actual error",
		);
		check(
			!h.container.querySelector(".data-location-path"),
			"Read errors must not display a guessed path",
		);
		scenario = "success";
		button("重试读取数据位置").click();
		await h.until(
			() => h.container.querySelectorAll(".data-location-path").length === 2,
			"Explicit retry must recover the runtime paths",
		);
		dispose();
		scenario = "pending";
		pending.release = undefined;
		dispose = await h.mount(
			<SettingsPage />,
			"/settings",
			"/settings?section=data-location",
		);
		await h.until(
			() => !!pending.release,
			"Pending location request must start",
		);
		category("appearance").click();
		await h.until(
			() => !!h.container.querySelector('select[aria-label="应用颜色模式"]'),
			"Category navigation must stay available while the read is pending",
		);
		check(
			pending.signal?.aborted,
			"Leaving the location view must cancel its read",
		);
		scenario = "success";
		finishPending();
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		check(
			!h.container.querySelector(".data-location-path") &&
				category("appearance").getAttribute("aria-current") === "page",
			"Late response must not restore the location view",
		);
		check(
			requests === 4,
			"Only location reads and its explicit retry are expected",
		);
		if (params.has("capture")) {
			category("data-location").click();
			await h.until(
				() => h.container.querySelectorAll(".data-location-path").length === 2,
				"Capture must keep the data location view visible",
			);
		}
		return `data location ${innerWidth}px: runtime Unicode paths, wrapping, clipboard success/failure, failed read/retry and canceled late response; read-only endpoint`;
	} finally {
		if (!preview && !params.has("capture")) dispose();
		if (clipboardDescriptor)
			Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
}
