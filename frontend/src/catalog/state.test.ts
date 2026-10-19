import assert from "node:assert/strict";
import { test } from "node:test";
import { returnDestination } from "../navigation.ts";
import {
	analysisDestination,
	catalogScrollSearch,
	lastCatalogPage,
	readCatalogState,
	sourceEntrySearch,
	sourceListSearch,
	sourceOverviewDestination,
	sourceView,
	updateCatalogSearch,
} from "./state.ts";

test("目录参数验证、偏好默认及分区独立", () => {
	assert.deepEqual(
		readCatalogState("?q=雨&sort=no&order=bad&page=-2&status=unknown", "books"),
		{
			q: "雨",
			source_id: "",
			status: "",
			sort: "title",
			order: "asc",
			page: 1,
		},
	);
	assert.equal(readCatalogState("", "segments").order, "desc");
	assert.equal(
		readCatalogState("?sort=title", "books", "sort=last_opened_at&order=desc")
			.sort,
		"title",
	);
	assert.equal(
		readCatalogState("?q=内容&sq=来源&spage=3", "sources", "", "s").q,
		"来源",
	);
	assert.equal(readCatalogState("?page=2.5", "books").page, 1);
	assert.equal(sourceView("?view=bad", "analyses"), "overview");
	assert.equal(sourceView("", "analyses"), "overview");
});
test("筛选重置当前分页并保留来源背景及另一区域条件", () => {
	const search = updateCatalogSearch(
		"?view=materials&expanded=book&page=4&sq=source&spage=2",
		{ q: "new" },
	);
	const params = new URLSearchParams(search);
	assert.equal(params.get("expanded"), "book");
	assert.equal(params.get("page"), null);
	assert.equal(params.get("spage"), "2");
	assert.equal(lastCatalogPage(101), 3);
	assert.equal(lastCatalogPage(0), 1);
});
test("讲解直达确切修订", () => {
	assert.equal(
		analysisDestination({ segment_id: "s", id: "a", current_revision_id: "r" }),
		"/segments/s?analysis=a&revision=r",
	);
});
test("材料来处支持精确筛选和独立默认入口，拒绝任意API与伪协议", () => {
	const fallback = { to: "/materials", label: "素材库" };
	assert.deepEqual(returnDestination(undefined, fallback), fallback);
	assert.deepEqual(
		returnDestination(
			{
				returnTo: {
					to: "/materials?type=book&q=a&source=s&status=completed&sort=last_opened_at&order=desc&page=2",
					label: "素材库",
				},
			},
			fallback,
		),
		{
			to: "/materials?type=book&q=a&source=s&status=completed&sort=last_opened_at&order=desc&page=2",
			label: "素材库",
		},
	);
	for (const to of [
		"/api/materials",
		"//evil.test",
		"/materials/../api/settings",
		"/materials/a\\x",
	])
		assert.deepEqual(
			returnDestination({ returnTo: { to, label: "恶意" } }, fallback),
			fallback,
		);
});

test("Source 列表搜索与详情视图过滤在对象切换时隔离", () => {
	assert.equal(
		sourceListSearch("?q=雨&sort=title&page=3&view=analyses", "", "s"),
		"?sq=%E9%9B%A8&ssort=title&spage=3",
	);
	assert.equal(
		sourceListSearch("?sq=雨&spage=3&q=正文&page=2", "s", ""),
		"?q=%E9%9B%A8&page=3",
	);
});

test("S2 默认概览不覆盖明确视图和旧书籍窗口", () => {
	assert.equal(sourceView("?expanded=book&q=x"), "materials");
	for (const view of ["overview", "materials", "segments", "analyses"])
		assert.equal(sourceView(`?view=${view}&q=x`, "materials"), view);
	assert.equal(
		sourceOverviewDestination("s", "?view=analyses&q=正文&sq=来源&spage=2"),
		"/sources/s?sq=%E6%9D%A5%E6%BA%90&spage=2&view=overview",
	);
	const to =
		"/sources/s?view=overview&sq=x&ssort=updated_at&sorder=desc&spage=2";
	assert.equal(returnDestination({ returnTo: { to, label: "来源" } }).to, to);
});

test("右侧滚动位置不随左侧来源查询改变", () => {
	assert.equal(
		catalogScrollSearch("?view=analyses&q=文&page=2&sq=甲&ssort=title&spage=3"),
		catalogScrollSearch(
			"?view=analyses&q=文&page=2&sq=乙&ssort=updated_at&spage=1",
		),
	);
	assert.notEqual(
		catalogScrollSearch("?view=materials&expanded=book&page=2"),
		catalogScrollSearch("?view=materials"),
	);
});

test("旧来源总表链接迁移为来源栏条件，不混入右侧内容", () => {
	assert.equal(
		sourceEntrySearch("?q=旧条件&sort=updated_at&order=desc&page=2"),
		"sq=%E6%97%A7%E6%9D%A1%E4%BB%B6&ssort=updated_at&sorder=desc&spage=2",
	);
	assert.equal(
		sourceEntrySearch("?q=旧&sq=明确&spage=3&page=2"),
		"sq=%E6%98%8E%E7%A1%AE&spage=3",
	);
});

test("显式清空来源栏条件优先于旧总表条件", () => {
	assert.equal(
		sourceEntrySearch(
			"?q=旧&sort=updated_at&order=desc&page=2&sq=&ssort=&sorder=&spage=",
		),
		"",
	);
});

test("详情往返阅读保留原目录条件且只携带一个经过校验的父来处", () => {
	for (const to of [
		"/materials?type=book&q=%E9%9B%A8&sort=title&page=2",
		"/sources/s?view=overview&sq=x",
		"/sources/s?view=materials&expanded=book&q=x&page=2",
	]) {
		const back = returnDestination({
			returnTo: {
				to: "/materials/book-1/details",
				label: "书籍详情",
				parent: { to, label: "目录", arbitrary: "discard" },
			},
		});
		assert.deepEqual(back, {
			to: "/materials/book-1/details",
			label: "书籍详情",
			state: { returnTo: { to, label: "目录" } },
		});
		assert.deepEqual(returnDestination(back.state), { to, label: "目录" });
	}
});

test("详情来处拒绝未知子路由、外站父来处与递归状态", () => {
	const fallback = { to: "/materials", label: "素材库" };
	for (const to of [
		"/materials/x/details/unknown",
		"/materials/x/metadata",
		"/materials/x/details/../../api",
		"/materials/%2e%2e/details",
	])
		assert.deepEqual(
			returnDestination({ returnTo: { to, label: "详情" } }, fallback),
			fallback,
		);
	for (const to of ["//evil.test", "https://evil.test", "/api/settings"])
		assert.deepEqual(
			returnDestination({
				returnTo: {
					to: "/materials/b/details",
					label: "详情",
					parent: { to, label: "来处" },
				},
			}).state,
			{ returnTo: fallback },
		);
	const recursive: { to: string; label: string; parent?: unknown } = {
		to: "/materials/b/details",
		label: "详情",
	};
	recursive.parent = recursive;
	assert.deepEqual(returnDestination({ returnTo: recursive }), {
		to: recursive.to,
		label: recursive.label,
	});
});
