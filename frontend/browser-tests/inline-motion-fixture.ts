import { projectPart } from "../src/materials/dom";
import { InlineTranslation } from "../src/materials/inline-translation";
import { ReaderFlowMotion } from "../src/materials/reader-flow-motion";
import type { BrowserHarness } from "./harness";
import {
	animationFrame,
	inlineVisualState,
	readerAnimations,
	settleInline,
} from "./inline-animation";

/** Real br-only line boxes and a replaced image, without changing the chapter fixture. */
export async function inlineMotionFixture(h: BrowserHarness) {
	const check: BrowserHarness["check"] = h.check;
	const root = document.createElement("div");
	root.style.cssText =
		"position:fixed;left:10px;top:10px;width:360px;height:600px;overflow:hidden;background:white;z-index:1000";
	const frame = document.createElement("iframe");
	frame.className = "material-part";
	frame.style.cssText = "width:340px;height:600px;border:0";
	const before = "前の段落。";
	const after = "後の段落は同じ幅と改行を保ったまま動く。".repeat(5);
	frame.srcdoc = `<style>html{overflow:hidden}body{margin:0;font:18px/1.8 serif;white-space:pre-wrap;overflow:hidden}</style><div><span data-locator-leaf="0">${before}</span><span data-locator-leaf="1">\n</span><br><span data-locator-leaf="2" style="color:rgb(20,30,40);position:relative;top:2px">${after}</span><br><img data-epub-image="0" alt="fixture" width="80" height="40" style="vertical-align:middle"></div>`;
	root.append(frame);
	h.container.append(root);
	let motion: ReaderFlowMotion | undefined;
	let translation: InlineTranslation | undefined;
	try {
		await h.until(
			() => !!frame.contentDocument?.querySelector('[data-locator-leaf="2"]'),
			"Isolated br-only iframe must load",
		);
		const doc = frame.contentDocument;
		check(doc, "Isolated original document required");
		const original = doc.querySelector<HTMLElement>("div");
		const following = doc.querySelector<HTMLElement>('[data-locator-leaf="2"]');
		const image = doc.querySelector<HTMLImageElement>("img");
		check(
			original && following && image,
			"Br-only fixture needs text and an image",
		);
		const nodes = [...original.childNodes];
		const markup = original.innerHTML;
		const projection = projectPart(doc, `${before}\n${after}`, 0);
		const mounted = { doc, element: frame };
		motion = new ReaderFlowMotion(
			() => [mounted],
			() => root,
		);
		translation = new InlineTranslation(() => motion?.beforeRemove());
		const flow = motion;
		const output = translation;
		frame.style.height = `${doc.body.getBoundingClientRect().height}px`;
		const direct = (update: () => void) => {
			update();
			frame.style.height = `${doc.body.getBoundingClientRect().height}px`;
		};
		const lineBoxes = () => {
			const range = doc.createRange();
			range.selectNodeContents(following);
			const rects = [...range.getClientRects()];
			const first = rects[0];
			check(first, "Following inline text must have line boxes");
			return rects.map((rect) => [rect.left, rect.width, rect.top - first.top]);
		};
		const wrapping = lineBoxes();
		const originalWidth = following.getBoundingClientRect().width;
		let expandedHeight = 0;
		const position = () => {
			return {
				text: following.getBoundingClientRect().top,
				image: image.getBoundingClientRect().top,
				frameHeight: frame.getBoundingClientRect().height,
				...inlineVisualState(output.element, expandedHeight),
			};
		};
		const closed = position();
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const opening of [true, false]) {
			const positions = [position()];
			if (opening) {
				output.prepareReopen();
				check(
					flow.change(
						() =>
							output.set(
								doc,
								projection,
								before.length,
								"前文的译文。",
								direct,
							),
						() => output.growth,
					),
					"Br-only source must support inline translation",
				);
			} else {
				const node = output.element;
				if (output.hide(direct) && node) flow.collapse(node, output.fullHeight);
			}
			flow.synchronize(output.animations);
			expandedHeight = output.growth?.fullHeight ?? expandedHeight;
			let stable = 0;
			let previous = "";
			const started = performance.now();
			while (performance.now() - started < 3000) {
				await animationFrame();
				positions.push(position());
				check(
					lineBoxes().every((line, index) => {
						const expected = wrapping[index];
						return (
							expected &&
							line.every(
								(value, axis) =>
									Math.abs(value - (expected[axis] ?? Number.NaN)) <= 0.1,
							)
						);
					}) &&
						lineBoxes().length === wrapping.length &&
						Math.abs(following.getBoundingClientRect().width - originalWidth) <=
							0.1,
					"Br-only animation must preserve original line breaks and width each frame",
				);
				const geometry = JSON.stringify(position());
				const done =
					(opening ? !!output.element : !output.element) &&
					readerAnimations(root, [doc]).length === 0;
				stable = done && previous === geometry ? stable + 1 : 0;
				previous = geometry;
				if (stable >= 3) break;
			}
			check(
				stable >= 3,
				"Br-only and image motion must finish without effects",
			);
			const start = positions[0];
			const end = positions.at(-1);
			check(start && end, "Br-only motion must record endpoints");
			if (opening) expandedHeight = end.height;
			check(
				expandedHeight > 1,
				"Br-only expanded target must use final settled height",
			);
			for (const sample of positions)
				sample.reveal = sample.visibleHeight / expandedHeight;
			for (const key of ["text", "image"] as const) {
				const delta = end[key] - start[key];
				check(
					Math.abs(delta) > 1,
					`Br-only ${key} must move by translation height`,
				);
				if (!reduced)
					check(
						positions.some((sample) => {
							const progress = (sample[key] - start[key]) / delta;
							return progress > 0.05 && progress < 0.95;
						}),
						`Br-only ${key} must have intermediate ${opening ? "open" : "close"} positions: ${JSON.stringify(positions)}`,
					);
			}
			if (!reduced) {
				for (const key of ["height", "frameHeight"] as const) {
					check(
						positions
							.slice(1, 4)
							.some((sample) => Math.abs(sample[key] - start[key]) > 0.1),
						`Br-only ${key} must begin physically ${opening ? "growing" : "shrinking"} in the first three frames: ${JSON.stringify(positions)}`,
					);
					check(
						positions.every(
							(sample) =>
								Math.abs(
									(sample[key] - start[key]) / (end[key] - start[key]) -
										(sample.text - start.text) / (end.text - start.text),
								) <= 0.025,
						),
						`Br-only ${key} must ${opening ? "grow" : "shrink"} in phase with visible text and source flow: ${JSON.stringify(positions)}`,
					);
				}
			}
			check(
				positions.every(
					(sample) =>
						Math.abs(sample.text - start.text - (sample.image - start.image)) <=
						1,
				),
				"Image and inline source must move together each frame",
			);
			check(
				nodes.every((node) => node.isConnected && node.parentNode === original),
				"Br-only animation must retain original node identities",
			);
		}
		const show = () => {
			const update = () =>
				output.set(doc, projection, before.length, "前文的译文。", direct);
			if (output.isShowing(doc, before.length, "前文的译文。")) return update();
			output.prepareReopen();
			const result = flow.change(update, () => output.growth);
			flow.synchronize(output.animations);
			return result;
		};
		const hide = () => {
			const node = output.element;
			if (output.hide(direct) && node) {
				flow.collapse(node, output.fullHeight);
				flow.synchronize(output.animations);
			}
		};
		type Sample = ReturnType<typeof position>;
		const phase = async (opening: boolean, frames?: number) => {
			const start = position();
			const node = output.element;
			if (opening) check(show(), "Rapid reversal must reopen the source");
			else hide();
			const current = output.element;
			if (opening && node && !reduced)
				check(
					current === node,
					"Rapid reversal must reuse its existing output",
				);
			const afterMutation = position();
			if (!reduced)
				check(
					Math.abs(afterMutation.text - start.text) <= 1 &&
						Math.abs(afterMutation.image - start.image) <= 1 &&
						Math.abs(afterMutation.frameHeight - start.frameHeight) <= 1 &&
						Math.abs(afterMutation.height - start.height) <= 1 &&
						Math.abs(afterMutation.opacity - start.opacity) <= 0.02 &&
						Math.abs(afterMutation.reveal - start.reveal) <= 0.025,
					`Reversal must not jump at its handoff: ${JSON.stringify({ start, afterMutation })}`,
				);
			const height = expandedHeight;
			const target: Sample = {
				text: closed.text + (opening ? height : 0),
				image: closed.image + (opening ? height : 0),
				opacity: opening ? 0.8 : 0,
				reveal: opening ? 1 : 0,
				height: opening ? expandedHeight : 0,
				visibleHeight: opening ? expandedHeight : 0,
				frameHeight: closed.frameHeight + (opening ? expandedHeight : 0),
			};
			const positions = [start, afterMutation];
			const started = performance.now();
			let stable = 0;
			for (let count = 0; performance.now() - started < 3000; count++) {
				await animationFrame();
				positions.push(position());
				const done =
					(opening ? !!output.element : !output.element) &&
					readerAnimations(root, [doc]).length === 0;
				stable = done ? stable + 1 : 0;
				if (frames === undefined ? stable >= 3 : count + 1 >= frames) break;
			}
			if (frames === undefined)
				check(stable >= 3, "Rapid reversal must finish all visual effects");
			if (!reduced) {
				const progress = (sample: Sample, key: keyof Sample) =>
					(sample[key] - start[key]) / (target[key] - start[key]);
				for (const sample of positions) {
					const movement = progress(sample, "text");
					check(
						Math.abs(movement - progress(sample, "image")) <= 0.025 &&
							Math.abs(movement - progress(sample, "frameHeight")) <= 0.025 &&
							Math.abs(movement - progress(sample, "opacity")) <= 0.025 &&
							Math.abs(movement - progress(sample, "height")) <= 0.025 &&
							Math.abs(movement - progress(sample, "reveal")) <= 0.025,
						`Reversed opacity, reveal and geometry must share each frame with no phase lag: ${JSON.stringify({ opening, start, target, positions })}`,
					);
				}
				if (frames === undefined) {
					const completions = (
						[
							"text",
							"image",
							"frameHeight",
							"height",
							"opacity",
							"reveal",
						] as const
					).map((key) =>
						positions.findIndex((sample) => progress(sample, key) >= 0.995),
					);
					check(
						completions.every((index) => index >= 0) &&
							Math.max(...completions) - Math.min(...completions) <= 1,
						`All reversal effects must complete within the same rendering frame window: ${JSON.stringify({ completions, positions })}`,
					);
				}
			}
		};
		await phase(true);
		await phase(false, 5);
		await phase(true, 3);
		await phase(false);
		await phase(true, 5);
		await phase(false, 3);
		await phase(true);
		const effectsBeforeNoop = readerAnimations(root, [doc]);
		check(show(), "Already-visible output must remain available");
		check(
			effectsBeforeNoop.length === readerAnimations(root, [doc]).length &&
				effectsBeforeNoop.every((effect) =>
					readerAnimations(root, [doc]).includes(effect),
				),
			"Showing the current target must not restart effects",
		);
		await phase(false);
		await settleInline(
			{ ...h, container: root },
			doc,
			() => !output.element,
			"Isolated motion must settle closed",
		);
		check(
			original.innerHTML === markup,
			"Finished br-only animation must restore exact original markup and author styles",
		);
		check(
			Math.abs(position().text - closed.text) <= 1 &&
				Math.abs(position().image - closed.image) <= 1,
			"Br-only close must remove the full placeholder",
		);
		const longTranslation =
			"这是改变正文宽度后需要重新换行并保存完整高度的译文。".repeat(10);
		check(
			flow.change(
				() =>
					output.set(doc, projection, before.length, longTranslation, direct),
				() => output.growth,
			),
			"Responsive fixture must show a long translation",
		);
		flow.synchronize(output.animations);
		await settleInline(
			{ ...h, container: root },
			doc,
			() => output.element?.textContent === longTranslation,
			"Long translation must finish before width reflow",
		);
		const widerHeight = output.fullHeight;
		frame.style.width = "220px";
		direct(() => output.restoreNatural());
		const reflowed = output.element;
		check(
			reflowed &&
				output.fullHeight > widerHeight + 1 &&
				Math.abs(output.fullHeight - reflowed.getBoundingClientRect().height) <=
					1,
			"Width reflow must refresh the full expanded height from the new natural box",
		);
		const beforeResponsiveClose = frame.getBoundingClientRect().height;
		hide();
		await settleInline(
			{ ...h, container: root },
			doc,
			() => !output.element,
			"Reflowed translation must close without a stale height placeholder",
		);
		check(
			frame.getBoundingClientRect().height <
				beforeResponsiveClose - widerHeight &&
				Math.abs(
					frame.getBoundingClientRect().height -
						doc.body.getBoundingClientRect().height,
				) <= 1,
			"Closing after width reflow must remove the complete updated height without extra blank space",
		);
		check(
			original.innerHTML === markup &&
				readerAnimations(root, [doc]).length === 0,
			"Responsive close must preserve original markup and leave no effects",
		);
		frame.style.width = "340px";
		direct(() => {});
		const authorStyle = doc.createElement("style");
		authorStyle.textContent =
			".author-scaled { transform: scale(1.5); transform-origin: top left; }";
		doc.head.append(authorStyle);
		for (const ancestor of [original, doc.documentElement]) {
			ancestor.classList.add("author-scaled");
			const transformedMarkup = doc.body.innerHTML;
			const transformedFrameHeight = frame.getBoundingClientRect().height;
			check(
				!output.set(doc, projection, before.length, "缩放布局的译文。", () => {
					throw new Error(
						"Transformed author layout must fall back before a reader resize",
					);
				}) && !output.element,
				"Author scale must retain the floating-card fallback instead of applying visual height as CSS height",
			);
			check(
				doc.body.innerHTML === transformedMarkup &&
					frame.getBoundingClientRect().height === transformedFrameHeight,
				"Rejected author transforms must preserve source DOM and iframe height",
			);
			ancestor.classList.remove("author-scaled");
		}
		authorStyle.remove();
	} finally {
		translation?.clear(false);
		motion?.clear();
		root.remove();
	}
}
