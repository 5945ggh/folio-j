import assert from "node:assert/strict";
import test from "node:test";
import { settingsReturnState } from "../navigation.ts";
import { segmentSessionRoute } from "./segment-session-route.ts";

test("retains only a Segment's own explicit settings round trip", () => {
	const state = settingsReturnState({
		pathname: "/segments/saved",
		search: "?analysis=a&revision=r&thread=t&chat=1",
		hash: "#explanation",
		state: { returnTo: { to: "/materials/book", label: "原书" } },
	});
	assert.deepEqual(segmentSessionRoute("/segments/saved"), {
		kind: "segment",
		segmentId: "saved",
	});
	assert.deepEqual(segmentSessionRoute("/SETTINGS/", state), {
		kind: "settings",
		segmentId: "saved",
	});
	for (const path of [
		"/",
		"/materials",
		"/sources",
		"/materials/book",
		"/segments",
		"/segments/saved/more",
	])
		assert.equal(segmentSessionRoute(path, state), null, path);
	for (const to of [
		"/materials/book",
		"//external.test/segments/saved",
		"/segments/saved/../other",
		"/segments/saved/more",
	])
		assert.equal(
			segmentSessionRoute("/settings", { returnTo: { to, label: "返回" } }),
			null,
			to,
		);
	assert.equal(segmentSessionRoute("/settings"), null);
});

test("Segment route matching keeps Router's parameter and trailing-slash behavior", () => {
	assert.deepEqual(segmentSessionRoute("/SEGMENTS/saved%20one/"), {
		kind: "segment",
		segmentId: "saved one",
	});
});
