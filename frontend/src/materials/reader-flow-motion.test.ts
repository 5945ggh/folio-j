import assert from "node:assert/strict";
import test from "node:test";
import {
	INLINE_MOTION_EASING,
	INLINE_MOTION_MS,
	ReaderFlowMotion,
} from "./reader-flow-motion.ts";

class Style {
	values = new Map<string, [string, string]>();
	get cssText() {
		return Array.from(
			this.values,
			([key, [value, priority]]) =>
				`${key}: ${value}${priority ? " !important" : ""};`,
		).join(" ");
	}
	setProperty(name: string, value: string, priority = "") {
		this.values.set(name, [value, priority]);
	}
	getPropertyValue(name: string) {
		return this.values.get(name)?.[0] ?? "";
	}
	getPropertyPriority(name: string) {
		return this.values.get(name)?.[1] ?? "";
	}
	removeProperty(name: string) {
		this.values.delete(name);
	}
}
class FakeAnimation {
	onfinish: (() => void) | null = null;
	effect: object | null = {
		updateTiming: (timing: OptionalEffectTiming) => {
			if (timing.duration !== undefined)
				this.options.duration = timing.duration;
		},
	};
	currentTime: number | null = 0;
	startTime: number | null = null;
	timeline: { currentTime: number } | null = null;
	playState = "running";
	cancelled = false;
	progress = 0;
	frames: Keyframe[];
	options: KeyframeAnimationOptions;
	constructor(frames: Keyframe[], options: KeyframeAnimationOptions) {
		this.frames = frames;
		this.options = options;
	}
	cancel() {
		this.cancelled = true;
		this.playState = "idle";
	}
	finish() {
		this.progress = 1;
		this.playState = "finished";
		this.onfinish?.();
	}
	get offset() {
		if (this.cancelled || this.effect === null) return 0;
		const value = (frame: Keyframe | undefined) => {
			const text = String(frame?.top ?? frame?.transform ?? "0");
			return Number.parseFloat(text.replace("translateY(", "")) || 0;
		};
		return (
			value(this.frames[0]) * (1 - this.progress) +
			value(this.frames[1]) * this.progress
		);
	}
	get animatedHeight(): number | null {
		if (
			this.cancelled ||
			this.effect === null ||
			!this.frames.some((frame) => frame.height !== undefined)
		)
			return null;
		const from = Number.parseFloat(String(this.frames[0]?.height));
		const to = Number.parseFloat(String(this.frames[1]?.height));
		return from * (1 - this.progress) + to * this.progress;
	}
}
class Element {
	style = new Style();
	styleAttribute = false;
	removedStyle = 0;
	parentElement: Element | null = null;
	flowAfter: Element | null = null;
	tagName = "P";
	isConnected = true;
	css: Record<string, string> = {};
	animations: FakeAnimation[] = [];
	ownerDocument: Doc;
	y: number;
	order: number;
	height: number;
	constructor(ownerDocument: Doc, y: number, order: number, height = 20) {
		this.ownerDocument = ownerDocument;
		this.y = y;
		this.order = order;
		this.height = height;
	}
	getBoundingClientRect(): { top: number; bottom: number; height: number } {
		const top =
			this.y +
			(this.flowAfter
				? this.flowAfter.getBoundingClientRect().height - this.flowAfter.height
				: 0) +
			this.animations.reduce((sum, animation) => sum + animation.offset, 0);
		const inlineHeight = Number.parseFloat(
			this.style.getPropertyValue("height"),
		);
		const height =
			[...this.animations]
				.reverse()
				.find((animation) => animation.animatedHeight !== null)
				?.animatedHeight ??
			(Number.isFinite(inlineHeight) ? inlineHeight : this.height);
		return { top, bottom: top + height, height };
	}
	closest(selector: string) {
		for (
			let current: Element | null = this;
			current;
			current = current.parentElement
		)
			if (
				selector
					.split(",")
					.some((tag) => current?.tagName === tag.toUpperCase())
			)
				return current;
		return null;
	}
	contains(other: Element): boolean {
		return (
			this === other ||
			(!!other.parentElement && this.contains(other.parentElement))
		);
	}
	hasAttribute() {
		return this.styleAttribute;
	}
	getAttribute(): string | null {
		return this.style.values.size
			? "position: relative"
			: this.styleAttribute
				? ""
				: null;
	}
	setAttribute(_name: string, _value: string) {
		this.styleAttribute = true;
	}
	removeAttribute() {
		this.styleAttribute = false;
		this.removedStyle++;
	}
	compareDocumentPosition(other: Element) {
		return other.order > this.order ? 4 : other.order < this.order ? 2 : 0;
	}
	animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
		const animation = new FakeAnimation(frames, options);
		animation.timeline = this.ownerDocument.timeline;
		this.animations.push(animation);
		return animation;
	}
	getAnimations() {
		return this.animations.filter(
			(animation) => !animation.cancelled && animation.playState !== "finished",
		);
	}
}
class Doc {
	timeline = { currentTime: 0 };
	leaves: Element[] = [];
	reduced = false;
	defaultView = {
		matchMedia: () => ({ matches: this.reduced }),
		getComputedStyle: (element: Element) => ({
			display: "block",
			position: "static",
			top: "auto",
			transform: "none",
			translate: "none",
			rotate: "none",
			scale: "none",
			writingMode: "horizontal-tb",
			...element.css,
		}),
	};
	querySelectorAll() {
		return this.leaves;
	}
}
function harness() {
	const outer = new Doc();
	const root = new Element(outer, 0, 0, 600);
	const margins: Element[] = [];
	Object.assign(root, { querySelectorAll: () => margins });
	const doc = new Doc();
	const first = new Element(outer, 0, 1, 500);
	const laterDoc = new Doc();
	const later = new Element(outer, 500, 2, 500);
	const source = new Element(doc, 10, 1);
	const node = new Element(doc, 50, 2, 80);
	const following = new Element(doc, 70, 3);
	following.flowAfter = node;
	later.flowAfter = first;
	doc.leaves = [source, following];
	const frames = [
		{ doc, element: first },
		{ doc: laterDoc, element: later },
	];
	const motion = new ReaderFlowMotion(
		() =>
			frames as unknown as Iterable<{
				doc: Document;
				element: HTMLIFrameElement;
			}>,
		() => root as unknown as HTMLElement,
	);
	return {
		outer,
		doc,
		root,
		margins,
		first,
		later,
		source,
		following,
		node,
		motion,
		laterDoc,
	};
}
const html = (element: Element) => element as unknown as HTMLElement;
function collapse(h: ReturnType<typeof harness>, node = h.node) {
	const height = node.getBoundingClientRect().height;
	node.style.setProperty("height", "0px");
	const transition = node.animate(
		[{ height: `${height}px` }, { height: "0px" }],
		{ duration: INLINE_MOTION_MS, easing: INLINE_MOTION_EASING, fill: "both" },
	);
	Object.assign(transition, { transitionProperty: "height" });
	h.motion.collapse(html(node));
	h.motion.synchronize([transition as unknown as Animation]);
	return transition;
}

test("generic layout changes preserve visual positions with residual FLIP", () => {
	const h = harness();
	let updates = 0;
	const result = h.motion.change(() => {
		updates++;
		h.following.y += 80;
		h.later.y += 80;
		return "done";
	});
	assert.equal(result, "done");
	assert.equal(updates, 1);
	assert.equal(h.source.animations.length, 0);
	assert.equal(h.following.getBoundingClientRect().top, 70);
	assert.equal(h.later.getBoundingClientRect().top, 500);
	assert.equal(h.motion.running, true);
	for (const target of [h.following, h.later]) {
		const animation = target.animations[0];
		assert.ok(animation);
		assert.equal(animation.options.duration, INLINE_MOTION_MS);
		assert.equal(animation.options.easing, INLINE_MOTION_EASING);
		assert.equal(animation.frames[0]?.composite, "add");
		animation.finish();
	}
	assert.equal(h.following.getBoundingClientRect().top, 150);
	assert.equal(h.motion.running, false);
});

test("growth expands real node and iframe heights without adding a second displacement to following content", () => {
	const h = harness();
	h.node.style.setProperty("height", "0px");
	h.following.y = 150;
	h.later.y = 580;
	h.first.style.setProperty("height", "420px");
	let transition: FakeAnimation | undefined;
	h.motion.change(
		() => {
			h.node.style.setProperty("height", "80px");
			h.first.style.setProperty("height", "500px");
			transition = h.node.animate([{ height: "0px" }, { height: "80px" }], {
				duration: INLINE_MOTION_MS,
			});
			Object.assign(transition, { transitionProperty: "height" });
		},
		() => ({ node: html(h.node), fromHeight: 0, fullHeight: 80 }),
	);
	const resize = h.first.animations[0];
	assert.ok(resize && transition);
	assert.deepEqual(resize.frames, [{ height: "420px" }, { height: "500px" }]);
	assert.equal(h.following.animations.length, 0);
	assert.equal(h.later.animations.length, 0);
	assert.equal(h.following.getBoundingClientRect().top, 70);
	assert.equal(h.later.getBoundingClientRect().top, 500);
	resize.progress = 0.5;
	transition.progress = 0.5;
	assert.equal(h.following.getBoundingClientRect().top, 110);
	assert.equal(h.later.getBoundingClientRect().top, 540);
	assert.deepEqual(
		h.motion.measure(() => [
			h.node.getBoundingClientRect().height,
			h.first.getBoundingClientRect().height,
			h.following.getBoundingClientRect().top,
			h.later.getBoundingClientRect().top,
		]),
		[80, 500, 150, 580],
	);
	assert.equal(h.node.getBoundingClientRect().height, 40);
	transition.finish();
	resize.finish();
	assert.equal(h.following.getBoundingClientRect().top, 150);
	assert.equal(h.later.getBoundingClientRect().top, 580);
	assert.equal(
		h.motion.running,
		false,
		"finished opening geometry must not keep position sampling paused",
	);
});

test("growing a partially collapsed node starts from its current actual space without a replacement FLIP", () => {
	const h = harness();
	h.following.y = 150;
	h.later.y = 580;
	const shrinking = collapse(h);
	const oldResize = h.first.animations[0];
	assert.ok(oldResize);
	shrinking.progress = 0.5;
	oldResize.progress = 0.5;
	assert.equal(h.node.getBoundingClientRect().height, 40);
	assert.equal(h.first.getBoundingClientRect().height, 460);
	h.motion.change(
		() => {
			h.node.style.setProperty("height", "80px");
			h.first.style.setProperty("height", "500px");
			const growing = h.node.animate([{ height: "40px" }, { height: "80px" }], {
				duration: INLINE_MOTION_MS,
			});
			Object.assign(growing, { transitionProperty: "height" });
		},
		() => ({ node: html(h.node), fromHeight: 40, fullHeight: 80 }),
	);
	assert.equal(h.following.getBoundingClientRect().top, 110);
	assert.equal(h.later.getBoundingClientRect().top, 540);
	assert.equal(h.following.animations.length, 0);
	assert.equal(h.later.animations.length, 0);
	assert.deepEqual(h.first.animations.at(-1)?.frames, [
		{ height: "460px" },
		{ height: "500px" },
	]);
	h.motion.clear();
	assert.equal(h.node.getBoundingClientRect().height, 80);
	assert.equal(h.first.getBoundingClientRect().height, 500);
});

test("growth keeps pending margin geometry until the full target coordinates commit", () => {
	const h = harness();
	h.node.style.setProperty("height", "0px");
	h.following.y = 150;
	h.first.style.setProperty("height", "420px");
	const margin = new Element(h.outer, 70, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	h.motion.change(
		() => {
			h.node.style.setProperty("height", "80px");
			h.first.style.setProperty("height", "500px");
			const animation = h.node.animate(
				[{ height: "0px" }, { height: "80px" }],
				{ duration: INLINE_MOTION_MS },
			);
			Object.assign(animation, { transitionProperty: "height" });
		},
		() => ({ node: html(h.node), fromHeight: 0, fullHeight: 80 }),
	);
	assert.equal(margin.animations.length, 0);
	margin.y = 150;
	h.motion.marginsChanged();
	const animation = margin.animations[0];
	assert.ok(animation);
	assert.deepEqual(animation.frames, [
		{ transform: "translateY(-80px)", composite: "add" },
		{ transform: "translateY(0px)", composite: "add" },
	]);
	assert.equal(margin.getBoundingClientRect().top, 70);
});

test("cross-frame growth combines a prior target removal with actual new node height without double-moving its child", () => {
	const h = harness();
	h.following.y = 150;
	const node = new Element(h.laterDoc, 0, 0, 40);
	node.style.setProperty("height", "0px");
	const child = new Element(h.laterDoc, 60, 1);
	child.flowAfter = node;
	h.laterDoc.leaves.push(child);
	h.motion.change(
		() => {
			h.node.style.setProperty("height", "0px");
			h.first.style.setProperty("height", "420px");
			node.style.setProperty("height", "40px");
			h.later.style.setProperty("height", "540px");
			const animation = node.animate([{ height: "0px" }, { height: "40px" }], {
				duration: INLINE_MOTION_MS,
			});
			Object.assign(animation, { transitionProperty: "height" });
		},
		() => ({ node: html(node), fromHeight: 0, fullHeight: 40 }),
	);
	assert.equal(
		h.later.getBoundingClientRect().top + child.getBoundingClientRect().top,
		520,
	);
	assert.equal(child.animations.length, 0);
	assert.deepEqual(h.later.animations[0]?.frames, [
		{ height: "500px" },
		{ height: "540px" },
	]);
	assert.equal(
		h.later.animations.length,
		1,
		"the previous frame's real height accounts for the outer displacement",
	);
	assert.deepEqual(h.first.animations[0]?.frames, [
		{ height: "500px" },
		{ height: "420px" },
	]);
	assert.deepEqual(h.following.animations[0]?.frames, [
		{ transform: "translateY(80px)", composite: "add" },
		{ transform: "translateY(0px)", composite: "add" },
	]);
});

test("closing during growth starts from current iframe height and never double-compensates following frames", () => {
	const h = harness();
	h.node.style.setProperty("height", "0px");
	h.following.y = 150;
	h.later.y = 580;
	h.first.style.setProperty("height", "420px");
	const margin = new Element(h.outer, 70, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	let growing: FakeAnimation | undefined;
	h.motion.change(
		() => {
			h.node.style.setProperty("height", "80px");
			h.first.style.setProperty("height", "500px");
			growing = h.node.animate([{ height: "0px" }, { height: "80px" }], {
				duration: INLINE_MOTION_MS,
			});
			Object.assign(growing, { transitionProperty: "height" });
		},
		() => ({ node: html(h.node), fromHeight: 0, fullHeight: 80 }),
	);
	const oldResize = h.first.animations[0];
	assert.ok(growing && oldResize);
	margin.y = 150;
	h.motion.marginsChanged();
	const oldMargin = margin.animations[0];
	assert.ok(oldMargin);
	growing.progress = 0.6;
	oldResize.progress = 0.6;
	oldMargin.progress = 0.6;
	assert.equal(h.first.getBoundingClientRect().height, 468);
	assert.equal(h.following.getBoundingClientRect().top, 118);
	assert.equal(h.later.getBoundingClientRect().top, 548);
	assert.equal(margin.getBoundingClientRect().top, 118);
	h.node.style.setProperty("height", "0px");
	const shrinking = h.node.animate([{ height: "48px" }, { height: "0px" }], {
		duration: INLINE_MOTION_MS,
	});
	Object.assign(shrinking, { transitionProperty: "height" });
	h.motion.collapse(html(h.node), 80);
	h.motion.synchronize([shrinking as unknown as Animation]);
	const resize = h.first.animations.at(-1);
	assert.ok(resize);
	assert.deepEqual(resize.frames, [{ height: "468px" }, { height: "420px" }]);
	assert.equal(h.first.getBoundingClientRect().height, 468);
	assert.equal(h.following.getBoundingClientRect().top, 118);
	assert.equal(h.later.getBoundingClientRect().top, 548);
	assert.equal(h.later.animations.length, 0);
	assert.deepEqual(margin.animations.at(-1)?.frames, [
		{ transform: "translateY(-32px)", composite: "add" },
		{ transform: "translateY(-80px)", composite: "add" },
	]);
	assert.equal(margin.getBoundingClientRect().top, 118);
	resize.finish();
	shrinking.finish();
	assert.equal(h.following.getBoundingClientRect().top, 70);
	assert.equal(h.later.getBoundingClientRect().top, 500);
});

test("closing in a later frame continues earlier height residuals before sampling any position compensation", () => {
	const h = harness();
	h.first.style.setProperty("height", "420px");
	h.later.style.setProperty("height", "540px");
	const firstResize = h.first.animate(
		[{ height: "500px" }, { height: "420px" }],
		{ duration: INLINE_MOTION_MS },
	);
	const laterResize = h.later.animate(
		[{ height: "500px" }, { height: "540px" }],
		{ duration: INLINE_MOTION_MS },
	);
	Object.assign(firstResize, { transitionProperty: "height" });
	Object.assign(laterResize, { transitionProperty: "height" });
	h.motion.synchronize([firstResize, laterResize] as unknown as Animation[]);
	firstResize.progress = 0.5;
	laterResize.progress = 0.5;
	const node = new Element(h.laterDoc, 50, 1, 40);
	node.style.setProperty("height", "0px");
	const shrinking = node.animate([{ height: "20px" }, { height: "0px" }], {
		duration: INLINE_MOTION_MS,
	});
	Object.assign(shrinking, { transitionProperty: "height" });
	const following = new Element(h.laterDoc, 100, 2);
	following.flowAfter = node;
	h.laterDoc.leaves.push(following);
	const before =
		h.later.getBoundingClientRect().top + following.getBoundingClientRect().top;
	h.motion.collapse(html(node), 40);
	h.motion.synchronize([shrinking as unknown as Animation]);
	assert.deepEqual(h.first.animations.at(-1)?.frames, [
		{ height: "460px" },
		{ height: "420px" },
	]);
	assert.deepEqual(h.later.animations.at(-1)?.frames, [
		{ height: "520px" },
		{ height: "500px" },
	]);
	assert.equal(
		h.later.getBoundingClientRect().top + following.getBoundingClientRect().top,
		before,
	);
	assert.equal(following.animations.length, 0);
	assert.equal(
		h.later.animations.length,
		2,
		"only old and replacement heights are needed, with no second transform displacement",
	);
});

test("closing during a different-length replacement targets the final unexpanded frame rather than subtracting current node size", () => {
	const h = harness();
	h.first.style.setProperty("height", "570px");
	let growing: FakeAnimation | undefined;
	h.motion.change(
		() => {
			h.first.style.setProperty("height", "470px");
			h.node.style.setProperty("height", "50px");
			growing = h.node.animate([{ height: "0px" }, { height: "50px" }], {
				duration: INLINE_MOTION_MS,
			});
			Object.assign(growing, { transitionProperty: "height" });
		},
		() => ({ node: html(h.node), fromHeight: 0, fullHeight: 50 }),
	);
	const priorResize = h.first.animations[0];
	assert.ok(growing && priorResize);
	growing.progress = 0.4;
	priorResize.progress = 0.5;
	assert.equal(h.first.getBoundingClientRect().height, 520);
	assert.equal(h.node.getBoundingClientRect().height, 20);
	h.node.style.setProperty("height", "0px");
	h.node.animate([{ height: "20px" }, { height: "0px" }], {
		duration: INLINE_MOTION_MS,
	});
	h.motion.collapse(html(h.node), 50);
	assert.deepEqual(h.first.animations.at(-1)?.frames, [
		{ height: "520px" },
		{ height: "420px" },
	]);
	assert.equal(h.first.getBoundingClientRect().height, 520);
});

test("translation effects and late margin commits share elapsed time across iframe timeline origins", () => {
	const h = harness();
	h.outer.timeline.currentTime = 1000;
	h.doc.timeline.currentTime = 200;
	const margin = new Element(h.outer, 70, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	h.motion.change(() => {
		h.following.y += 80;
		h.later.y += 80;
	});
	assert.equal(h.following.animations[0]?.startTime, 200);
	assert.equal(h.later.animations[0]?.startTime, 1000);
	let duration = 70;
	const transition = {
		timeline: h.doc.timeline,
		startTime: null as number | null,
		effect: {
			updateTiming: (timing: OptionalEffectTiming) => {
				duration = Number(timing.duration);
			},
		},
	} as unknown as Animation;
	h.outer.timeline.currentTime = 1040;
	h.doc.timeline.currentTime = 240;
	h.motion.synchronize([transition]);
	assert.equal(
		duration,
		INLINE_MOTION_MS,
		"CSS reverse shortening cannot finish before the flow",
	);
	assert.equal(
		transition.startTime,
		200,
		"different document origins must not introduce a phase gap",
	);
	margin.y += 80;
	h.outer.timeline.currentTime = 1080;
	h.motion.marginsChanged();
	assert.equal(
		margin.animations[0]?.startTime,
		1000,
		"a late React commit joins the active clock",
	);
});

test("collapse contracts real node and frame geometry together and clear keeps the collapsed layout", () => {
	const h = harness();
	h.following.y += 80;
	h.later.y += 80;
	const transition = collapse(h);
	assert.equal(h.source.animations.length, 0);
	assert.equal(h.following.y, 150);
	assert.equal(h.later.y, 580);
	assert.equal(
		h.following.animations.length,
		0,
		"same-frame suffix follows actual node height instead of transform",
	);
	assert.equal(
		h.later.animations.length,
		0,
		"later frames follow the real iframe height",
	);
	assert.equal(h.first.style.getPropertyValue("height"), "420px");
	const resize = h.first.animations[0];
	assert.ok(resize);
	assert.deepEqual(resize.frames, [{ height: "500px" }, { height: "420px" }]);
	transition.progress = 0.5;
	resize.progress = 0.5;
	assert.equal(h.following.getBoundingClientRect().top, 110);
	assert.equal(h.first.getBoundingClientRect().height, 460);
	assert.equal(h.later.getBoundingClientRect().top, 540);
	assert.deepEqual(
		h.motion.measure(() => [
			h.node.getBoundingClientRect().height,
			h.first.getBoundingClientRect().height,
			h.following.getBoundingClientRect().top,
			h.later.getBoundingClientRect().top,
		]),
		[0, 420, 70, 500],
	);
	assert.equal(
		h.first.getBoundingClientRect().height,
		460,
		"canonical sampling restores the actual in-flight height",
	);
	transition.finish();
	resize.finish();
	assert.equal(h.following.getBoundingClientRect().top, 70);
	assert.equal(h.later.getBoundingClientRect().top, 500);
	assert.equal(
		h.motion.running,
		true,
		"geometry effects stay registered until opacity completion owns removal",
	);
	h.motion.beforeRemove();
	assert.equal(h.motion.running, false);
	assert.equal(h.following.getBoundingClientRect().top, 70);
	assert.equal(h.first.getBoundingClientRect().height, 420);
});

test("clearing actual height motion midway commits final geometry and clamps short frames to 32px", () => {
	const h = harness();
	h.first.height = 50;
	const transition = collapse(h);
	const resize = h.first.animations[0];
	assert.ok(resize);
	assert.deepEqual(resize.frames, [{ height: "50px" }, { height: "32px" }]);
	transition.progress = 0.5;
	resize.progress = 0.5;
	assert.equal(h.first.getBoundingClientRect().height, 41);
	h.motion.clear();
	assert.equal(h.first.getBoundingClientRect().height, 32);
	assert.equal(h.node.getBoundingClientRect().height, 0);
	assert.equal(transition.cancelled, true);
	assert.equal(h.motion.running, false);
});

test("synchronized CSS height and padding effects participate in canonical reads and clear, while opacity stays with its owner", () => {
	const h = harness();
	h.motion.change(() => {});
	const animations = [
		"height",
		"padding-top",
		"padding-bottom",
		"opacity",
		"clip-path",
	].map((transitionProperty) => {
		const animation = h.node.animate([], { duration: 30 });
		Object.assign(animation, { transitionProperty });
		return animation;
	});
	h.motion.synchronize(animations as unknown as Animation[]);
	h.motion.synchronize(animations as unknown as Animation[]);
	assert.equal(h.motion.running, true);
	h.motion.measure(() => {
		for (const [index, animation] of animations.entries())
			assert.equal(animation.effect === null, index < 3);
	});
	assert.ok(animations.every((animation) => animation.effect !== null));
	h.motion.clear();
	for (const [index, animation] of animations.entries())
		assert.equal(animation.cancelled, index < 3);
});

test("interrupted reopening continues at the current visual position and stale completion cannot cancel it", () => {
	const h = harness();
	h.following.y += 80;
	const old = collapse(h);
	assert.ok(old);
	old.progress = 0.5;
	const stale = old.onfinish;
	h.motion.change(() => {
		h.node.style.removeProperty("height");
		h.first.style.setProperty("height", "500px");
	});
	assert.equal(old.cancelled, true);
	assert.equal(h.following.getBoundingClientRect().top, 110);
	stale?.();
	assert.equal(h.motion.running, true);
	h.motion.clear();
	assert.equal(h.following.getBoundingClientRect().top, 150);
	assert.equal(h.motion.running, false);
});

test("closing a new target continues residual movement before that target without a jump", () => {
	const h = harness();
	h.motion.change(() => {
		h.source.y -= 80;
	});
	const animation = h.source.animations[0];
	assert.ok(animation);
	animation.progress = 0.5;
	const before = h.source.getBoundingClientRect().top;
	h.motion.collapse(html(h.node));
	assert.equal(h.source.getBoundingClientRect().top, before);
	assert.deepEqual(h.source.animations.at(-1)?.frames, [
		{ transform: "translateY(40px)", composite: "add" },
		{ transform: "translateY(0px)", composite: "add" },
	]);
});

test("cross-frame replacement composes frame movement with changed internal paragraph layout", () => {
	const h = harness();
	const child = new Element(h.laterDoc, 20, 1);
	h.laterDoc.leaves.push(child);
	h.motion.change(() => {
		h.later.y -= 80;
		child.y += 40;
	});
	assert.equal(
		h.later.getBoundingClientRect().top + child.getBoundingClientRect().top,
		520,
	);
	assert.deepEqual(child.animations[0]?.frames, [
		{ transform: "translateY(-40px)", composite: "add" },
		{ transform: "translateY(0px)", composite: "add" },
	]);
	const outerAnimation = h.later.animations[0];
	const childAnimation = child.animations[0];
	assert.ok(outerAnimation && childAnimation);
	outerAnimation.progress = 0.5;
	childAnimation.progress = 0.5;
	const before =
		h.later.getBoundingClientRect().top + child.getBoundingClientRect().top;
	const node = new Element(h.laterDoc, 10, 0, 40);
	h.motion.collapse(html(node));
	assert.equal(
		h.later.getBoundingClientRect().top + child.getBoundingClientRect().top,
		before,
	);
	assert.deepEqual(h.later.animations.at(-1)?.frames, [
		{ transform: "translateY(40px)", composite: "add" },
		{ transform: "translateY(0px)", composite: "add" },
	]);
});

test("canonical measurement temporarily detaches effects and restores their timeline even when reading throws", () => {
	const h = harness();
	h.motion.change(() => {
		h.following.y += 80;
	});
	const animation = h.following.animations[0];
	assert.ok(animation);
	animation.progress = 0.5;
	animation.currentTime = INLINE_MOTION_MS / 2;
	const originalEffect = animation.effect;
	const finish = animation.onfinish;
	assert.equal(h.following.getBoundingClientRect().top, 110);
	assert.equal(
		h.motion.measure(() => h.following.getBoundingClientRect().top),
		150,
	);
	assert.equal(h.following.getBoundingClientRect().top, 110);
	assert.equal(animation.effect, originalEffect);
	assert.equal(animation.currentTime, INLINE_MOTION_MS / 2);
	assert.equal(animation.cancelled, false);
	assert.throws(
		() =>
			h.motion.measure(() => {
				throw new Error("failed read");
			}),
		/failed read/,
	);
	assert.equal(animation.effect, originalEffect);
	finish?.();
	assert.equal(
		h.motion.running,
		true,
		"an earlier finish event cannot remove a currently running effect",
	);
	h.motion.measure(() => h.motion.clear());
	assert.equal(
		h.motion.running,
		false,
		"clearing during the read cannot resurrect disposed effects",
	);
});

test("br-only inline targets retain their line boxes and restore position value and priority", () => {
	const h = harness();
	h.following.tagName = "SPAN";
	h.following.css = { display: "inline", position: "relative", top: "3px" };
	h.following.style.setProperty("position", "relative", "important");
	h.motion.change(() => {
		h.following.y += 80;
	});
	const animation = h.following.animations[0];
	assert.ok(animation);
	assert.deepEqual(animation.frames, [{ top: "-77px" }, { top: "3px" }]);
	assert.equal(h.following.style.getPropertyValue("display"), "");
	assert.equal(h.following.style.getPropertyValue("top"), "");
	h.motion.clear();
	assert.equal(h.following.style.getPropertyValue("position"), "relative");
	assert.equal(h.following.style.getPropertyPriority("position"), "important");

	h.following.css.position = "static";
	h.following.css.top = "auto";
	h.following.style.removeProperty("position");
	h.following.removeAttribute();
	const removals = h.following.removedStyle;
	h.motion.change(() => {
		h.following.y += 20;
	});
	h.motion.clear();
	assert.equal(h.following.style.getPropertyValue("position"), "");
	assert.equal(
		h.following.removedStyle,
		removals + 1,
		"originally absent style attribute is removed after restoring its last property",
	);
});

test("inline motion never activates dormant author insets or overrides important top", () => {
	for (const css of [
		{ position: "static", top: "10px" },
		{ position: "static", right: "20px" },
		{ position: "static", bottom: "2px" },
		{ position: "static", left: "-5px" },
		{ position: "relative", top: "auto", bottom: "10px" },
		{ position: "relative", top: "10%" },
	] as Record<string, string>[]) {
		const h = harness();
		h.following.tagName = "SPAN";
		h.following.css = { display: "inline", ...css };
		h.motion.change(() => {
			h.following.y += 80;
		});
		assert.equal(h.following.animations.length, 0, JSON.stringify(css));
		assert.equal(h.following.style.getPropertyValue("position"), "");
	}
	for (const position of ["static", "relative"]) {
		const h = harness();
		h.following.tagName = "SPAN";
		h.following.css = { display: "inline", position, top: "0px" };
		h.following.style.setProperty("top", "0px", "important");
		h.motion.change(() => {
			h.following.y += 80;
		});
		assert.equal(h.following.animations.length, 0);
		assert.equal(h.following.style.getPropertyValue("top"), "0px");
		assert.equal(h.following.style.getPropertyPriority("top"), "important");
	}
});

test("inline cleanup restores exact author style text without discarding concurrent declarations", () => {
	for (const concurrent of [false, true]) {
		const h = harness();
		h.following.tagName = "SPAN";
		h.following.css.display = "inline";
		h.following.style.setProperty("color", "red");
		const original = "color:red;   ";
		let restored: string | null = null;
		h.following.getAttribute = () => original;
		h.following.setAttribute = (_name, value) => {
			restored = value;
		};
		h.motion.change(() => {
			h.following.y += 80;
		});
		if (concurrent) h.following.style.setProperty("font-weight", "bold");
		h.motion.clear();
		assert.equal(restored, concurrent ? null : original);
		assert.equal(h.following.style.getPropertyValue("position"), "");
		if (concurrent)
			assert.equal(h.following.style.getPropertyValue("font-weight"), "bold");
	}
});

test("candidates newly entering view animate while distant text never receives an effect", () => {
	const h = harness();
	h.following.y = 1600;
	const distant = new Element(h.doc, 5000, 6);
	h.doc.leaves.push(distant);
	h.motion.change(() => {
		h.following.y = 200;
		distant.y = 3600;
	});
	assert.equal(h.following.animations.length, 1);
	assert.equal(h.following.getBoundingClientRect().top, 1600);
	assert.equal(distant.animations.length, 0);
});

test("image figures move once including their caption and keep original descendants intact", () => {
	const h = harness();
	const figure = new Element(h.doc, 90, 5, 120);
	figure.tagName = "FIGURE";
	const image = new Element(h.doc, 90, 6, 100);
	image.tagName = "IMG";
	image.parentElement = figure;
	const caption = new Element(h.doc, 190, 7);
	caption.parentElement = figure;
	h.doc.leaves.push(image, caption);
	h.motion.change(() => {
		figure.y += 80;
	});
	assert.equal(figure.animations.length, 1);
	assert.equal(image.animations.length, 0);
	assert.equal(caption.animations.length, 0);
	assert.equal(image.parentElement, figure);
});

test("reader centering translations allow whole-frame motion while UI scaling remains excluded", () => {
	const h = harness();
	h.later.parentElement = h.root;
	h.root.css.transform = "matrix(1, 0, 0, 1, -300, 0)";
	h.motion.change(() => {
		h.later.y += 80;
	});
	assert.equal(h.later.animations.length, 1);
	h.motion.clear();
	h.root.css.transform = "matrix(2, 0, 0, 2, -300, 0)";
	h.motion.change(() => {
		h.later.y += 80;
	});
	assert.equal(
		h.later.animations.length,
		1,
		"a scaled outer coordinate space gets no new animation",
	);
});

test("margin FLIP matches element identity after commit and ignores detached old groups", () => {
	const h = harness();
	const margin = new Element(h.outer, 70, 4);
	margin.css.position = "absolute";
	const detached = new Element(h.outer, 100, 5);
	h.margins.push(margin, detached);
	h.motion.change(() => {
		h.following.y += 80;
	});
	margin.y += 80;
	detached.isConnected = false;
	h.motion.marginsChanged();
	assert.equal(margin.getBoundingClientRect().top, 70);
	assert.equal(detached.animations.length, 0);
	h.motion.clear();
	h.motion.marginsChanged();
	assert.equal(
		margin.animations.length,
		1,
		"cleared pending samples cannot replay",
	);
});

test("collapse retains the margin visual position until React commits its canonical top", () => {
	const h = harness();
	const margin = new Element(h.outer, 150, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	h.following.y += 80;
	h.motion.collapse(html(h.node));
	margin.animations[0]?.finish();
	assert.equal(margin.getBoundingClientRect().top, 70);
	h.motion.beforeRemove();
	assert.equal(
		margin.getBoundingClientRect().top,
		70,
		"clearing source effects cannot expose the old React top",
	);
	margin.y = 70;
	h.motion.marginsChanged();
	assert.equal(margin.getBoundingClientRect().top, 70);
});

test("collapse compares margin positions with the canonical boundary after residual frame motion is cancelled", () => {
	const h = harness();
	const margin = new Element(h.outer, 80, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	h.motion.change(() => {
		h.first.y -= 80;
		margin.y -= 80;
	});
	h.motion.marginsChanged();
	const frameAnimation = h.first.animations.at(-1);
	const marginAnimation = margin.animations.at(-1);
	assert.ok(frameAnimation && marginAnimation);
	frameAnimation.progress = 0.5;
	marginAnimation.progress = 0.5;
	assert.equal(
		h.first.getBoundingClientRect().top + h.node.getBoundingClientRect().top,
		10,
	);
	h.motion.collapse(html(h.node));
	assert.equal(h.first.y + h.node.y, -30);
	assert.equal(margin.y, 0);
	assert.equal(
		margin.animations.at(-1)?.frames.at(-1)?.transform,
		"translateY(-80px)",
	);
});

test("a no-op reopen retargets retained margin effects without waiting for a React commit", () => {
	const h = harness();
	const margin = new Element(h.outer, 150, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	h.motion.collapse(html(h.node));
	margin.animations[0]?.finish();
	h.motion.change(() => {});
	assert.equal(margin.getBoundingClientRect().top, 70);
	margin.animations.at(-1)?.finish();
	for (const animation of h.following.animations)
		if (!animation.cancelled) animation.finish();
	for (const animation of h.later.animations)
		if (!animation.cancelled) animation.finish();
	assert.equal(h.motion.running, false);
});

test("enabling reduced motion before the margin commit releases retained effects", () => {
	const h = harness();
	const margin = new Element(h.outer, 70, 4);
	margin.css.position = "absolute";
	h.margins.push(margin);
	h.motion.change(() => {
		h.following.y += 80;
	});
	margin.y = 150;
	h.motion.marginsChanged();
	assert.equal(h.motion.running, true);
	const animation = margin.animations[0];
	assert.ok(animation);
	h.outer.reduced = true;
	h.motion.beforeRemove();
	margin.y = 70;
	h.motion.marginsChanged();
	assert.equal(animation.cancelled, true);
	assert.equal(margin.getBoundingClientRect().top, 70);
	assert.equal(h.motion.running, false);
});

test("complex author transforms are preserved and reduced motion applies updates without effects", () => {
	const h = harness();
	h.following.css.transform = "matrix(1, 0, 0, 1, 0, 10)";
	h.motion.change(() => {
		h.following.y += 80;
	});
	assert.equal(h.following.animations.length, 0);
	assert.equal(h.following.css.transform, "matrix(1, 0, 0, 1, 0, 10)");
	h.outer.reduced = true;
	h.motion.change(() => {
		h.later.y += 80;
	});
	assert.equal(h.later.animations.length, 0);
	assert.equal(h.motion.running, false);
});
