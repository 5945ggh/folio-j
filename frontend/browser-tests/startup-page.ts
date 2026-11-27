import startupPage from "../../backend/static/startup/index.html?raw";
import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";

type StartupState = components["schemas"]["StartupState"];

export async function startupPageRegression(harness: BrowserHarness) {
	const { container, until } = harness;
	const check: BrowserHarness["check"] = harness.check;
	const fixture = window as Window & { startupFetch?: typeof fetch };
	const path = "C:\\学习数据 📚\\资料库\\app.db";
	const idle: StartupState = {
		ready: false,
		recovery: false,
		busy: false,
		stage: null,
		selected_path: null,
		configured_path: null,
		default_directory: "C:\\学习数据 📚\\资料库",
		retry_current_path: null,
		error: null,
		warning: null,
	};
	let state: StartupState = {
		...idle,
		busy: true,
		stage: { name: "检查原配置的数据位置", target: path, elapsed_ms: 3000 },
	};
	let available = true;
	const submissions: string[] = [];
	let timedOut = false;
	let refreshedAfterTimeout = false;
	fixture.startupFetch = async (input, init) => {
		if (input === "/_startup/state") {
			if (timedOut) refreshedAfterTimeout = true;
			if (!available) throw new TypeError("offline");
			return Response.json(state);
		}
		check(input === "/_startup/select", `Unexpected request ${input}`);
		check(init?.signal, "Selection request should have a timeout signal");
		submissions.push(String(init.body));
		state = {
			...idle,
			busy: true,
			stage: { name: "迁移学习数据库", target: path, elapsed_ms: 11000 },
		};
		const signal = init.signal;
		return new Promise<Response>((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					timedOut = true;
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	};

	const frame = document.createElement("iframe");
	frame.style.cssText = "width:100%;height:680px;border:0";
	frame.srcdoc = startupPage
		.replaceAll("__FOLIO_STARTUP_NONCE__", "test-nonce")
		.replace(
			'<script nonce="test-nonce">',
			`<script>window.fetch = parent.startupFetch;
const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = duration => originalTimeout(duration === 10000 ? 200 : duration);
</script><script nonce="test-nonce">`,
		);
	container.append(frame);
	const button = (id: string) =>
		frame.contentDocument?.querySelector<HTMLButtonElement>(`#${id}`);
	const text = (id: string) =>
		frame.contentDocument?.getElementById(id)?.textContent ?? "";
	try {
		await until(
			() => text("status").includes("检查原配置"),
			"Automatic startup stage is shown",
		);
		check(
			button("default")?.disabled,
			"Selection unavailable during automatic startup",
		);
		state = idle;
		await until(
			() => button("default")?.disabled === false,
			"Selection is available when idle",
		);
		button("default")?.click();
		await until(
			() => refreshedAfterTimeout && text("status").includes("迁移学习数据库"),
			"Timed out submission checks state and displays the running migration",
		);
		check(
			text("target") === path && text("elapsed").includes("11 秒"),
			"Stage shows target and elapsed time",
		);
		check(
			button("default")?.disabled,
			"Selection stays disabled while the server is busy",
		);
		button("default")?.click();
		check(
			submissions.length === 1,
			"A timed-out submission must not send another POST",
		);
		available = false;
		await until(
			() => button("reload-state")?.hidden === false,
			"A failed status check offers a reload",
		);
		check(
			button("default")?.disabled,
			"Unconfirmed state keeps selection disabled",
		);
		state = {
			...idle,
			ready: true,
			selected_path: path,
			warning: "下次启动时可能需要重新选择数据目录。",
		};
		available = true;
		button("reload-state")?.click();
		await until(
			() => text("title") === "应用已启动",
			"Manual check displays actual ready state",
		);
		check(
			text("ready-path") === path && text("warning").includes("重新选择"),
			"Ready state keeps the selected path and warning",
		);
		check(
			submissions.length === 1,
			"Status recovery did not submit another operation",
		);
		return "PASS startup stage, timeout, state recovery, and duplicate submission guard";
	} finally {
		delete fixture.startupFetch;
		frame.remove();
	}
}
