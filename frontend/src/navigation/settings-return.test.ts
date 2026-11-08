import assert from "node:assert/strict";
import test from "node:test";
import {
	returnDestination,
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
