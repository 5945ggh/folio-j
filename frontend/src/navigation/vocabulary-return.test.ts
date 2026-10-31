import assert from "node:assert/strict";
import test from "node:test";
import { returnDestination, returnState } from "../navigation.ts";

test("reader returns to full vocabulary query then details and filtered catalog", () => {
	const catalog = { to: "/materials?q=book&page=3", label: "素材库" };
	const details = returnDestination(
		returnState({ to: "/materials/b/details", label: "详情" }, catalog),
	);
	const vocabulary = {
		to: "/materials/b/vocabulary?reading=1&page=2&word=%E8%AA%9E#selected",
		label: "词汇",
	};
	const state = returnState(vocabulary, details, "/materials/b");
	const back = returnDestination(state);
	assert.equal(back.to, vocabulary.to);
	const backDetails = returnDestination(back.state);
	assert.equal(backDetails.to, "/materials/b/details");
	assert.deepEqual(returnDestination(backDetails.state), catalog);
});
test("vocabulary whitelist rejects traversal and unsupported child paths", () => {
	const fallback = { to: "/materials", label: "素材库" };
	for (const to of [
		"//evil/vocabulary",
		"/materials/b/vocabulary/extra",
		"/materials/b/%2e%2e/vocabulary",
		"/materials/b/vocabulary\\evil",
	])
		assert.deepEqual(
			returnDestination({ returnTo: { to, label: "词汇" } }, fallback),
			fallback,
		);
});
