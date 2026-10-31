import type { components } from "../src/api/schema";
import { chapterRecords } from "./chapter-records";
import type { BrowserHarness } from "./harness";

type Result = components["schemas"]["TranslationResultResponse"];
const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function navigationFeedback(h: BrowserHarness, preview = false) {
	const check: BrowserHarness["check"] = h.check;
	let dispose: (() => void) | undefined;
	await chapterRecords(
		{
			...h,
			mount: async (...args) => {
				dispose = await h.mount(...args);
				return dispose;
			},
			mock: (handler) =>
				h.mock(async (request) => {
					const response = await handler(request);
					if (
						!new URL(request.url).pathname.startsWith(
							"/api/translation-results/",
						)
					)
						return response;
					const result: Result = await response.json();
					return Response.json({
						...result,
						parts: result.material_provenance.ranges.map((range, index) => ({
							range_index: index,
							part_index: 0,
							resource_id: range.resource_id,
							spine_index: range.spine_index,
							start: range.start,
							end: range.end,
						})),
					});
				}),
		},
		true,
	);
	const button = (label: string) => {
		const found = [
			...h.container.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(node) =>
				(node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
		);
		check(found && !found.disabled, `Missing ${label}`);
		return found;
	};
	const doc = () =>
		h.container.querySelector<HTMLIFrameElement>("iframe.material-part")
			?.contentDocument;
	const highlighted = (document = doc()) =>
		!!document?.defaultView?.CSS.highlights.has("folio-search");
	const alpha = () => {
		const document = doc();
		const leaf = document?.querySelector("[data-locator-leaf]");
		check(
			document?.defaultView && leaf,
			"Navigation source must remain mounted",
		);
		const color = document.defaultView.getComputedStyle(
			leaf,
			"::highlight(folio-search)",
		).backgroundColor;
		const numbers = color.match(/[\d.]+/g)?.map(Number) ?? [];
		return numbers.length >= 4 ? (numbers[3] ?? 1) : 1;
	};
	const checkForeground = () => {
		const document = doc();
		const target = document?.defaultView?.CSS.highlights
			.get("folio-search")
			?.values()
			.next().value;
		const leaf = target?.startContainer.parentElement;
		check(
			document?.defaultView && leaf,
			"Fading feedback must still have a real source range",
		);
		const channels = (color: string) => {
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 1;
			const context = canvas.getContext("2d");
			check(context, "Browser must resolve computed foreground colors");
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
		};
		const normal = channels(document.defaultView.getComputedStyle(leaf).color);
		const actual = channels(
			document.defaultView.getComputedStyle(leaf, "::highlight(folio-search)")
				.color,
		);
		const opacity = alpha();
		check(
			actual.every(
				(channel, index) =>
					Math.abs(
						channel - (23 * opacity + (normal[index] ?? 0) * (1 - opacity)),
					) <= 4,
			),
			`Fade must restore the actual source foreground alongside its background alpha: alpha=${opacity}, normal=${normal}, actual=${actual}, computed=${document.defaultView.getComputedStyle(leaf, "::highlight(folio-search)").color}, style=${document.getElementById("folio-search-style")?.textContent}`,
		);
	};
	const openReturn = async () => {
		if (h.container.querySelector(".reader-chapter-records")) {
			button("关闭阅读记录").click();
			await h.until(
				() => !h.container.querySelector(".reader-chapter-records"),
				"Previous record entry must close before reopening the chapter list",
			);
		}
		button("本章记录").click();
		await h.until(
			() => !!h.container.querySelector('[role="tab"][aria-label="翻译"]'),
			"Records must mount before selecting their translation tab",
		);
		button("翻译").click();
		await h.until(
			() =>
				(h.container
					.querySelector<HTMLElement>(".reader-record-translation")
					?.getClientRects().length ?? 0) > 0,
			"Translation list must load",
		);
		const rows = h.container.querySelectorAll<HTMLButtonElement>(
			".reader-record-translation",
		);
		check(rows[1], "Fixture must expose a non-overlapping translation");
		rows[1].click();
		await h.until(
			() => !!h.container.querySelector(".translation-output"),
			"Translation details must load",
		);
		const previousHighlight =
			doc()?.defaultView?.CSS.highlights.get("folio-search");
		button("定位原文").click();
		await h.until(
			() =>
				highlighted() &&
				doc()?.defaultView?.CSS.highlights.get("folio-search") !==
					previousHighlight,
			"Return must paint exact source after presentation",
		);
		return doc();
	};
	try {
		if (preview) {
			const rows = h.container.querySelectorAll<HTMLButtonElement>(
				".reader-record-translation",
			);
			rows[1]?.click();
			await h.until(
				() => !!h.container.querySelector(".translation-output"),
				"Preview details must load",
			);
			return "navigation feedback preview: click return to observe the temporary highlight and fade";
		}
		const first = await openReturn();
		const started = performance.now();
		check(
			alpha() > 0.95,
			"A newly presented target must start fully highlighted",
		);
		await pause(250);
		check(
			highlighted() && alpha() > 0.95,
			"Navigation feedback must persist before its deadline",
		);
		const viewport = h.container.querySelector<HTMLElement>(".reader-viewport");
		check(viewport, "Reader must have a stable geometry before changing theme");
		const geometry = [viewport.clientWidth, viewport.clientHeight];
		button("阅读设置").click();
		await h.until(
			() => !!h.container.querySelector('input[aria-label="字号"]'),
			"Reading settings must open for a presentation-only theme switch",
		);
		const dark = new URLSearchParams(location.search).get("theme") !== "dark";
		button(dark ? "黑" : "白").click();
		await h.until(
			() =>
				!!doc()?.body &&
				doc()?.defaultView?.getComputedStyle(doc()?.body as HTMLElement)
					.color === (dark ? "rgb(229, 229, 229)" : "rgb(40, 40, 40)"),
			"Source foreground must update after changing paper theme",
		);
		check(
			doc() === first &&
				viewport.clientWidth === geometry[0] &&
				viewport.clientHeight === geometry[1],
			"Changing theme must exercise the presentation-only path without replacing the frame or geometry",
		);
		button("关闭阅读设置").click();
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (!reduced) {
			await h.until(
				() => highlighted() && alpha() > 0.05 && alpha() < 0.95,
				"Highlight disappearance must include visible intermediate alpha",
			);
			check(
				performance.now() - started >= 2100,
				"Automatic fade must begin after its visible interval",
			);
			const partial = alpha();
			checkForeground();
			button("阅读设置").click();
			await h.until(
				() => !!h.container.querySelector('input[aria-label="字号"]'),
				"Reading settings must open before changing layout",
			);
			const font = h.container.querySelector<HTMLInputElement>(
				'input[aria-label="字号"]',
			);
			check(font, "Reading settings must expose a real reflow control");
			h.inputValue(font, String(Number(font.value) + 1));
			await pause(45);
			check(
				!highlighted() || alpha() <= partial + 0.05,
				"Reflow during fade must not brighten or renew it",
			);
			button("关闭阅读设置").click();
		}
		await h.until(
			() => !highlighted(),
			"Navigation highlight must release its registry after expiration",
		);
		check(
			!first?.defaultView?.CSS.highlights.has("folio-search"),
			"Expired frame highlight must stay cleared",
		);
		button("阅读设置").click();
		await h.until(
			() => !!h.container.querySelector('input[aria-label="字号"]'),
			"Reading settings must reopen before changing layout",
		);
		const font = h.container.querySelector<HTMLInputElement>(
			'input[aria-label="字号"]',
		);
		check(font, "Reading settings must reopen");
		h.inputValue(font, String(Number(font.value) + 1));
		await pause(100);
		check(!highlighted(), "A later reflow must not resurrect expired feedback");
		button("关闭阅读设置").click();

		await openReturn();
		const frame = h.container.querySelector<HTMLIFrameElement>(
			"iframe.material-part",
		);
		const source = doc()?.querySelector<HTMLElement>('[data-locator-leaf="2"]');
		check(
			frame && source,
			"Reader source must be available for real pointer input",
		);
		const local = source.getBoundingClientRect();
		const outer = frame.getBoundingClientRect();
		const pointer = (
			window as unknown as {
				browserPointer?: (events: object[]) => Promise<void>;
			}
		).browserPointer;
		check(pointer, "Runner must expose real browser input");
		const x = outer.left + local.left + Math.min(local.width / 2, 24);
		const y = outer.top + local.top + Math.min(local.height / 2, 10);
		const inputStarted = performance.now();
		await pointer([
			{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
			{
				type: "mouseReleased",
				x,
				y,
				button: "left",
				buttons: 0,
				clickCount: 1,
			},
		]);
		if (!reduced)
			await h.until(
				() => highlighted() && alpha() > 0.05 && alpha() < 0.95,
				"Native input must start a visible fade before automatic expiration",
			);
		await h.until(
			() => !highlighted(),
			"Source input must finish feedback before its automatic deadline",
		);
		check(
			performance.now() - inputStarted < 600,
			"Native input must end feedback within 600ms rather than waiting for automatic expiration",
		);
		check(
			doc()?.defaultView?.CSS.highlights.has("folio-translation"),
			"Ending feedback must retain persistent translation underlines",
		);
		const old = await openReturn();
		const oldHighlight = old?.defaultView?.CSS.highlights.get("folio-search");
		await pause(2100);
		await openReturn();
		check(
			doc() === old &&
				doc()?.defaultView?.CSS.highlights.get("folio-search") !== oldHighlight,
			"Same-chapter navigation must reuse its document and replace the old highlight",
		);
		await pause(750);
		check(
			highlighted() && alpha() > 0.95,
			"The newer target must survive the old target's deadline at full opacity",
		);
		if (!reduced) {
			await h.until(
				() => highlighted() && alpha() > 0.05 && alpha() < 0.95,
				"Replacement isolation must also start while an old fade is actually running",
			);
			const fadingOld = doc();
			const fadingHighlight =
				fadingOld?.defaultView?.CSS.highlights.get("folio-search");
			await openReturn();
			await pause(350);
			check(
				doc() === fadingOld &&
					doc()?.defaultView?.CSS.highlights.get("folio-search") !==
						fadingHighlight &&
					highlighted() &&
					alpha() > 0.95,
				"A cancelled old fade must not change the new target after its former ending time",
			);
		}
		await h.until(
			() => !highlighted(),
			"Replacement target must complete its own lifecycle",
		);
		return `navigation feedback ${innerWidth}px${reduced ? " reduced motion" : ""}: real return/first paint, fade alpha, reflow/no revival, native source input, permanent marks and replacement isolation`;
	} finally {
		if (!preview) dispose?.();
	}
}
