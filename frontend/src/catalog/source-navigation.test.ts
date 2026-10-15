import assert from "node:assert/strict";
import test from "node:test";
import {
	catalogScrollSearch,
	readSourceContentLocation,
	sourceContentTransition,
	sourceEntrySearch,
	sourceOverviewDestination,
	updateCatalogSearch,
} from "./state.ts";

const sourceSearch = "sq=架构&ssort=updated_at&sorder=desc&spage=2";
const preferences = (scope: string) =>
	scope === "sort-source-books-source-a"
		? "sort=created_at&order=desc"
		: "sort=updated_at&order=asc";

test("source navigation composes view, book window, filtering and return without losing the source directory", () => {
	const start = `${sourceSearch}&view=analyses&q=讲解&page=3&extra=keep`;
	const view = sourceContentTransition(start, {
		type: "view",
		view: "materials",
	});
	assert.equal(view.replace, false);
	const material = readSourceContentLocation(
		view.search,
		"source-a",
		preferences,
	);
	assert.equal(material.view, "materials");
	assert.equal(material.expanded, false);
	const opened = sourceContentTransition(material.search, {
		type: "open-books",
	});
	assert.equal(opened.replace, false);
	const filtered = updateCatalogSearch(opened.search, {
		q: "本",
		status: "completed",
		page: 4,
	});
	// Returning from a book restores the same URL and scroll identity.
	const restored = readSourceContentLocation(filtered, "source-a", preferences);
	assert.equal(restored.expanded, true);
	assert.equal(
		catalogScrollSearch(restored.search),
		catalogScrollSearch(filtered),
	);
	const closed = sourceContentTransition(restored.search, {
		type: "close-books",
	});
	assert.equal(closed.replace, true);
	const params = new URLSearchParams(closed.search);
	for (const key of ["expanded", "q", "status", "sort", "order", "page"])
		assert.equal(params.has(key), false, key);
	assert.equal(params.get("sq"), "架构");
	assert.equal(params.get("ssort"), "updated_at");
	assert.equal(params.get("sorder"), "desc");
	assert.equal(params.get("spage"), "2");
	assert.equal(params.get("extra"), "keep");
	const settled = readSourceContentLocation(
		closed.search,
		"source-a",
		preferences,
	);
	assert.equal(new URLSearchParams(settled.search).get("sort"), "created_at");
	assert.equal(new URLSearchParams(settled.search).get("order"), "desc");
});

test("source content normalization preserves explicit URLs and is idempotent", () => {
	const explicit = `${sourceSearch}&view=segments&q=雨&page=2&sort=created_at&order=desc`;
	const first = readSourceContentLocation(explicit, "source-a", preferences);
	assert.equal(first.view, "segments");
	assert.equal(new URLSearchParams(first.search).get("sort"), "created_at");
	assert.equal(new URLSearchParams(first.search).get("order"), "desc");
	assert.deepEqual(
		readSourceContentLocation(first.search, "source-a", preferences),
		first,
	);
	const invalid = readSourceContentLocation(
		"view=segments&sort=title&order=bad",
		"source-a",
		preferences,
	);
	assert.equal(new URLSearchParams(invalid.search).get("sort"), "created_at");
	assert.equal(new URLSearchParams(invalid.search).get("order"), "asc");
});

test("legacy entry and book windows keep their meaning while switching Source clears content state", () => {
	const entry = sourceEntrySearch("q=旧&sq=&page=2&spage=3");
	const destination = sourceOverviewDestination(
		"source-b",
		`${entry}&view=analyses&q=正文&expanded=book`,
	);
	const location = readSourceContentLocation(
		destination.split("?")[1] ?? "",
		"source-b",
		() => {
			assert.fail("overview must not consult a content sort preference");
		},
	);
	assert.equal(location.view, "overview");
	assert.equal(location.expanded, false);
	assert.equal(new URLSearchParams(location.search).get("spage"), "3");
	assert.equal(new URLSearchParams(location.search).has("q"), false);
	const legacy = readSourceContentLocation(
		"expanded=book&q=本",
		"source-a",
		preferences,
	);
	assert.equal(legacy.view, "materials");
	assert.equal(legacy.expanded, true);
	assert.equal(new URLSearchParams(legacy.search).get("q"), "本");
	const explicit = readSourceContentLocation(
		"view=analyses&expanded=book",
		"source-a",
		preferences,
	);
	assert.equal(explicit.view, "analyses");
	assert.equal(explicit.expanded, false);
});

test("opening books preserves content query and history return restores explicit sort despite changed preferences", () => {
	const original = `${sourceSearch}&view=materials&q=履歴&status=active&page=4&sort=created_at&order=asc&extra=keep`;
	const opened = sourceContentTransition(original, { type: "open-books" });
	assert.equal(opened.replace, false);
	const openParams = new URLSearchParams(opened.search);
	for (const key of ["q", "status", "page", "sort", "order", "extra"])
		assert.equal(openParams.get(key), new URLSearchParams(original).get(key));
	const switched = sourceContentTransition(opened.search, {
		type: "view",
		view: "segments",
	});
	assert.equal(switched.replace, false);
	assert.equal(new URLSearchParams(switched.search).has("expanded"), false);
	const back = readSourceContentLocation(
		opened.search,
		"source-a",
		() => "sort=title&order=desc",
	);
	assert.equal(back.expanded, true);
	assert.equal(back.search, opened.search);
	assert.deepEqual(
		readSourceContentLocation(back.search, "source-a", preferences),
		back,
	);
});
