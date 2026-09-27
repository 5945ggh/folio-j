import assert from "node:assert/strict";
import { test } from "node:test";
import { imageHref, safeHref } from "./links.ts";

test("Markdown链接仅保留可安全导航的协议", () => {
	assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
	assert.equal(
		safeHref("mailto:hello@example.com"),
		"mailto:hello@example.com",
	);
	assert.equal(safeHref("#section"), "#section");
	assert.equal(safeHref("javascript:alert(1)"), undefined);
	assert.equal(safeHref("//evil.example/a"), undefined);
});

test("Markdown图片只提供外部链接，不能自动加载数据URL", () => {
	assert.equal(
		imageHref("https://example.com/image.png"),
		"https://example.com/image.png",
	);
	assert.equal(imageHref("data:image/png;base64,AAAA"), undefined);
	assert.equal(imageHref("/relative.png"), undefined);
});
