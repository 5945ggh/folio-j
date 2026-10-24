import type { components } from "../src/api/schema";
import { ReaderLayout } from "../src/materials/reader-layout";
import { ReaderStudy } from "../src/materials/reader-study";
import type { BrowserHarness } from "./harness";

/** Test-only geometry instrumentation; restored even when a regression fails. */
export async function inlinePerformance(
	h: BrowserHarness,
	results: readonly components["schemas"]["TranslationResultResponse"][],
) {
	const check: BrowserHarness["check"] = h.check;
	const frames = [
		...h.container.querySelectorAll<HTMLIFrameElement>("iframe.material-part"),
	];
	await h.until(
		() =>
			frames.length === 3 &&
			frames.every((frame) => !!frame.contentDocument?.querySelector("p")),
		"Long chapter must mount three real original frames",
	);
	const documents = frames
		.map((frame) => frame.contentDocument)
		.filter((doc): doc is Document => !!doc);
	const count = documents.reduce(
		(total, doc) => total + doc.querySelectorAll("p").length,
		0,
	);
	check(
		count >= 400,
		"Performance regression requires at least 400 ordinary paragraphs",
	);
	const doc = documents[0];
	const source = doc?.querySelector<HTMLElement>('[data-locator-leaf="2"]');
	const paragraph = source?.closest("p");
	const viewport = h.container.querySelector<HTMLElement>(".reader-viewport");
	const result = results[1];
	check(
		doc && source?.firstChild && paragraph && viewport && result,
		"Long fixture requires a saved paragraph target",
	);
	const inline = () =>
		doc.querySelector<HTMLElement>("[data-reader-inline-translation]");
	const nextFrame = () =>
		new Promise<number>((resolve) => requestAnimationFrame(resolve));
	for (let i = 0; i < 5; i++) await nextFrame();
	const tap = () => {
		const range = doc.createRange();
		check(source.firstChild, "Original source must remain intact");
		range.setStart(source.firstChild, 5);
		range.setEnd(source.firstChild, 6);
		const rect = range.getBoundingClientRect();
		for (const type of ["pointerdown", "pointerup"])
			source.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 31,
					isPrimary: true,
					pointerType: "mouse",
					button: 0,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				}),
			);
	};
	let reflows = 0,
		refreshes = 0,
		rangeReads = 0;
	const reflow = ReaderLayout.prototype.reflow;
	const refresh = ReaderStudy.prototype.refresh;
	ReaderLayout.prototype.reflow = function (...args) {
		reflows++;
		return reflow.apply(this, args);
	};
	ReaderStudy.prototype.refresh = function (...args) {
		refreshes++;
		return refresh.apply(this, args);
	};
	const restores = documents.flatMap((document) => {
		const prototype = Object.getPrototypeOf(document.createRange()) as Range;
		return (["getClientRects", "getBoundingClientRect"] as const).map((key) => {
			const original: (this: Range) => DOMRect | DOMRectList = prototype[key];
			Object.defineProperty(prototype, key, {
				configurable: true,
				writable: true,
				value: function (this: Range) {
					rangeReads++;
					return original.call(this);
				},
			});
			return () =>
				Object.defineProperty(prototype, key, {
					configurable: true,
					writable: true,
					value: original,
				});
		});
	});
	const originals = documents.flatMap((document) => [
		...document.querySelectorAll("p"),
	]);
	const originalMarkup = originals.map((node) => node.innerHTML);
	const following = paragraph.nextElementSibling;
	check(following, "Performance fixture needs a following original paragraph");
	const followingY = following.getBoundingClientRect().top;
	const subsequentFrameY = frames[1]?.getBoundingClientRect().top ?? 0;
	const samples: string[] = [];
	try {
		for (const opening of [true, false]) {
			reflows = 0;
			refreshes = 0;
			rangeReads = 0;
			const originalY =
				paragraph.getBoundingClientRect().top +
				(frames[0]?.getBoundingClientRect().top ?? 0);
			const started = performance.now();
			let previous = started,
				maxFrame = 0,
				longFrames = 0,
				frameCount = 0,
				stable = 0,
				maxSourceDrift = 0;
			tap();
			while (performance.now() - started < 3000) {
				const now = await nextFrame();
				const interval = now - previous;
				maxFrame = Math.max(maxFrame, interval);
				if (interval > 50) longFrames++;
				previous = now;
				frameCount++;
				maxSourceDrift = Math.max(
					maxSourceDrift,
					Math.abs(
						paragraph.getBoundingClientRect().top +
							(frames[0]?.getBoundingClientRect().top ?? 0) -
							originalY,
					),
				);
				const node = inline();
				const settled = opening
					? node?.textContent === result.translation &&
						node.style.height === "auto" &&
						Number(node.style.opacity) >= 0.79 &&
						!node
							.getAnimations()
							.some((animation) => animation.playState === "running")
					: !node;
				stable = settled ? stable + 1 : 0;
				if (stable >= 3) break;
			}
			const metrics = `${opening ? "open" : "close"}: ${Math.round(performance.now() - started)}ms, ${frameCount} frames, ${longFrames} >50ms, max ${Math.round(maxFrame)}ms, reflows ${reflows}, mark refreshes ${refreshes}, Range reads ${rangeReads}`;
			samples.push(metrics);
			check(stable >= 3, `Toggle must settle: ${metrics}`);
			check(
				Math.abs(
					paragraph.getBoundingClientRect().top +
						(frames[0]?.getBoundingClientRect().top ?? 0) -
						originalY,
				) <= 1,
				`Toggle must preserve original screen Y: ${metrics}`,
			);
			check(
				maxSourceDrift <= 1,
				`Every animation frame must preserve original screen Y: ${maxSourceDrift}px`,
			);
			const insertedHeight = opening
				? (inline()?.getBoundingClientRect().height ?? 0)
				: 0;
			check(
				Math.abs(
					following.getBoundingClientRect().top - followingY - insertedHeight,
				) <= 1,
				"Long chapter following paragraph must move by only translation height",
			);
			check(
				Math.abs(
					(frames[1]?.getBoundingClientRect().top ?? 0) -
						subsequentFrameY -
						insertedHeight,
				) <= 1,
				"Later frame must move by only translation height after remeasurement",
			);
			check(
				originals.every(
					(node, index) =>
						node.isConnected && node.innerHTML === originalMarkup[index],
				),
				"Long chapter toggles must preserve all original nodes and markup",
			);
			if (!new URLSearchParams(location.search).has("baseline")) {
				check(
					reflows <= 4,
					`Toggle must bound whole-reader reflow work independently of animation frames: ${metrics}`,
				);
				check(
					rangeReads <= count * 8,
					`Toggle must bound full source geometry scans: ${metrics}`,
				);
				check(
					refreshes <= 6,
					`Toggle must bound full mark rebuilding independently of animation frames: ${metrics}`,
				);
			}
		}
		return `inline performance ${count} paragraphs / ${frames.length} frames${matchMedia("(prefers-reduced-motion: reduce)").matches ? " reduced motion" : ""}: ${samples.join("; ")}`;
	} finally {
		ReaderLayout.prototype.reflow = reflow;
		ReaderStudy.prototype.refresh = refresh;
		for (const restore of restores) restore();
	}
}
