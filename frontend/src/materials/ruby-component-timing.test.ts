import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { anchorBeforeLayout } from "./position.ts";
import { DEFAULT_BOOK_UI } from "./preferences.ts";
import { ViewportRecovery } from "./viewport.ts";

const source = ts.createSourceFile(
	"MaterialReader.tsx",
	readFileSync(new URL("./MaterialReader.tsx", import.meta.url), "utf8"),
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TSX,
);
/** Execute the actual component callbacks with observable DOM probes, rather than restating their orchestration. */
function callback(
	match: (node: ts.Node) => boolean,
	bindings: Record<string, unknown>,
): () => void {
	let expression: ts.Node | undefined;
	const visit = (node: ts.Node) => {
		if (!expression && match(node)) expression = node;
		if (!expression) ts.forEachChild(node, visit);
	};
	visit(source);
	assert.ok(expression, "production callback exists");
	const code = ts.transpileModule(
		`const callback = ${expression.getText(source)};`,
		{ compilerOptions: { target: ts.ScriptTarget.ES2022 } },
	).outputText;
	return new Function(...Object.keys(bindings), `${code}; return callback;`)(
		...Object.values(bindings),
	) as () => void;
}
const isReflow = (node: ts.Node) =>
	ts.isArrowFunction(node) &&
	ts.isCallExpression(node.parent) &&
	ts.isVariableDeclaration(node.parent.parent) &&
	node.parent.parent.name.getText(source) === "reflowFrames";
const isLayoutEffect = (node: ts.Node) =>
	ts.isArrowFunction(node) &&
	ts.isCallExpression(node.parent) &&
	node.parent.expression.getText(source) === "useLayoutEffect";

test("actual reflow callback protects the stable anchor before a 1px measurement and restores before sampling resumes", () => {
	const size = { width: 760, height: 800 };
	const recovery = new ViewportRecovery();
	recovery.finish(recovery.begin(size), size);
	const root = {
		clientWidth: size.width,
		clientHeight: size.height,
		scrollTop: 600,
	};
	const pending: { current: { offset: number } | null } = { current: null };
	const events: string[] = [];
	const run = callback(isReflow, {
		container: { current: root },
		frames: {
			current: new Map([
				[
					0,
					{
						resize: () => {
							events.push("resize");
							assert.equal(recovery.restoring, true);
							root.scrollTop = 0;
							assert.equal(
								recovery.observe(size, () => root.scrollTop),
								null,
							);
						},
					},
				],
			]),
		},
		pending,
		captureLatest: {
			current: () => {
				events.push("capture");
				return { offset: root.scrollTop };
			},
		},
		anchorBeforeLayout,
		recovery: { current: recovery },
		timer: { current: null },
		viewportSize: () => size,
		appliedGeometry: { current: null },
		geometryKeyRef: { current: "new-layout" },
		restoreLatest: {
			current: (pass: Parameters<ViewportRecovery["finish"]>[0]) => {
				events.push("restore");
				root.scrollTop = pending.current?.offset ?? 0;
				recovery.finish(pass, size);
			},
		},
	});
	run();
	assert.deepEqual(events, ["capture", "resize", "restore"]);
	assert.equal(root.scrollTop, 600);
	assert.equal(
		recovery.observe(size, () => root.scrollTop),
		600,
	);
});
test("actual layout effect never resizes for appearance changes or late readings on a stable original-range surface", () => {
	const recovery = new ViewportRecovery();
	const size = { width: 760, height: 800 };
	recovery.finish(recovery.begin(size), size);
	let presentations = 0;
	for (const ruby of ["show", "hide", "on-demand"] as const) {
		const run = callback(isLayoutEffect, {
			viewportReady: true,
			container: { current: {} },
			chapter: { data: {} },
			frames: {
				current: new Map([
					[
						0,
						{
							doc: {},
							presentationCleanup: () => {},
							resize: () => assert.fail("paint-only change resized an iframe"),
						},
					],
				]),
			},
			appliedGeometry: { current: "same-layout" },
			geometryKey: "same-layout",
			recovery: { current: recovery },
			bookUi: { ...DEFAULT_BOOK_UI, ruby },
			theme: ruby === "hide" ? "black" : "white",
			readings: { data: { resources: [{ tokens: [] }] } },
			applyFramePresentation: () => {
				presentations++;
				return () => {};
			},
			reflowFrames: () =>
				assert.fail("unchanged geometry started a measurement"),
			setError: (error: unknown) => {
				throw error;
			},
		});
		run();
	}
	assert.equal(presentations, 3);
	assert.equal(recovery.canSample(size), true);
});
test("actual font/image-ready callback performs one protected reflow only after every current part is ready", () => {
	const isAssetsReady = (node: ts.Node) =>
		ts.isArrowFunction(node) &&
		ts.isCallExpression(node.parent) &&
		ts.isPropertyAccessExpression(node.parent.expression) &&
		node.parent.expression.name.text === "then" &&
		node.getText(source).includes("ready.current.add(index)");
	const ready = { current: new Set<number>() };
	let passes = 0;
	for (const index of [0, 1]) {
		callback(isAssetsReady, {
			valid: () => true,
			ready,
			index,
			data: { parts: [{}, {}] },
			reflowFrames: () => passes++,
		})();
		assert.equal(passes, index === 0 ? 0 : 1);
	}
	callback(isAssetsReady, {
		valid: () => false,
		ready,
		index: 1,
		data: { parts: [{}, {}] },
		reflowFrames: () => assert.fail("stale assets reflowed current surface"),
	})();
	assert.equal(passes, 1);
});
