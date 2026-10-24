import assert from "node:assert/strict";
import test from "node:test";
import {
	isReaderFrameTarget,
	registerReaderFrameTargets,
	snapshotReaderFrameTargets,
} from "./focus.ts";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import { applyFramePresentation } from "./presentation.ts";

test("in-place ruby registers only reader-created targets and keeps later extension UI isolated", () => {
	const base = { nodeType: 1 };
	const ruby = { nodeType: 1 };
	const rt = { nodeType: 1 };
	const extension = { nodeType: 1 };
	let nodes = [base];
	const doc = { querySelectorAll: () => nodes } as unknown as Document;
	snapshotReaderFrameTargets(doc);
	nodes = [base, ruby, rt, extension];
	registerReaderFrameTargets(doc, [ruby, rt] as unknown as Element[]);
	assert.equal(isReaderFrameTarget(doc, base as unknown as EventTarget), true);
	assert.equal(isReaderFrameTarget(doc, ruby as unknown as EventTarget), true);
	assert.equal(isReaderFrameTarget(doc, rt as unknown as EventTarget), true);
	assert.equal(
		isReaderFrameTarget(doc, extension as unknown as EventTarget),
		false,
	);
});
test("repeated in-place range changes preserve the document and release presentation listeners", () => {
	const style = { textContent: "" };
	const ruby = { nodeType: 1, toggleAttribute: () => false };
	const doc = Object.assign(new EventTarget(), {
		documentElement: { dataset: {} as Record<string, string> },
		getElementById: () => style,
		head: { prepend: () => {} },
		querySelectorAll: () => [ruby],
		getSelection: () => null,
	});
	let activeListeners = 0;
	const add = doc.addEventListener.bind(doc);
	const remove = doc.removeEventListener.bind(doc);
	doc.addEventListener = (...args) => {
		activeListeners++;
		add(...args);
	};
	doc.removeEventListener = (...args) => {
		activeListeners--;
		remove(...args);
	};
	for (let pass = 0; pass < 20; pass++) {
		const scope = pass % 2 ? "all" : "original";
		const cleanup = applyFramePresentation(
			doc as unknown as Document,
			"white",
			{ ...DEFAULT_BOOK_UI, rubyScope: scope },
		);
		assert.equal(doc.documentElement.dataset.readerRubyScope, scope);
		assert.ok(activeListeners > 0);
		cleanup();
		assert.equal(activeListeners, 0);
		assert.equal(doc.querySelectorAll()[0], ruby);
	}
});
