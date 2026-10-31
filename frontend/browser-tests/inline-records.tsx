import type { components } from "../src/api/schema";
import { projectPart } from "../src/materials/dom";
import { INLINE_MOTION_MS } from "../src/materials/reader-flow-motion";
import { ReaderLayout } from "../src/materials/reader-layout";
import type { BrowserHarness } from "./harness";
import {
	animationFrames,
	readerAnimations,
	settleInline,
} from "./inline-animation";
import { inlineMotionFixture } from "./inline-motion-fixture";

/** Real iframe regressions; fixture fetch mocking is shared with chapter-records. */
export async function inlineRecords(
	h: BrowserHarness,
	doc: Document,
	text: string,
	paragraphs: readonly string[],
	results: readonly components["schemas"]["TranslationResultResponse"][],
	direction: "horizontal-tb" | "vertical-rl",
) {
	const check: BrowserHarness["check"] = h.check;
	const find = <T extends Element>(
		selector: string,
		scope: ParentNode = h.container,
	) => {
		const element = scope.querySelector<T>(selector);
		check(element, `Missing ${selector}`);
		return element;
	};
	const click = (label: string) =>
		find<HTMLButtonElement>(`button[aria-label="${label}"]`).click();
	const frames = () =>
		new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
	const viewport = find<HTMLElement>(".reader-viewport");
	const originals = [...doc.querySelectorAll("p")];
	const originalMarkup = originals.map((node) => node.innerHTML);
	const originalTop = originals[1]?.getBoundingClientRect().top ?? 0;
	const followingTop = originals[2]?.getBoundingClientRect().top ?? 0;
	const leaf = (index: number) =>
		find<HTMLElement>(`[data-locator-leaf="${index}"]`, doc);
	const tap = (index: number, offset: number) => {
		const target = leaf(index);
		check(target.firstChild, "Source leaf must contain text");
		const range = doc.createRange();
		range.setStart(target.firstChild, offset);
		range.setEnd(target.firstChild, offset + 1);
		const rect = range.getBoundingClientRect();
		for (const type of ["pointerdown", "pointerup"])
			target.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 7,
					isPrimary: true,
					pointerType: "mouse",
					button: 0,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				}),
			);
	};
	const inline = () =>
		doc.querySelector<HTMLElement>("[data-reader-inline-translation]");
	const card = () =>
		h.container.querySelector<HTMLElement>(".reader-chapter-records");
	const first = results[1];
	const cross = results[2];
	check(first && cross, "Fixture needs two saved targets");
	tap(2, 5);
	if (direction === "vertical-rl") {
		await h.until(
			() => !!card()?.textContent?.includes(first.translation),
			"Vertical body record tap must retain floating card",
		);
		check(!inline(), "Vertical reading must not insert paragraph translations");
		click("关闭阅读记录");
	} else {
		await h.until(
			() => inline()?.textContent === first.translation,
			"Horizontal body record tap must show complete inline translation",
		);
		check(!card(), "Inline body translation must not open record chrome");
		check(
			Math.abs(
				(originals[1]?.getBoundingClientRect().top ?? 0) - originalTop,
			) <= 1,
			"Opening translation must preserve source paragraph screen Y",
		);
		await settleInline(
			h,
			doc,
			() => inline()?.textContent === first.translation,
			"Inline opening geometry and opacity must settle",
		);
		check(
			(inline()?.getBoundingClientRect().top ?? 0) -
				(originals[1]?.getBoundingClientRect().bottom ?? 0) <=
				15,
			"Translation must follow source closely despite author paragraph margin",
		);
		check(
			Math.abs(
				(originals[2]?.getBoundingClientRect().top ?? 0) -
					followingTop -
					(inline()?.getBoundingClientRect().height ?? 0),
			) <= 1,
			"Following paragraph must move only by translation block height",
		);
		check(
			inline()?.previousElementSibling === originals[1],
			"Partial source translation must follow its full original paragraph",
		);
		check(
			!inline()?.querySelector("button,header,textarea"),
			"Inline output must contain only translation text",
		);
		check(
			originals.every(
				(node, index) =>
					node.isConnected && node.innerHTML === originalMarkup[index],
			),
			"Opening inline output must retain every original paragraph node",
		);
		check(
			projectPart(doc, text, 0).raw === text,
			"Inline output must not enter canonical source projection",
		);
		const selection = doc.getSelection();
		check(selection, "Native selection required");
		const range = doc.createRange();
		range.setStart(leaf(2).firstChild ?? leaf(2), 0);
		range.setEnd(
			leaf(3).firstChild ?? leaf(3),
			leaf(3).textContent?.length ?? 0,
		);
		selection.removeAllRanges();
		selection.addRange(range);
		const clipboard = new DataTransfer();
		doc.dispatchEvent(
			new ClipboardEvent("copy", {
				bubbles: true,
				cancelable: true,
				clipboardData: clipboard,
			}),
		);
		check(
			clipboard.getData("text/plain") === paragraphs.slice(1, 3).join(""),
			"Copy across inline output must contain exact original text only",
		);
		selection.removeAllRanges();
		doc.dispatchEvent(new Event("selectionchange"));
		viewport.scrollTop = 150;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		check(
			viewport.scrollTop > 0,
			"Fixture must exercise real reader scrolling",
		);
		check(
			inline()?.textContent === first.translation,
			"Scroll delivery must preserve inline output",
		);
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		tap(2, 5);
		await h.until(
			() => !inline(),
			"Second tap on same source must collapse inline output",
		);
		tap(3, 5);
		await h.until(
			() => inline()?.textContent === cross.translation,
			"Cross-paragraph target must open complete translation",
		);
		check(
			inline()?.previousElementSibling === originals[3],
			"Cross-paragraph translation must follow final complete source paragraph",
		);
		tap(2, 5);
		await h.until(
			() => inline()?.textContent === first.translation,
			"Another target must replace inline output",
		);
		check(
			doc.querySelectorAll("[data-reader-inline-translation]").length === 1,
			"Only one inline translation may be open",
		);
		tap(2, 5);
		await h.until(() => !inline(), "Second target must toggle closed");
		const settled = (expected: string | null, message: string) =>
			settleInline(
				h,
				doc,
				() =>
					expected === null ? !inline() : inline()?.textContent === expected,
				message,
			);
		const protectOriginals = () =>
			check(
				originals.every(
					(node, index) =>
						node.isConnected && node.innerHTML === originalMarkup[index],
				),
				"Interrupted animations must preserve every original node and markup",
			);
		const guardOldTimers = async (expected: HTMLElement | null) => {
			const started = performance.now();
			// Observe beyond the former close timer without imposing a frame-time budget.
			while (performance.now() - started < INLINE_MOTION_MS + 150) {
				await animationFrames(1);
				check(
					inline() === expected,
					"An obsolete close timer must not remove or replace the current output",
				);
			}
			check(
				doc.querySelectorAll("[data-reader-inline-translation]").length ===
					(expected ? 1 : 0),
				"Interrupted motion must leave the final single output only",
			);
			check(
				readerAnimations(h.container, [doc]).length === 0,
				"Interrupted motion must leave no animation effects",
			);
			protectOriginals();
		};
		tap(2, 5);
		await settled(
			first.translation,
			"Saved target must reopen before reversal",
		);
		const reused = inline();
		check(reused, "Reversal requires an existing output");
		tap(2, 5);
		await animationFrames(3);
		tap(2, 5);
		if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
			check(
				inline() === reused,
				"Reopening during close must reuse the same translation node",
			);
		await settled(
			first.translation,
			"Close-to-open reversal must settle expanded",
		);
		await guardOldTimers(inline());
		tap(2, 5);
		await animationFrames(2);
		tap(2, 5);
		await animationFrames(3);
		tap(2, 5);
		await settled(
			null,
			"RAF-spaced rapid reversals must settle in final collapsed state",
		);
		await guardOldTimers(null);
		check(
			Math.abs(
				(originals[2]?.getBoundingClientRect().top ?? 0) - followingTop,
			) <= 1,
			"Rapid close must remove the exact translation placeholder",
		);
		tap(3, 5);
		await animationFrames(3);
		tap(2, 5);
		await animationFrames(2);
		tap(3, 5);
		await settled(
			cross.translation,
			"Switching targets during motion must settle at final target",
		);
		check(
			inline()?.previousElementSibling === originals[3],
			"Interrupted target switch must retain correct insertion point",
		);
		await guardOldTimers(inline());
		tap(3, 5);
		await settled(null, "Cross target must close before scroll cancellation");
		tap(3, 5);
		await animationFrames(3);
		tap(2, 5);
		await animationFrames(2);
		tap(2, 5);
		await settled(
			null,
			"Closing a replacement target during its opening must settle collapsed",
		);
		await guardOldTimers(null);
		check(
			Math.abs(
				(originals[2]?.getBoundingClientRect().top ?? 0) - followingTop,
			) <= 1,
			"Closing an animating replacement must restore the exact original placeholder",
		);
		tap(2, 5);
		await animationFrames(3);
		viewport.scrollTop = 150;
		viewport.dispatchEvent(new Event("scroll"));
		await settled(
			first.translation,
			"Scrolling during opening must preserve final output",
		);
		await guardOldTimers(inline());
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		tap(2, 5);
		await animationFrames(3);
		const nativeWheel = (
			window as unknown as {
				browserPointer: (
					events: {
						type: string;
						x: number;
						y: number;
						deltaX: number;
						deltaY: number;
					}[],
				) => Promise<void>;
			}
		).browserPointer;
		check(nativeWheel, "Runner must expose trusted native wheel dispatch");
		const observe = ReaderLayout.prototype.observe;
		let observed = 0;
		ReaderLayout.prototype.observe = function (...args) {
			observed++;
			return observe.apply(this, args);
		};
		try {
			const bounds = viewport.getBoundingClientRect();
			await nativeWheel([
				{
					type: "mouseWheel",
					x: bounds.left + bounds.width / 2,
					y: bounds.top + Math.min(300, bounds.height / 2),
					deltaX: 0,
					deltaY: 120,
				},
			]);
			await h.until(
				() => viewport.scrollTop > 0,
				"Trusted wheel during closing must scroll the reader",
			);
			await settled(
				null,
				"Trusted wheel must finish closing and cancel effects",
			);
			check(
				observed > 0,
				"Trusted wheel must resume canonical ReaderLayout.observe sampling after cancellation",
			);
			await guardOldTimers(null);
		} finally {
			ReaderLayout.prototype.observe = observe;
		}
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		await settled(
			null,
			"Scroll cancellation must retain correct close behavior",
		);
		check(
			Math.abs(
				(originals[2]?.getBoundingClientRect().top ?? 0) - followingTop,
			) <= 1,
			"Scrolling during motion must not leave a placeholder",
		);
		await inlineMotionFixture(h);
		if (innerWidth > 600) {
			const singleMargin = () => {
				const marker = [
					...h.container.querySelectorAll<HTMLButtonElement>(
						".reader-study-margin",
					),
				].find((node) => node.getAttribute("aria-label") === "打开此处翻译");
				check(
					marker,
					"Inline-to-margin regression needs a single saved translation",
				);
				return marker;
			};
			for (const duringClose of [false, true]) {
				viewport.scrollTop = duringClose ? 160 : 0;
				viewport.dispatchEvent(new Event("scroll"));
				await frames();
				tap(2, 5);
				await settled(
					first.translation,
					"Inline output must settle before margin handoff",
				);
				if (duringClose) {
					tap(2, 5);
					await animationFrames(2);
				}
				const marker = singleMargin();
				const markerTop = marker.getBoundingClientRect().top;
				marker.click();
				await h.until(
					() => !!card()?.textContent?.includes(first.translation),
					"Page margin must open the saved translation while inline output closes",
				);
				const opened = card();
				check(opened, "Margin handoff requires an open record preview");
				const panelTop = opened.getBoundingClientRect().top;
				await settled(
					null,
					"Inline output must finish closing after margin handoff",
				);
				await animationFrames(3);
				check(
					card() === opened && opened.textContent?.includes(first.translation),
					"Inline removal and reflow must preserve the opened margin preview and its content",
				);
				check(
					Math.abs(singleMargin().getBoundingClientRect().top - markerTop) <=
						1 && Math.abs(opened.getBoundingClientRect().top - panelTop) <= 1,
					`Inline removal must preserve the margin entrance and preview anchor position: ${JSON.stringify({ duringClose, markerTop, markerAfter: singleMargin().getBoundingClientRect().top, panelTop, panelAfter: opened.getBoundingClientRect().top, scroll: viewport.scrollTop })}`,
				);
				singleMargin().click();
				await h.until(
					() => !card(),
					"Repeated margin click must still close its preview",
				);
			}
			for (const dismiss of ["repeat", "background", "wheel"]) {
				tap(2, 5);
				await settled(
					first.translation,
					"Inline output must reopen before explicit dismissal",
				);
				const marker = singleMargin();
				marker.click();
				await h.until(
					() => !!card(),
					"Margin preview must open before explicit dismissal",
				);
				if (dismiss === "repeat") marker.click();
				else if (dismiss === "background") tap(5, 5);
				else {
					const bounds = viewport.getBoundingClientRect();
					await nativeWheel([
						{
							type: "mouseWheel",
							x: bounds.left + bounds.width / 2,
							y: bounds.top + Math.min(300, bounds.height / 2),
							deltaX: 0,
							deltaY: 120,
						},
					]);
				}
				await settled(
					null,
					"Inline close must finish after explicit preview dismissal",
				);
				check(
					!card(),
					`Inline completion must respect ${dismiss} dismissal during closing`,
				);
			}
			viewport.scrollTop = 0;
			viewport.dispatchEvent(new Event("scroll"));
			await frames();
		}
	}
	if (innerWidth > 600) {
		await h.until(
			() => h.container.querySelectorAll(".reader-study-margin").length >= 2,
			"Margin entrances must settle",
		);
		const margins = [
			...h.container.querySelectorAll<HTMLButtonElement>(
				".reader-study-margin",
			),
		];
		const margin =
			direction === "vertical-rl"
				? margins[0]
				: margins.find(
						(node) => node.getAttribute("aria-label") === "打开此处翻译",
					);
		check(margin, "Fixture requires translation-only margin");
		margin.click();
	} else {
		click("本章记录");
	}
	await h.until(
		() => !!card(),
		"Margin / chapter entry must retain floating record panel",
	);
	check(!inline(), "Page margin entry must not insert inline output");
	const panel = card();
	check(panel, "Floating record panel required");
	const header = find<HTMLElement>("[data-reader-card-drag-handle]", panel);
	check(
		header.dataset.readerCardDraggable === String(innerWidth > 600),
		"Narrow floating header must disable dragging",
	);
	let previousGeometry = "";
	let stableFrames = 0;
	await h.until(() => {
		const geometry = JSON.stringify(panel.getBoundingClientRect().toJSON());
		stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0;
		previousGeometry = geometry;
		return stableFrames >= 5;
	}, "Record panel geometry must settle before native dragging");
	const panelBefore = panel.getBoundingClientRect();
	// Native mouse dispatch establishes the active pointer required by browser capture.
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
	check(browserPointer, "Runner must expose native browser pointer dispatch");
	const title = find<HTMLElement>("strong", header).getBoundingClientRect();
	const x = title.left + title.width / 2,
		y = title.top + title.height / 2;
	check(
		header.contains(document.elementFromPoint(x, y)),
		`Native drag must start on title header (${x},${y})`,
	);
	const deltaX = panelBefore.left > innerWidth / 2 ? -90 : 90;
	const deltaY = panelBefore.top > innerHeight / 2 ? -55 : 55;
	await browserPointer([
		{ type: "mouseMoved", x, y },
		{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
		{
			type: "mouseMoved",
			x: x + deltaX,
			y: y + deltaY,
			button: "left",
			buttons: 1,
		},
		{
			type: "mouseReleased",
			x: x + deltaX,
			y: y + deltaY,
			button: "left",
			buttons: 0,
			clickCount: 1,
		},
	]);
	await frames();
	if (innerWidth <= 600) {
		check(
			Math.abs(panel.getBoundingClientRect().left - panelBefore.left) < 1 &&
				panel.dataset.readerCardManual !== "true",
			"Narrow header gesture must keep card automatic",
		);
	} else {
		await h.until(
			() => panel.dataset.readerCardManual === "true",
			"Dragging title must pin manual card position",
		);
		const moved = panel.getBoundingClientRect();
		check(
			Math.abs(moved.left - panelBefore.left) > 10 ||
				Math.abs(moved.top - panelBefore.top) > 10,
			"Dragging title must move whole card",
		);
		viewport.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				isPrimary: true,
				pointerType: "mouse",
				pointerId: 20,
				button: 0,
			}),
		);
		await frames();
		check(
			card() === panel,
			"Background interaction must retain manually placed card",
		);
		if (direction === "vertical-rl") viewport.scrollLeft = -100;
		else viewport.scrollTop = 100;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		check(card() === panel, "Reader scroll must retain manually placed card");
		check(
			Math.abs(panel.getBoundingClientRect().left - moved.left) < 1 &&
				Math.abs(panel.getBoundingClientRect().top - moved.top) < 1,
			"Manual card position must remain stable on scroll",
		);
		viewport.scrollTop = 0;
		viewport.scrollLeft = 0;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		tap(3, 5);
		await h.until(
			() => !!card()?.textContent?.includes(cross.translation),
			"Another body target must switch pinned floating card content",
		);
		check(!inline(), "Pinned target switch must retain floating presentation");
		check(
			Math.abs((card()?.getBoundingClientRect().left ?? -1) - moved.left) < 1,
			"Target switch must preserve manual position",
		);
	}
	const current = card();
	check(current, "Record card must remain reachable before expanding");
	const expand = [
		...current.querySelectorAll<HTMLButtonElement>("button"),
	].find((node) => node.textContent?.trim() === "展开");
	if (innerWidth <= 600) {
		check(
			!expand &&
				current.querySelector(".reader-record-title strong")?.textContent ===
					"本章记录" &&
				!current.classList.contains("expanded"),
			"Narrow chapter entry must retain its fixed chapter panel without offering floating-card expansion",
		);
	} else {
		check(expand, "Floating header expand control must remain usable");
		expand.click();
		await h.until(
			() => card()?.classList.contains("expanded") === true,
			"Header expand control must expand without dragging",
		);
	}
	check(
		card()?.querySelector<HTMLElement>("[data-reader-card-drag-handle]")
			?.dataset.readerCardDraggable === "false",
		"Expanded reader panel must disable title dragging",
	);
	click("关闭阅读记录");
	await h.until(() => !card(), "Close must remove floating card");
	if (direction === "horizontal-tb") {
		tap(2, 5);
		await h.until(
			() => inline()?.textContent === first.translation,
			"Closing pinned card must restore inline behavior",
		);
	}
	if (direction === "horizontal-tb" && innerWidth > 600) {
		viewport.scrollTop = 400;
		viewport.dispatchEvent(new Event("scroll"));
		await frames();
		check(
			viewport.scrollTop > 100,
			"Direction regression must start below chapter beginning",
		);
		const originalFrame = find<HTMLIFrameElement>("iframe.material-part");
		click("阅读设置");
		await h.until(
			() =>
				!!h.container.querySelector('fieldset[aria-label="文字方向"] button'),
			"Direction setting must open",
		);
		const font = find<HTMLInputElement>('input[aria-label="字号"]');
		h.inputValue(font, "26");
		await h.until(
			() =>
				doc.documentElement.style.fontSize === "26px" ||
				doc.body.style.fontSize === "26px",
			"Font setting must reflow existing original frame",
		);
		check(
			originals.every(
				(node, index) =>
					node.isConnected && node.innerHTML === originalMarkup[index],
			),
			"Font reflow must preserve original nodes and markup",
		);
		await settleInline(
			h,
			doc,
			() => inline()?.textContent === first.translation,
			"Font change during opening must settle final output",
		);
		const outputAfterFont = inline();
		await animationFrames(3);
		tap(2, 5);
		await animationFrames(3);
		h.inputValue(font, "25");
		await h.until(
			() =>
				doc.documentElement.style.fontSize === "25px" ||
				doc.body.style.fontSize === "25px",
			"Font change must interrupt closing",
		);
		await settleInline(
			h,
			doc,
			() => !inline(),
			"Font change during closing must remove output and effects",
		);
		check(
			!outputAfterFont?.isConnected,
			"Font cancellation must dispose the old closing output",
		);
		const sourceAfterFont = originals[1];
		const followingAfterFont = originals[2];
		check(
			sourceAfterFont && followingAfterFont,
			"Font fixture needs adjacent original paragraphs",
		);
		check(
			Math.abs(
				followingAfterFont.getBoundingClientRect().top -
					sourceAfterFont.getBoundingClientRect().bottom -
					Number.parseFloat(getComputedStyle(sourceAfterFont).marginBottom),
			) <= 1,
			"Font cancellation must restore exact original paragraph spacing",
		);
		tap(2, 5);
		await animationFrames(3);
		await settleInline(
			h,
			doc,
			() => inline()?.textContent === first.translation,
			"Output must finish before preparing direction recovery anchor",
		);
		viewport.scrollTop = 400;
		viewport.dispatchEvent(new Event("scroll"));
		await animationFrames(5);
		check(
			viewport.scrollTop > 100,
			"Direction recovery must start below chapter beginning after font reflow",
		);
		const vertical = [
			...find(
				'fieldset[aria-label="文字方向"]',
			).querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "竖排");
		check(vertical, "Direction setting must expose vertical layout button");
		vertical.click();
		await h.until(
			() =>
				getComputedStyle(doc.body).writingMode === "vertical-rl" && !inline(),
			"Direction change must remove inline output",
		);
		await h.until(
			() => viewport.scrollLeft < -10,
			"Direction change must restore a noninitial canonical reading position",
		);
		check(
			find<HTMLIFrameElement>("iframe.material-part") === originalFrame &&
				originalFrame.contentDocument === doc,
			"Direction setting must preserve source frame identity",
		);
		check(
			projectPart(doc, text, 0).raw === text,
			"Direction reflow must retain canonical projection",
		);
		click("关闭阅读设置");
	}
	if (
		direction === "horizontal-tb" &&
		getComputedStyle(doc.body).writingMode === "horizontal-tb"
	) {
		if (inline()) {
			tap(2, 5);
			await settleInline(
				h,
				doc,
				() => !inline(),
				"Output must close before chapter interruption",
			);
		}
		tap(2, 5);
		await animationFrames(3);
	}
	click("下一章");
	await h.until(
		() => !!h.container.querySelector('.reader-viewport[aria-label="第二章"]'),
		"Chapter switch must load next chapter",
	);
	check(
		!card() &&
			!h.container
				.querySelector<HTMLIFrameElement>("iframe.material-part")
				?.contentDocument?.querySelector("[data-reader-inline-translation]"),
		"Chapter switch must clear floating and inline records",
	);
	const chapterDisposed = performance.now();
	while (performance.now() - chapterDisposed < INLINE_MOTION_MS + 150)
		await animationFrames(1);
	check(
		!doc.querySelector("[data-reader-inline-translation]") &&
			readerAnimations(h.container, [doc]).length === 0,
		"Chapter cancellation must leave no old output or animation effects after old timers expire",
	);
	return `inline records ${direction} ${innerWidth}px: complete saved result, whole paragraphs, cross-paragraph insertion, canonical copy/projection, toggle/replacement/scroll persistence, margin fallback, title drag/pinned target switch, narrow disabled, RAF-spaced reversal/target switch/scroll/font/chapter cancellation, br-only/image geometry and author-style restoration, inline-to-margin preview handoff and explicit dismissal`;
}
