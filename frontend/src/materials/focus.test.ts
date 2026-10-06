import assert from "node:assert/strict";
import test from "node:test";
import {
	createFocusController,
	distance,
	FOCUS_TIMING,
	isReaderFrameTarget,
	ordinaryTap,
	snapshotReaderFrameTargets,
} from "./focus.ts";

test("gesture thresholds reject drag and long press while permitting touch taps", () => {
	const start = { x: 10, y: 20 };
	assert.equal(ordinaryTap(start, { x: 15, y: 20 }, 499), true);
	assert.equal(ordinaryTap(start, { x: 16, y: 20 }, 100), false);
	assert.equal(ordinaryTap(start, start, 500), false);
	assert.equal(distance(start, { x: 13, y: 24 }), 5);
	assert.deepEqual(FOCUS_TIMING, {
		idle: 3000,
		jitter: 4,
		clickDelay: 240,
		drag: 6,
		longPress: 500,
	});
});

test("controller idle, overlay, focus preference, and teardown share one timer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const doc = new EventTarget() as EventTarget & {
		querySelectorAll: () => [];
		getSelection: () => null;
		activeElement: null;
		body: null;
		defaultView: null;
		hidden: boolean;
	};
	Object.assign(doc, {
		querySelectorAll: () => [],
		getSelection: () => null,
		activeElement: null,
		body: null,
		defaultView: null,
		hidden: false,
	});
	const root = new EventTarget() as EventTarget & {
		ownerDocument: typeof doc;
		getBoundingClientRect: () => { left: number; top: number };
	};
	Object.assign(root, {
		ownerDocument: doc,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	let overlay = false;
	const updates: boolean[] = [];
	const controller = createFocusController({
		root: root as unknown as HTMLElement,
		onVisibilityChange: (value) => updates.push(value),
		hasOverlay: () => overlay,
	});
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, false);
	controller.show();
	overlay = true;
	controller.refresh();
	t.mock.timers.tick(6000);
	assert.equal(controller.visible, true);
	overlay = false;
	controller.refresh();
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, false);
	controller.setFocus(false);
	t.mock.timers.tick(6000);
	assert.equal(controller.visible, true);
	controller.setFocus(true);
	controller.dispose();
	t.mock.timers.tick(6000);
	assert.equal(controller.visible, true);
	assert.deepEqual(updates, [true, false, true, false, true]);
});

test("frame taps, selection, double clicks, and normalized mouse jitter preserve intent", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let selection = "";
	const makeDoc = () =>
		Object.assign(new EventTarget(), {
			querySelectorAll: () => [],
			getSelection: () => ({
				isCollapsed: !selection,
				toString: () => selection,
			}),
			activeElement: null,
			body: null,
			defaultView: null,
			hidden: false,
		});
	const doc = makeDoc();
	const root = Object.assign(new EventTarget(), {
		ownerDocument: doc,
		getBoundingClientRect: () => ({ left: 20, top: 10 }),
	});
	const controller = createFocusController({
		root: root as unknown as HTMLElement,
		onVisibilityChange: () => {},
	});
	const frameDoc = makeDoc();
	const cleanup = controller.bindFrame(
		frameDoc as unknown as Document,
		{
			getBoundingClientRect: () => ({ left: 100, top: 100 }),
		} as HTMLIFrameElement,
	);
	const pointer = (
		target: EventTarget,
		type: string,
		x: number,
		y: number,
		pointerType = "mouse",
	) => {
		const e = new Event(type, { cancelable: true });
		Object.assign(e, {
			clientX: x,
			clientY: y,
			pointerId: 1,
			pointerType,
			button: 0,
			isPrimary: true,
		});
		target.dispatchEvent(e);
	};
	pointer(frameDoc, "pointerdown", 10, 10, "touch");
	pointer(frameDoc, "pointerup", 10, 10, "touch");
	pointer(frameDoc, "pointerout", 10, 10, "touch");
	t.mock.timers.tick(240);
	assert.equal(controller.visible, false);
	pointer(root, "pointermove", 111, 110);
	assert.equal(controller.visible, false);
	pointer(root, "pointermove", 115, 110);
	assert.equal(controller.visible, true);
	pointer(frameDoc, "pointerdown", 10, 10);
	pointer(frameDoc, "pointerup", 10, 10);
	frameDoc.dispatchEvent(new Event("dblclick"));
	t.mock.timers.tick(240);
	assert.equal(controller.visible, true);
	selection = "word";
	frameDoc.dispatchEvent(new Event("selectionchange"));
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, true);
	selection = "";
	frameDoc.dispatchEvent(new Event("selectionchange"));
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, false);
	cleanup();
	controller.dispose();
});

test("folding a pre-existing selection and disposing an old duplicate frame cannot toggle tools", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let selection = "selected";
	const doc = Object.assign(new EventTarget(), {
		querySelectorAll: () => [],
		getSelection: () => ({
			isCollapsed: !selection,
			toString: () => selection,
		}),
		activeElement: null,
		body: null,
		defaultView: null,
		hidden: false,
	});
	const root = Object.assign(new EventTarget(), {
		ownerDocument: doc,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	let tabs = 0;
	const controller = createFocusController({
		root: root as unknown as HTMLElement,
		onVisibilityChange: () => {},
		onTabReveal: () => {
			tabs++;
			assert.equal(controller.visible, true);
		},
	});
	const frame = {
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	} as HTMLIFrameElement;
	const frameDoc = Object.assign(new EventTarget(), {
		querySelectorAll: () => [],
		getSelection: doc.getSelection,
		activeElement: null,
		body: null,
	});
	const old = controller.bindFrame(frameDoc as unknown as Document, frame);
	controller.bindFrame(frameDoc as unknown as Document, frame);
	old();
	const pointer = (type: string) => {
		const e = new Event(type);
		Object.assign(e, {
			clientX: 1,
			clientY: 1,
			pointerId: 1,
			button: 0,
			isPrimary: true,
			pointerType: "mouse",
		});
		frameDoc.dispatchEvent(e);
	};
	pointer("pointerdown");
	selection = "";
	pointer("pointerup");
	t.mock.timers.tick(240);
	assert.equal(controller.visible, true);
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, false);
	const tab = new Event("keydown");
	Object.assign(tab, { key: "Tab" });
	frameDoc.dispatchEvent(tab);
	assert.equal(tabs, 1);
	assert.equal(controller.visible, true);
	controller.dispose();
});

test("native Tab on document body reveals tools before navigation once, but ignores unrelated focus and removed reader", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const body = {};
	const doc = Object.assign(new EventTarget(), {
		querySelectorAll: () => [],
		getSelection: () => null,
		activeElement: body as object,
		body,
		defaultView: null,
		hidden: false,
	});
	const root = Object.assign(new EventTarget(), {
		ownerDocument: doc,
		isConnected: true,
		contains: () => false,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	let reveals = 0;
	const controller = createFocusController({
		root: root as unknown as HTMLElement,
		onVisibilityChange: () => {},
		onTabReveal: () => {
			reveals++;
			assert.equal(controller.visible, true);
		},
	});
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, false);
	const tab = () => {
		const e = new Event("keydown");
		Object.assign(e, { key: "Tab" });
		doc.dispatchEvent(e);
	};
	tab();
	assert.equal(reveals, 1);
	t.mock.timers.tick(3000);
	doc.activeElement = {};
	tab();
	assert.equal(controller.visible, false);
	assert.equal(reveals, 1);
	doc.activeElement = body;
	root.isConnected = false;
	tab();
	assert.equal(reveals, 1);
	controller.dispose();
});

test("original frame element snapshot excludes extension nodes on first bind and later rebinding", () => {
	const original = { nodeType: 1 };
	const injected = { nodeType: 1 };
	let elements = [original];
	const doc = { querySelectorAll: () => elements } as unknown as Document;
	snapshotReaderFrameTargets(doc);
	assert.equal(
		isReaderFrameTarget(doc, original as unknown as EventTarget),
		true,
	);
	elements = [original, injected];
	snapshotReaderFrameTargets(doc);
	assert.equal(
		isReaderFrameTarget(doc, injected as unknown as EventTarget),
		false,
	);
	assert.equal(
		isReaderFrameTarget(doc, {
			nodeType: 3,
			parentElement: original,
		} as unknown as EventTarget),
		true,
	);
});

test("extension frame pointer and keyboard events run naturally without revealing or consuming reader commands", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const original = { nodeType: 1, closest: () => null };
	const injected = { nodeType: 1, closest: () => null };
	const makeDoc = () =>
		Object.assign(new EventTarget(), {
			querySelectorAll: () => [original],
			getSelection: () => null,
			body: null,
			activeElement: null,
			defaultView: null,
			hidden: false,
		});
	const doc = makeDoc();
	const frameDoc = makeDoc();
	const root = Object.assign(new EventTarget(), {
		ownerDocument: doc,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	let escapes = 0;
	const controller = createFocusController({
		root: root as unknown as HTMLElement,
		onVisibilityChange: () => {},
		onEscapeOverlay: () => {
			escapes++;
			return true;
		},
	});
	controller.bindFrame(
		frameDoc as unknown as Document,
		{ getBoundingClientRect: () => ({ left: 0, top: 0 }) } as HTMLIFrameElement,
	);
	t.mock.timers.tick(3000);
	assert.equal(controller.visible, false);
	for (const key of ["Tab", "Escape"]) {
		const e = new Event("keydown", { cancelable: true });
		Object.defineProperty(e, "target", { value: injected });
		Object.assign(e, { key });
		frameDoc.dispatchEvent(e);
		assert.equal(e.defaultPrevented, false);
	}
	const move = new Event("pointermove");
	Object.defineProperty(move, "target", { value: injected });
	Object.assign(move, { clientX: 200, clientY: 200, pointerType: "mouse" });
	frameDoc.dispatchEvent(move);
	assert.equal(controller.visible, false);
	assert.equal(escapes, 0);
	const tab = new Event("keydown");
	Object.defineProperty(tab, "target", { value: original });
	Object.assign(tab, { key: "Tab" });
	frameDoc.dispatchEvent(tab);
	assert.equal(controller.visible, true);
	controller.dispose();
});
