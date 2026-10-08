import assert from "node:assert/strict";
import { test } from "node:test";
import {
	readSegmentLocation,
	returnDestination,
	updateSegmentLocation,
} from "../navigation.ts";

test("普通片段入口安静阅读，讲解修订与讨论目标可独立恢复", () => {
	assert.deepEqual(readSegmentLocation(""), {
		analysisId: null,
		revisionId: null,
		threadId: null,
		chatOpen: false,
	});
	assert.deepEqual(readSegmentLocation("?analysis=a&revision=r&thread=t"), {
		analysisId: "a",
		revisionId: "r",
		threadId: "t",
		chatOpen: true,
	});
	assert.equal(readSegmentLocation("?thread=t&chat=0").chatOpen, false);
	assert.equal(readSegmentLocation("?chat=1").chatOpen, true);
	assert.equal(readSegmentLocation("?revision=r").revisionId, null);
});

test("切换讲解清除旧修订，收起讨论保留目标且不影响阅读", () => {
	const initial = "?analysis=a&revision=r&thread=t&chat=1";
	assert.deepEqual(
		readSegmentLocation(updateSegmentLocation(initial, { analysisId: "b" })),
		{ analysisId: "b", revisionId: null, threadId: "t", chatOpen: true },
	);
	const closed = updateSegmentLocation(initial, { chatOpen: false });
	assert.deepEqual(readSegmentLocation(closed), {
		analysisId: "a",
		revisionId: "r",
		threadId: "t",
		chatOpen: false,
	});
	assert.equal(
		readSegmentLocation(updateSegmentLocation(initial, { analysisId: null }))
			.revisionId,
		null,
	);
	assert.equal(
		readSegmentLocation(
			updateSegmentLocation(initial, { analysisId: "b", revisionId: "r2" }),
		).revisionId,
		"r2",
	);
	assert.equal(
		readSegmentLocation(updateSegmentLocation(initial, { threadId: null }))
			.threadId,
		null,
	);
});

test("返回来处保留应用内精确路径，直达及不可信来处退回来源目录", () => {
	const fallback = { to: "/sources", label: "来源目录" };
	assert.deepEqual(returnDestination(undefined), fallback);
	assert.deepEqual(
		returnDestination({
			returnTo: { to: "/sources/s?x=1#entry", label: "雨の日" },
		}),
		{ to: "/sources/s?x=1#entry", label: "雨の日" },
	);
	assert.deepEqual(
		returnDestination({
			returnTo: { to: "/sources/s?expanded=book&q=雨&page=2", label: "Source" },
		}),
		{ to: "/sources/s?expanded=book&q=%E9%9B%A8&page=2", label: "Source" },
	);
	assert.deepEqual(
		returnDestination({
			returnTo: { to: "/settings?section=learning", label: "学习偏好" },
		}),
		{ to: "/settings?section=learning", label: "学习偏好" },
	);
	for (const to of [
		"https://evil.test",
		"http://",
		"//evil.test",
		"/\\evil.test",
		"/sources/../api/settings",
		"/api/settings",
		"/sources\n",
		"javascript:alert(1)",
		"",
	]) {
		assert.deepEqual(
			returnDestination({ returnTo: { to, label: "来处" } }),
			fallback,
			to,
		);
	}
});
