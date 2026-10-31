import assert from "node:assert/strict";
import test from "node:test";
import { createSearchDraft } from "./search-draft.ts";

test("普通输入同步保留原始值并逐次提交，清空也返回可提交值", () => {
	const draft = createSearchDraft("");
	assert.equal(draft.change("a"), "a");
	assert.equal(draft.value, "a");
	assert.equal(draft.change("ab"), "ab");
	assert.equal(draft.value, "ab");
	assert.equal(draft.change("ab"), undefined);
	assert.equal(draft.change("  中文  "), "  中文  ");
	assert.equal(draft.value, "  中文  ");
	assert.equal(draft.change(""), "");
	assert.equal(draft.value, "");
	assert.equal(draft.change(""), undefined);
});

test("拼音过程只更新草稿，结束时提交最终字词并忽略重复结束和 change", () => {
	const draft = createSearchDraft("");
	draft.startComposition();
	assert.equal(draft.composing, true);
	for (const value of ["z", "zhong", "zhong wen"]) {
		assert.equal(draft.change(value), undefined);
		assert.equal(draft.value, value);
	}
	assert.equal(draft.endComposition("中文"), "中文");
	assert.equal(draft.composing, false);
	assert.equal(draft.change("中文"), undefined);
	assert.equal(draft.endComposition("过期结束值"), undefined);
	assert.equal(draft.value, "中文");
	assert.equal(draft.change("中文书"), "中文书");
});

test("原生组合标记也能启动保护，后续无标记的 change 不提前提交", () => {
	const draft = createSearchDraft("书");
	assert.equal(draft.change("书 ming", true), undefined);
	assert.equal(draft.composing, true);
	assert.equal(draft.change("书名", false), undefined);
	assert.equal(draft.endComposition("书名"), "书名");
	assert.equal(draft.value, "书名");
});

test("取消候选恢复已提交值时不重复搜索，后续输入仍能提交", () => {
	const draft = createSearchDraft("原值");
	draft.startComposition();
	assert.equal(draft.change("原值 pinyin"), undefined);
	assert.equal(draft.endComposition("原值"), undefined);
	assert.equal(draft.value, "原值");
	assert.equal(draft.composing, false);
	assert.equal(draft.change("新值"), "新值");
});

test("外部清空取消组合，迟到的 compositionend 不复活旧草稿", () => {
	const draft = createSearchDraft("旧查询");
	draft.startComposition();
	draft.change("旧查询 pinyin");
	draft.receive("");
	assert.equal(draft.value, "");
	assert.equal(draft.composing, false);
	assert.equal(draft.endComposition("旧查询拼音"), undefined);
	assert.equal(draft.value, "");
	assert.equal(draft.change(""), undefined);
	assert.equal(draft.change("新查询"), "新查询");
});

test("历史导航重置显示和提交基准，相同值的外部重置也会取消组合", () => {
	const draft = createSearchDraft("历史查询");
	assert.equal(draft.change("当前查询"), "当前查询");
	draft.receive("历史查询");
	assert.equal(draft.value, "历史查询");
	assert.equal(draft.change("历史查询"), undefined);
	assert.equal(draft.change("当前查询"), "当前查询");
	draft.startComposition();
	draft.change("当前查询 pinyin");
	draft.receive("当前查询");
	assert.equal(draft.composing, false);
	assert.equal(draft.value, "当前查询");
	assert.equal(draft.endComposition("当前查询拼音"), undefined);
	assert.equal(draft.value, "当前查询");
});

test("按键保护同时识别本地组合、原生组合和 229，结束或重置后解除", () => {
	const draft = createSearchDraft("");
	assert.equal(draft.isComposingKey({}), false);
	assert.equal(draft.isComposingKey({ isComposing: true }), true);
	assert.equal(draft.isComposingKey({ keyCode: 229 }), true);
	assert.equal(draft.isComposingKey({ keyCode: 27 }), false);
	draft.startComposition();
	assert.equal(draft.isComposingKey({ isComposing: false, keyCode: 27 }), true);
	draft.endComposition("");
	assert.equal(draft.isComposingKey({ keyCode: 27 }), false);
	draft.startComposition();
	draft.receive("");
	assert.equal(draft.isComposingKey({}), false);
});
