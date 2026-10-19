import assert from "node:assert/strict";
import test from "node:test";
import { bookMenuPageForKey, nextBookMenuIndex } from "./book-menu.ts";

test("阅读状态仅从对应入口进入二级菜单，左箭头或 Escape 回到主菜单", () => {
	assert.equal(bookMenuPageForKey("main", "ArrowRight", true), "status");
	assert.equal(bookMenuPageForKey("main", "ArrowRight", false), "main");
	assert.equal(bookMenuPageForKey("main", "Escape", true), "main");
	assert.equal(bookMenuPageForKey("status", "ArrowLeft", false), "main");
	assert.equal(bookMenuPageForKey("status", "Escape", false), "main");
	assert.equal(bookMenuPageForKey("status", "ArrowDown", false), "status");
});

test("菜单上下键循环并跳过禁用项，Home 与 End 选择可用边界", () => {
	const disabled = [false, false, true, false, true];
	assert.equal(nextBookMenuIndex(disabled, 1, "ArrowDown"), 3);
	assert.equal(nextBookMenuIndex(disabled, 3, "ArrowDown"), 0);
	assert.equal(nextBookMenuIndex(disabled, 0, "ArrowUp"), 3);
	assert.equal(nextBookMenuIndex(disabled, 3, "ArrowUp"), 1);
	assert.equal(nextBookMenuIndex(disabled, 3, "Home"), 0);
	assert.equal(nextBookMenuIndex(disabled, 0, "End"), 3);
});

test("未聚焦时从方向起点导航，全部禁用和非导航键不改变焦点", () => {
	assert.equal(nextBookMenuIndex([true, false, false], -1, "ArrowDown"), 1);
	assert.equal(nextBookMenuIndex([true, false, false], -1, "ArrowUp"), 2);
	assert.equal(nextBookMenuIndex([true, true], -1, "ArrowDown"), null);
	assert.equal(nextBookMenuIndex([], -1, "Home"), null);
	assert.equal(nextBookMenuIndex([false, false], 0, "Enter"), null);
});
