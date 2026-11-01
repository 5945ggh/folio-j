import type { BrowserHarness } from "./harness";

export async function translationDragRegression(
	h: BrowserHarness,
	card: HTMLElement,
) {
	const check: BrowserHarness["check"] = h.check;
	const header = card.querySelector<HTMLElement>(
		"[data-reader-card-drag-handle]",
	);
	check(header, "Selection translation requires a draggable title header");
	check(
		header.dataset.readerCardDraggable === String(innerWidth > 600),
		"Only wide translation cards should be draggable",
	);
	const browserPointer = (
		window as unknown as {
			browserPointer: (
				events: {
					type: string;
					x: number;
					y: number;
					button?: string;
					buttons?: number;
					clickCount?: number;
				}[],
			) => Promise<void>;
		}
	).browserPointer;
	const frame = () =>
		new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	for (const direction of ["horizontal-tb", "vertical-rl"]) {
		if (direction === "vertical-rl") {
			[...h.container.querySelectorAll("button")]
				.find((button) => button.textContent === "切换竖排")
				?.click();
			await frame();
		}
		const before = card.getBoundingClientRect();
		const title = header.querySelector("h2")?.getBoundingClientRect();
		check(title, "Translation title must exist");
		const x = title.left + title.width / 2;
		const y = title.top + title.height / 2;
		await browserPointer([
			{ type: "mouseMoved", x, y },
			{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
			{ type: "mouseMoved", x: x - 70, y: y + 45, button: "left", buttons: 1 },
			{
				type: "mouseReleased",
				x: x - 70,
				y: y + 45,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		]);
		await frame();
		const moved = card.getBoundingClientRect();
		if (innerWidth > 600) {
			check(
				Math.abs(moved.left - before.left + 70) < 1 &&
					Math.abs(moved.top - before.top - 45) < 1,
				`${direction}: dragging title must move translation card`,
			);
			header.focus();
			header.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
			);
			await frame();
			check(
				Math.abs(card.getBoundingClientRect().left - moved.left + 10) < 1,
				"Focused translation header must support keyboard movement",
			);
		} else {
			check(
				Math.abs(moved.left - before.left) < 1 &&
					Math.abs(moved.top - before.top) < 1,
				"Narrow translation header must keep automatic placement",
			);
		}
	}
	const beforeResize = card.getBoundingClientRect();
	const config = card.querySelector<HTMLDetailsElement>(
		".translation-content > details",
	);
	check(config, "Translation configuration fold exists");
	check(
		config.hidden,
		"Compact translation hides configuration until expanded",
	);
	const expand = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
		(node) => node.textContent === "展开",
	);
	check(
		expand,
		"Compact translation has an independent reading expansion action",
	);
	expand.click();
	await h.until(
		() =>
			card.classList.contains("expanded") &&
			!config.hidden &&
			header.dataset.readerCardDraggable === "false",
		"Expanded translation exposes configuration in a non-draggable reading sidebar",
	);
	config.querySelector("summary")?.click();
	check(
		config.open && card.getBoundingClientRect().bottom <= innerHeight - 76 + 1,
		"Expanded configuration remains inside the reading sidebar above controls",
	);
	const collapse = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
		(node) => node.textContent === "收起",
	);
	check(collapse, "Expanded translation can return to its compact position");
	collapse.click();
	await h.until(() => {
		const after = card.getBoundingClientRect();
		return (
			!card.classList.contains("expanded") &&
			config.hidden &&
			(innerWidth <= 600 ||
				(Math.abs(after.left - beforeResize.left) < 1 &&
					Math.abs(after.top - beforeResize.top) < 1))
		);
	}, "Collapsing preserves the manual translation position and hides secondary details");

	const output = card.querySelector(".translation-output");
	check(output, "Translation output exists");
	const range = document.createRange();
	range.selectNodeContents(output);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	check(
		window.getSelection()?.toString() === "B 的现有译文。" &&
			getComputedStyle(output).userSelect !== "none",
		"Translation text must remain selectable after dragging",
	);
	window.getSelection()?.removeAllRanges();
	const close = card.querySelector<HTMLButtonElement>(
		'[aria-label="关闭翻译（任务继续）"]',
	);
	check(close, "Close action exists");
	let closed = false;
	close.addEventListener(
		"click",
		() => {
			closed = true;
		},
		{ once: true },
	);
	const closeRect = close.getBoundingClientRect();
	const x = closeRect.left + closeRect.width / 2;
	const y = closeRect.top + closeRect.height / 2;
	await browserPointer([
		{ type: "mouseMoved", x, y },
		{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
		{ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
	]);
	check(closed, "Header close button must remain clickable with drag handlers");
}
