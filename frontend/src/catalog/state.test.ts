import assert from "node:assert/strict";
import { test } from "node:test";
import {
	readSegmentLocation,
	returnDestination,
	updateSegmentLocation,
} from "../navigation.ts";
import {
	analysisDestination,
	lastCatalogPage,
	readCatalogState,
	sourceListSearch,
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
	assert.equal(sourceView("?view=bad", "analyses"), "materials");
	assert.equal(sourceView("", "analyses"), "analyses");
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
test("讲解直达确切修订且原片段讨论参数行为不变", () => {
	assert.equal(
		analysisDestination({ segment_id: "s", id: "a", current_revision_id: "r" }),
		"/segments/s?analysis=a&revision=r",
	);
	assert.equal(
		readSegmentLocation(
			updateSegmentLocation("?analysis=a&revision=r&thread=t", {
				chatOpen: false,
			}),
		).revisionId,
		"r",
	);
});
test("既有来源来处和外部跳转校验保持", () => {
	assert.deepEqual(
		returnDestination({
			returnTo: { to: "/sources/s?expanded=book&q=雨&page=2", label: "Source" },
		}),
		{ to: "/sources/s?expanded=book&q=%E9%9B%A8&page=2", label: "Source" },
	);
	assert.equal(
		returnDestination({ returnTo: { to: "//evil.test", label: "外部" } }).to,
		"/sources",
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
