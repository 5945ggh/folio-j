import type { components } from "../src/api/schema";
import type { BrowserHarness } from "./harness";
import { defaultContextCopySettings } from "./reader-context-copy-fixture";

type Schema = components["schemas"];
const stamp = "2026-10-29T00:00:00Z";
const hash = "a".repeat(64);
const paragraphs = [
	"第一句。",
	"第二句。",
	"第三句。",
	"猫が歩く。",
	"後ろ一。",
	"後ろ二。",
];
const text = paragraphs.join("");
const preferenceKey = "folio-reader-context-copy-v1";
const defaultCopy =
	"出处：《上下文の本》／第一章\n\n目标原文：\n猫が歩く。\n\n前文：\n第一句。第二句。第三句。";
const configuredCopy = "目标原文：\n猫が歩く。\n\n后文：\n後ろ一。";

/** Real MaterialReader and native iframe selection, with a clipboard API substitute. */
export async function readerContextCopy(h: BrowserHarness, preview = false) {
	const { MaterialReader } = await import("../src/materials/MaterialReader");
	const check: BrowserHarness["check"] = h.check;
	const direction =
		new URLSearchParams(location.search).get("direction") === "vertical-rl"
			? "vertical-rl"
			: "horizontal-tb";
	const chapter: Schema["MaterialChapterResponse"] = {
		id: "chapter",
		material_id: "context-copy",
		version_id: "v1",
		title: "第一章",
		level: 0,
		resources: [
			{
				id: "r",
				text,
				text_sha256: hash,
				href: "chapter.xhtml",
				css: "p{margin:0 0 1.5em}",
				html_attributes: {},
				body_attributes: {},
			},
		],
		parts: [
			{
				resource_id: "r",
				spine_index: 0,
				start: 0,
				end: text.length,
				leaf_start: 0,
				leaf_end: 7,
				html: paragraphs
					.map((value, index) =>
						index === 3
							? '<p data-paragraph="3"><ruby><span data-locator-leaf="3">猫</span><rt>ねこ</rt></ruby><span data-locator-leaf="4">が歩く。</span></p>'
							: `<p data-paragraph="${index}"><span data-locator-leaf="${index > 3 ? index + 1 : index}">${value}</span></p>`,
					)
					.join(""),
			},
		],
	};
	const book: Schema["MaterialResponse"] = {
		id: "context-copy",
		source_id: "source",
		title: "上下文の本",
		version_id: "v1",
		contract_version: "1",
		product_sha256: hash,
		source_sha256: hash,
		created_at: stamp,
		warnings: [],
		chapters: [
			{ id: chapter.id, title: chapter.title, level: 0, part_count: 1 },
		],
		reading_position: {
			chapter_id: chapter.id,
			resource_id: "r",
			version_id: "v1",
			part_index: 0,
			kind: "text",
			offset: 0,
			at_chapter_end: false,
			progress: 0,
			revision: 0,
			updated_at: stamp,
			settings: { font_size: 22, line_height: 2, writing_mode: direction },
		},
	};
	const writes: string[] = [];
	let stored: Schema["ContextCopySettingsResponse"] = {
		...defaultContextCopySettings,
	};
	const settingsWrites: Schema["ContextCopySettingsUpdate"][] = [];
	let nextSaveStatus = 200;
	let failRead = false;
	let readCount = 0;
	let releaseRead: (() => void) | undefined;
	const firstRead = new Promise<void>((resolve) => {
		releaseRead = resolve;
	});
	h.mock(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/settings/context-copy" && request.method === "GET") {
			readCount++;
			if (readCount === 1) await firstRead;
			return failRead
				? Response.json({ detail: "Offline settings failure" }, { status: 503 })
				: Response.json(stored);
		}
		if (path === "/api/settings/context-copy" && request.method === "PUT") {
			const update: Schema["ContextCopySettingsUpdate"] = await request.json();
			settingsWrites.push(update);
			if (nextSaveStatus !== 200) {
				const status = nextSaveStatus;
				nextSaveStatus = 200;
				return Response.json({ detail: "Settings save rejected" }, { status });
			}
			check(
				update.expected_revision === stored.revision,
				"Save must use the latest read database revision",
			);
			const { expected_revision, ...preferences } = update;
			stored = { ...preferences, revision: expected_revision + 1 };
			return Response.json(stored);
		}
		if (request.method !== "GET") {
			writes.push(`${request.method} ${path}`);
			check(
				path.endsWith("/opened") ||
					path.endsWith("/readings/prepare") ||
					path.endsWith("/reading-position"),
				`Copy must not write learning content or start a model task: ${request.method} ${path}`,
			);
		}
		if (path === `/api/materials/${book.id}`) return Response.json(book);
		if (path.endsWith("/opened") || path.endsWith("/usage"))
			return Response.json({
				material_id: book.id,
				status: "in_progress",
				revision: 1,
				last_opened_at: stamp,
				updated_at: stamp,
			});
		if (path === "/api/sources/source")
			return Response.json({
				id: "source",
				title: "离线来源",
				description: "",
				note: "",
				segment_count: 0,
				created_at: stamp,
				updated_at: stamp,
			});
		if (path.endsWith("/readings/prepare"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "g1",
				token_count: 0,
			});
		if (path.endsWith("/readings"))
			return Response.json({
				material_id: book.id,
				version_id: "v1",
				generation_id: "g1",
				resources: [],
			});
		if (path.endsWith("/chapters/chapter")) return Response.json(chapter);
		if (
			path.endsWith("/chapters/chapter/segments") ||
			path.endsWith("/chapters/chapter/translations")
		)
			return Response.json({
				items: [],
				next_cursor: null,
				unavailable_count: 0,
			});
		if (path.endsWith("/translations"))
			return Response.json({ results: [], tasks: [], next_offset: null });
		if (path.endsWith("/reading-position")) {
			const update: Schema["ReadingPositionUpdate"] = await request.json();
			return Response.json({
				...update,
				progress: 0,
				revision: update.expected_revision + 1,
				updated_at: stamp,
			});
		}
		throw new Error(`Unexpected context-copy ${request.method} ${path}`);
	});
	localStorage.clear();
	localStorage.setItem("folio-reader-ui-v1", JSON.stringify({ focus: false }));
	const legacyPreferences = JSON.stringify({
		...defaultContextCopySettings,
		before_sentences: 0,
		after_sentences: 2,
		include_source: false,
	});
	localStorage.setItem(preferenceKey, legacyPreferences);
	const copies: string[] = [];
	let write: (value: string) => Promise<void> = async () => {};
	const clipboardDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		"clipboard",
	);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: (value: string) => {
				copies.push(value);
				return write(value);
			},
		},
	});
	let dispose: (() => void) | undefined;
	const button = (label: string, scope: ParentNode = h.container) => {
		const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
		);
		check(found && !found.disabled, `Missing enabled ${label}`);
		return found;
	};
	const findInput = (label: string) => {
		const node = [...h.container.querySelectorAll("label")]
			.find((item) => item.textContent?.trim() === label)
			?.querySelector("input");
		check(node, `Missing input ${label}`);
		return node;
	};
	const open = async () => {
		dispose = await h.mount(
			<MaterialReader />,
			"/materials/:id",
			`/materials/${book.id}`,
		);
		await h.until(
			() =>
				!!h.container
					.querySelector<HTMLIFrameElement>("iframe.material-part")
					?.contentDocument?.querySelector('[data-paragraph="3"]'),
			"Real reader iframe must load",
		);
		// Allow the real iframe study binding and its settle timer to attach.
		await new Promise((resolve) => setTimeout(resolve, 150));
	};
	const select = async (index = 3) => {
		const frame = h.container.querySelector<HTMLIFrameElement>(
			"iframe.material-part",
		);
		const doc = frame?.contentDocument,
			native = doc?.getSelection();
		const paragraph = doc?.querySelector(`[data-paragraph="${index}"]`);
		check(
			doc && native && paragraph,
			"Native reader selection requires loaded original paragraph",
		);
		const range = doc.createRange();
		range.selectNodeContents(paragraph);
		native.removeAllRanges();
		native.addRange(range);
		doc.dispatchEvent(new Event("selectionchange"));
		await h.until(
			() => !!h.container.querySelector('[aria-label="选区操作"]'),
			"Native iframe selection must expose actual reader toolbar",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		return {
			doc,
			native,
			snapshot: [
				native.anchorNode,
				native.anchorOffset,
				native.focusNode,
				native.focusOffset,
			],
		};
	};
	const assertSelection = (value: Awaited<ReturnType<typeof select>>) => {
		check(
			value.snapshot.every(
				(item, index) =>
					item ===
					[
						value.native.anchorNode,
						value.native.anchorOffset,
						value.native.focusNode,
						value.native.focusOffset,
					][index],
			),
			"Context copy must retain exact native selection",
		);
	};
	const toolbarFits = () => {
		const toolbar = h.container.querySelector<HTMLElement>(
			'[aria-label="选区操作"]',
		);
		check(toolbar, "Selection toolbar must remain visible");
		const rect = toolbar.getBoundingClientRect();
		check(
			rect.left >= 0 &&
				rect.right <= window.innerWidth + 1 &&
				rect.top >= 0 &&
				rect.bottom <= window.innerHeight + 1,
			`Toolbar must fit ${direction}/${window.innerWidth}px: ${JSON.stringify(rect.toJSON())}`,
		);
		for (const item of toolbar.querySelectorAll("button")) {
			const area = item.getBoundingClientRect();
			check(
				area.left >= rect.left - 1 && area.right <= rect.right + 1,
				"All selection actions must fit toolbar",
			);
		}
	};
	const success = () =>
		!!h.container.textContent?.includes("已复制目标原文与上下文");
	const failure = () =>
		h.container.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="待复制的文本"]',
		);
	try {
		await open();
		await h.until(
			() => readCount === 1,
			"Reader must request database copy settings",
		);
		check(
			releaseRead,
			"Initial settings read must remain pending while the original loads",
		);
		check(
			!!h.container.querySelector("iframe.material-part"),
			"Delayed settings must not block original reading",
		);
		releaseRead();
		await h.until(
			() => !h.container.textContent?.includes("正在读取复制设置"),
			"Initial settings read must settle",
		);
		const selected = await select();
		toolbarFits();
		const count = copies.length;
		button("带上下文复制").click();
		check(
			copies.length === count + 1,
			"Clipboard write must begin synchronously in the action handler",
		);
		check(
			copies.at(-1) === defaultCopy,
			`Default copy must retain target and three preceding sentences, exclude ruby readings, and omit empty after side: ${JSON.stringify(copies.at(-1))}`,
		);
		await h.until(
			success,
			"Successful clipboard promise must show copied feedback",
		);
		assertSelection(selected);
		// Existing native copy remains selected original only, using synthetic clipboard data.
		const data = new DataTransfer();
		selected.doc.dispatchEvent(
			new ClipboardEvent("copy", {
				bubbles: true,
				cancelable: true,
				clipboardData: data,
			}),
		);
		check(
			data.getData("text/plain") === paragraphs[3],
			"Ordinary copy must remain selected original only and exclude ruby readings",
		);
		if (preview)
			return `context copy preview: ${direction}/${window.innerWidth}px; real reader iframe; clipboard API substitute`;

		button("阅读设置").click();
		await h.until(
			() => !!h.container.querySelector(".reader-copy-settings"),
			"Copy preferences must appear within reading settings",
		);
		check(
			findInput("前文句数").value === "3" &&
				findInput("后文句数").value === "0",
			"Default copy budgets must be visible",
		);
		const beforeInput = findInput("前文句数");
		h.inputValue(beforeInput, "");
		await h.until(
			() => beforeInput.getAttribute("aria-invalid") === "true",
			"Empty numeric draft must be visibly invalid",
		);
		const beforeInvalidSave = settingsWrites.length;
		beforeInput.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		check(
			beforeInput.value === "" && settingsWrites.length === beforeInvalidSave,
			"Invalid empty draft must remain editable and never save as zero",
		);
		const advanced = h.container.querySelector<HTMLDetailsElement>(
			".reader-copy-advanced",
		);
		check(advanced, "Copy settings must expose advanced character budgets");
		advanced.open = true;
		check(
			findInput("前文字符上限").value === "200" &&
				findInput("后文字符上限").value === "200",
			"Character defaults must match the copy contract",
		);
		for (const [label, value] of [
			["前文句数", "0"],
			["后文句数", "1"],
		]) {
			check(label && value, "Budget fixture must have label and value");
			h.inputValue(findInput(label), value);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		findInput("附带出处").click();
		await h.until(
			() => !findInput("附带出处").checked,
			"Source draft must update",
		);
		check(
			settingsWrites.length === 0,
			"Editing preferences must not auto-save",
		);
		await select();
		button("带上下文复制").click();
		check(
			copies.at(-1) === defaultCopy,
			"Unsaved drafts must not change copying",
		);
		nextSaveStatus = 500;
		button("保存复制设置").click();
		await h.until(
			() => !!h.container.textContent?.includes("保存失败，修改已保留"),
			"Failed save must report retained draft",
		);
		check(
			findInput("前文句数").value === "0" &&
				findInput("后文句数").value === "1" &&
				!findInput("附带出处").checked,
			"Failed save must retain all draft fields",
		);
		check(stored.revision === 0, "Failed save must not change database state");
		stored = { ...defaultContextCopySettings, revision: 1 };
		nextSaveStatus = 409;
		button("保存复制设置").click();
		await h.until(
			() => !!h.container.textContent?.includes("复制设置已在其他页面更新"),
			"Conflict must explain the need to read again",
		);
		check(findInput("后文句数").value === "1", "Conflict must retain draft");
		button("重新读取并保留修改").click();
		await h.until(
			() =>
				readCount >= 2 &&
				!h.container.textContent?.includes("重新读取后再保存"),
			"Conflict recovery must refresh revision without discarding draft",
		);
		check(
			findInput("前文句数").value === "0" &&
				findInput("后文句数").value === "1",
			"Reload must retain chosen draft",
		);
		button("保存复制设置").click();
		await h.until(
			() =>
				stored.revision === 2 &&
				!!h.container.textContent?.includes("复制设置已保存"),
			"Explicit save must commit all preferences using refreshed revision",
		);
		check(
			stored.before_sentences === 0 &&
				stored.after_sentences === 1 &&
				!stored.include_source,
			"Database must store the complete configured preference set",
		);
		button("恢复复制默认值").click();
		await h.until(
			() =>
				findInput("前文句数").value === "3" &&
				findInput("后文句数").value === "0",
			"Restore defaults must update draft",
		);
		check(
			stored.before_sentences === 0 &&
				stored.revision === 2 &&
				Number(settingsWrites.length) === 3,
			"Restore defaults must wait for explicit save",
		);
		check(
			localStorage.getItem(preferenceKey) === legacyPreferences,
			"Old browser copy preferences must remain ignored and untouched",
		);
		button("关闭阅读设置").click();
		await select();
		button("带上下文复制").click();
		check(
			copies.at(-1) === configuredCopy,
			"0-before and 1-after with source disabled must produce only target and after",
		);
		dispose?.();
		await open();
		await select();
		button("带上下文复制").click();
		check(
			copies.at(-1) === configuredCopy,
			"Saved database copy preferences must survive unmount/remount",
		);
		await h.until(success, "Remounted successful copy must show feedback");
		write = async () => {
			throw new DOMException("Clipboard denied", "NotAllowedError");
		};
		button("带上下文复制").click();
		await h.until(
			() => !!failure(),
			"Clipboard rejection must provide manual copy text",
		);
		const manual = failure();
		check(
			manual?.readOnly && manual.value === configuredCopy,
			"Failure fallback must expose complete readonly copy text",
		);
		check(
			h.container.textContent?.includes("未能写入剪贴板"),
			"Clipboard rejection must explicitly report failure",
		);
		button("选择文本").click();
		check(
			manual.selectionStart === 0 &&
				manual.selectionEnd === configuredCopy.length,
			"Manual fallback must select all complete copy text",
		);

		let rejectLate: ((reason?: unknown) => void) | undefined;
		write = () =>
			new Promise<void>((_resolve, reject) => {
				rejectLate = reject;
			});
		await select();
		button("带上下文复制").click();
		check(rejectLate, "Delayed clipboard substitute must be pending");
		await select(4);
		check(
			!failure() && !success(),
			"New selection must clear old copy feedback",
		);
		rejectLate(new DOMException("Late denial", "NotAllowedError"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		check(
			!failure() && !success(),
			"Late previous-selection failure must not reappear",
		);
		write = async () => {};
		button("带上下文复制").click();
		check(
			copies.at(-1)?.includes("目标原文：\n後ろ一。"),
			"Next action must copy new selection",
		);
		await h.until(success, "Current selection copy must still complete");
		let resolveLate: (() => void) | undefined;
		write = () =>
			new Promise<void>((resolve) => {
				resolveLate = resolve;
			});
		button("带上下文复制").click();
		check(resolveLate, "Delayed clipboard substitute must capture completion");
		dispose?.();
		dispose = undefined;
		resolveLate();
		await new Promise((resolve) => setTimeout(resolve, 50));
		check(
			!success() &&
				!failure() &&
				!h.container.querySelector('[aria-label="选区操作"]'),
			"Late copy result after leaving reader must not restore UI",
		);
		failRead = true;
		await open();
		button("阅读设置").click();
		await h.until(
			() => !!h.container.textContent?.includes("读取复制设置失败"),
			"Failed settings read must be visible while original remains readable",
		);
		check(
			!!h.container.querySelector("iframe.material-part"),
			"Failed settings read must not block original reading",
		);
		failRead = false;
		button("重新读取复制设置").click();
		await h.until(
			() => !!h.container.querySelector(".reader-copy-settings input"),
			"Read retry must recover saved preferences",
		);
		check(
			findInput("前文句数").value === "0" &&
				findInput("后文句数").value === "1",
			"Read retry must use database preferences",
		);
		check(
			writes.every((request) =>
				/\/(opened|readings\/prepare|reading-position)$/.test(request),
			),
			"Copy must only permit normal reader lifecycle writes",
		);
		return `context copy: ${direction}/${window.innerWidth}px; real MaterialReader + native iframe selection; defaults/ruby/ordinary copy, database save/remount, ignored legacy storage, delayed/failed reads, failed/conflicting saves with retained drafts, defaults draft, denied/manual clipboard, stale selection/unmount callbacks, toolbar bounds; clipboard API substitute (not system clipboard); lifecycle writes ${writes.length}`;
	} finally {
		if (!preview) dispose?.();
		if (clipboardDescriptor)
			Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
}
