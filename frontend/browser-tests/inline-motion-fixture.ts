import { projectPart } from "../src/materials/dom";
import { InlineTranslation } from "../src/materials/inline-translation";
import { ReaderFlowMotion } from "../src/materials/reader-flow-motion";
import type { BrowserHarness } from "./harness";
import {
	inlineVisualState,
	pauseReaderAnimations,
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
	frame.style.cssText = "display:block;width:340px;height:600px;border:0";
	const before = "前の段落。";
	const after = "後の段落は同じ幅と改行を保ったまま動く。".repeat(5);
	frame.srcdoc = `<style>html{overflow:hidden}body{margin:0;font:18px/1.8 serif;white-space:pre-wrap;overflow:hidden}</style><div><span data-locator-leaf="0">${before}</span><span data-locator-leaf="1">\n</span><br><span data-locator-leaf="2" style="color:rgb(20,30,40);position:relative;top:2px">${after}</span><br><img data-epub-image="0" alt="fixture" width="80" height="40" style="vertical-align:middle"></div>`;
	const laterFrame = document.createElement("iframe");
	laterFrame.className = "material-part";
	laterFrame.style.cssText = "display:block;width:340px;height:80px;border:0";
	laterFrame.srcdoc =
		'<style>body{margin:0;font:18px/1.8 serif}</style><p><span data-locator-leaf="0">次のリソースの原文。</span></p>';
	const margin = document.createElement("button");
	margin.className = "reader-study-margin";
	margin.style.cssText = "position:absolute;left:340px;width:12px;height:12px";
	margin.textContent = "訳";
	root.append(frame, laterFrame, margin);
	h.container.append(root);
	let motion: ReaderFlowMotion | undefined;
	let translation: InlineTranslation | undefined;
	try {
		await h.until(
			() =>
				!!frame.contentDocument?.querySelector('[data-locator-leaf="2"]') &&
				!!laterFrame.contentDocument?.querySelector("p"),
			"Isolated br-only iframe must load",
		);
		const doc = frame.contentDocument;
		const laterDoc = laterFrame.contentDocument;
		check(doc && laterDoc, "Both isolated original documents required");
		const documents = [doc, laterDoc];
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
			() => [mounted, { doc: laterDoc, element: laterFrame }],
			() => root,
		);
		translation = new InlineTranslation(() => motion?.beforeRemove());
		const flow = motion;
		const output = translation;
		frame.style.height = `${doc.body.getBoundingClientRect().height}px`;
		let commitMargin = () => {};
		const direct = (update: () => void) => {
			update();
			frame.style.height = `${doc.body.getBoundingClientRect().height}px`;
			if (!output.element) commitMargin();
		};
		// Mirror the external layout commit: measure canonical source coordinates,
		// then let the production controller animate this actual margin button.
		commitMargin = () => {
			margin.style.top = `${flow.measure(() => frame.getBoundingClientRect().top + following.getBoundingClientRect().top - root.getBoundingClientRect().top)}px`;
			flow.marginsChanged();
		};
		commitMargin();
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
				laterFrame: laterFrame.getBoundingClientRect().top,
				margin: margin.getBoundingClientRect().top,
				...inlineVisualState(output.element, expandedHeight),
			};
		};
		const closed = position();
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const show = () => {
			const update = () =>
				output.set(doc, projection, before.length, "前文的译文。", direct);
			if (output.isShowing(doc, before.length, "前文的译文。")) return update();
			output.prepareReopen();
			const result = flow.change(update, () => output.growth);
			flow.synchronize(output.animations);
			commitMargin();
			return result;
		};
		const hide = () => {
			const node = output.element;
			if (output.hide(direct) && node) {
				flow.collapse(node, output.fullHeight);
				flow.synchronize(output.animations);
			}
		};
		const preserveSource = () => {
			const lines = lineBoxes();
			check(
				lines.length === wrapping.length &&
					lines.every((line, index) =>
						line.every(
							(value, axis) =>
								Math.abs(value - (wrapping[index]?.[axis] ?? Number.NaN)) <=
								0.1,
						),
					) &&
					Math.abs(following.getBoundingClientRect().width - originalWidth) <=
						0.1,
				"Motion must preserve original line breaks and width",
			);
			check(
				nodes.every((node) => node.isConnected && node.parentNode === original),
				"Motion must retain original node identities",
			);
		};
		type Sample = ReturnType<typeof position>;
		let expandedOpacity = 0;
		// Use a common production clock: duration or clock misalignment remains visible
		// when seeking, while machine scheduling cannot skip the intermediate states.
		const phase = async (opening: boolean, partial = false) => {
			const start = position();
			const previous = output.element;
			if (opening) check(show(), "Motion must open the translation");
			else hide();
			if (opening) {
				expandedHeight = output.fullHeight;
				expandedOpacity = Number(output.element?.style.opacity);
			}
			check(expandedHeight > 1, "Motion needs an expanded translation height");
			if (opening && previous && !reduced)
				check(
					output.element === previous,
					"Reversal must reuse its existing output",
				);
			const afterMutation = position();
			const control = pauseReaderAnimations(root, documents);
			if (reduced) {
				check(
					control.effects.length === 0,
					"Reduced motion must create no visual effects",
				);
			} else {
				check(
					control.effects.length > 0,
					"Translation and source must have actual motion effects",
				);
				check(
					control.clockSpread <= 1 && control.durationSpread <= 1,
					"Translation and source effects must share their production clock and duration",
				);
				check(
					(
						[
							"text",
							"image",
							"frameHeight",
							"laterFrame",
							"margin",
							"height",
							"opacity",
							"reveal",
						] as const
					).every(
						(key) =>
							Math.abs(afterMutation[key] - start[key]) <=
							(key === "opacity" || key === "reveal" ? 0.025 : 1),
					),
					`Motion handoff must not jump: ${JSON.stringify({ start, afterMutation })}`,
				);
			}
			const target: Sample = {
				text: closed.text + (opening ? expandedHeight : 0),
				image: closed.image + (opening ? expandedHeight : 0),
				opacity: opening ? expandedOpacity : 0,
				reveal: opening ? 1 : 0,
				height: opening ? expandedHeight : 0,
				visibleHeight: opening ? expandedHeight : 0,
				frameHeight: closed.frameHeight + (opening ? expandedHeight : 0),
				laterFrame: closed.laterFrame + (opening ? expandedHeight : 0),
				margin: closed.margin + (opening ? expandedHeight : 0),
			};
			if (!reduced) {
				const positions: Sample[] = [];
				for (const progress of [0, 0.25, 0.5, 0.75]) {
					control.seek(progress);
					const sample = position();
					positions.push(sample);
					preserveSource();
					const movement =
						(sample.text - start.text) / (target.text - start.text);
					for (const key of [
						"image",
						"frameHeight",
						"laterFrame",
						"margin",
						"height",
						"opacity",
						"reveal",
					] as const) {
						const delta = target[key] - start[key];
						if (Math.abs(delta) < 0.001) continue;
						check(
							Math.abs(movement - (sample[key] - start[key]) / delta) <= 0.035,
							`Opacity, reveal, physical height and source must stay in phase at seek ${progress}: ${JSON.stringify({ opening, start, target, sample })}`,
						);
					}
				}
				for (const key of [
					"text",
					"image",
					"height",
					"frameHeight",
					"laterFrame",
					"margin",
					"opacity",
					"reveal",
				] as const)
					check(
						positions.some((sample) => {
							const progress =
								(sample[key] - start[key]) / (target[key] - start[key]);
							return progress > 0.05 && progress < 0.95;
						}),
						`Seeking must expose intermediate ${key} during ${opening ? "open" : "close"}`,
					);
				if (partial) {
					control.seek(0.45);
					return;
				}
				control.resume();
			}
			await settleInline(
				{ ...h, container: root },
				doc,
				() => (opening ? !!output.element : !output.element),
				"Motion must settle without residual effects",
			);
			const end = position();
			check(
				(Object.keys(target) as (keyof Sample)[]).every(
					(key) =>
						Math.abs(end[key] - target[key]) <=
						(key === "opacity" || key === "reveal" ? 0.025 : 1),
				),
				`Motion must reach its full endpoint: ${JSON.stringify({ target, end })}`,
			);
			preserveSource();
		};
		await phase(true);
		await phase(false);
		await phase(true, true);
		const effectsBeforeNoop = readerAnimations(root, documents);
		const timesBeforeNoop = effectsBeforeNoop.map(
			(effect) => effect.currentTime,
		);
		const beforeNoop = position();
		check(show(), "Already-visible output must remain available");
		check(
			effectsBeforeNoop.length === readerAnimations(root, documents).length &&
				effectsBeforeNoop.every(
					(effect, index) =>
						readerAnimations(root, documents).includes(effect) &&
						effect.currentTime === timesBeforeNoop[index],
				) &&
				JSON.stringify(position()) === JSON.stringify(beforeNoop),
			"Showing the current target must preserve effects, clocks and geometry",
		);
		await phase(false, true);
		await phase(true, true);
		await phase(false);
		await phase(true);
		await phase(false, true);
		await phase(true);
		await phase(false);
		check(
			original.innerHTML === markup,
			"Finished motion must restore exact original markup and author styles",
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
				readerAnimations(root, documents).length === 0,
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
