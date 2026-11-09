import assert from "node:assert/strict";
import test from "node:test";
import {
	returnDestination,
	settingsPageReturn,
	settingsReadingReturn,
	settingsReturnState,
} from "../navigation.ts";
import { readerSessionRoute } from "./reader-session-route.ts";

test("settings round trips preserve the exact reader URL and its catalog parent", () => {
	const parent = { to: "/sources/source?view=materials&page=2", label: "来源" };
	const state = settingsReturnState({
		pathname: "/materials/book",
		search: "?entry=one",
		hash: "#chapter",
		state: { returnTo: parent },
	});
	const next = settingsReturnState({
		pathname: "/settings",
		search: "?section=providers",
		hash: "",
		state,
	});
	assert.deepEqual(next, state);
	const reader = settingsReadingReturn(next);
	assert.deepEqual(reader, {
		to: "/materials/book?entry=one#chapter",
		label: "阅读",
		state: { returnTo: parent },
	});
	assert.deepEqual(returnDestination(reader?.state), parent);
	assert.deepEqual(readerSessionRoute("/settings", next), {
		kind: "settings",
		materialId: "book",
	});
});

test("only validated reader return destinations can retain a session in settings", () => {
	for (const to of [
		"https://evil.test/materials/book",
		"//evil.test/materials/book",
		"/materials/book/details",
		"/materials/book/vocabulary",
		"/materials/book/../../settings",
		"/segments/segment",
		"/settings?section=translation",
	]) {
		const state = { returnTo: { to, label: "来处" } };
		assert.equal(settingsReadingReturn(state), null, to);
		assert.equal(readerSessionRoute("/settings", state), null, to);
	}
	assert.equal(readerSessionRoute("/settings"), null);
	assert.equal(
		settingsReturnState({
			pathname: "/settings",
			search: "",
			hash: "",
			state: undefined,
		}),
		undefined,
	);
});

test("settings canonicalize the reader's accepted case and trailing slash without losing its query", () => {
	const state = settingsReturnState({
		pathname: "/MATERIALS/book/",
		search: "?entry=one",
		hash: "",
		state: undefined,
	});
	assert.equal(settingsReadingReturn(state)?.to, "/materials/book?entry=one");
	assert.deepEqual(readerSessionRoute("/settings", state), {
		kind: "settings",
		materialId: "book",
	});
});

test("settings preserve a segment URL, its reader and catalog across categories", () => {
	const catalog = { to: "/materials?type=book&page=2", label: "素材库" };
	const reader = {
		to: "/materials/book?segment=saved#sentence",
		label: "本书",
		parent: catalog,
	};
	const state = settingsReturnState({
		pathname: "/segments/saved",
		search: "?analysis=a&revision=r&thread=t&chat=open",
		hash: "#section",
		state: { returnTo: reader },
	});
	const next = settingsReturnState({
		pathname: "/settings",
		search: "?section=models",
		hash: "",
		state,
	});
	assert.deepEqual(next, state);
	assert.deepEqual(settingsPageReturn(next), {
		to: "/segments/saved?analysis=a&revision=r&thread=t&chat=open#section",
		label: "片段",
		state: { returnTo: reader },
	});
	assert.deepEqual(settingsReadingReturn(next), {
		to: reader.to,
		label: reader.label,
		state: { returnTo: catalog },
	});
	assert.deepEqual(readerSessionRoute("/settings", next), {
		kind: "settings",
		materialId: "book",
	});
});

test("a standalone segment returns without inventing an associated reader", () => {
	const state = settingsReturnState({
		pathname: "/SEGMENTS/saved/",
		search: "?thread=t",
		hash: "#part",
		state: undefined,
	});
	assert.deepEqual(settingsPageReturn(state), {
		to: "/segments/saved?thread=t#part",
		label: "片段",
		state: { returnTo: { to: "/sources", label: "来源目录" } },
	});
	assert.equal(settingsReadingReturn(state), null);
	assert.equal(readerSessionRoute("/settings", state), null);
	const next = settingsReturnState({
		pathname: "/settings",
		search: "?section=learning",
		hash: "",
		state,
	});
	assert.deepEqual(next, state);
	assert.deepEqual(
		returnDestination(settingsPageReturn(next)?.state),
		returnDestination(undefined),
	);
});

test("unrelated pages and invalid destinations release settings return context", () => {
	for (const to of [
		"https://evil.test/segments/s",
		"//evil.test/segments/s",
		"/segments/s/extra",
		"/segments/s/../other",
		"/segments/%2e%2e",
		"/settings",
		"/materials/book/details",
		"/sources/source",
	]) {
		const state = {
			returnTo: {
				to,
				label: "来处",
				parent: { to: "/materials/book", label: "阅读" },
			},
		};
		assert.equal(settingsPageReturn(state), null, to);
		assert.equal(settingsReadingReturn(state), null, to);
	}
	assert.equal(
		settingsReturnState({
			pathname: "/sources",
			search: "",
			hash: "",
			state: { returnTo: { to: "/materials/book", label: "阅读" } },
		}),
		undefined,
	);
});

test("settings sanitize cyclic segment parent trails before resolving the reader", () => {
	const segment: { to: string; label: string; parent?: unknown } = {
		to: "/segments/saved",
		label: "片段",
	};
	segment.parent = segment;
	assert.deepEqual(settingsPageReturn({ returnTo: segment }), {
		to: segment.to,
		label: segment.label,
	});
	assert.equal(settingsReadingReturn({ returnTo: segment }), null);
});

test("invalid parents release the reader and repeated learning pages are removed", () => {
	assert.equal(
		settingsReadingReturn({
			returnTo: {
				to: "/segments/saved",
				label: "片段",
				parent: { to: "//evil.test/materials/book", label: "阅读" },
			},
		}),
		null,
	);
	const state = {
		returnTo: {
			to: "/segments/saved",
			label: "片段",
			parent: {
				to: "/segments/saved?thread=other",
				label: "重复片段",
				parent: { to: "/materials/book", label: "阅读" },
			},
		},
	};
	assert.equal(
		settingsPageReturn(state)?.state?.returnTo.to,
		"/materials/book",
	);
	assert.equal(settingsReadingReturn(state)?.to, "/materials/book");
});

test("settings return chains retain the existing four-destination limit", () => {
	let parent: import("../navigation.ts").ReturnTarget = {
		to: "/materials/book",
		label: "阅读",
	};
	for (let index = 0; index < 5; index++)
		parent = { to: `/segments/s${index}`, label: "片段", parent };
	const state = { returnTo: parent };
	let destination = settingsPageReturn(state);
	let count = 0;
	while (destination) {
		count++;
		destination = destination.state
			? settingsPageReturn(destination.state)
			: null;
	}
	assert.equal(count, 4);
	assert.equal(settingsReadingReturn(state), null);
});
