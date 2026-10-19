import assert from "node:assert/strict";
import test from "node:test";
import { handleDialogCancel } from "../dialog-events.ts";

test("取消文件选择或重选同一文件不会关闭包含它的弹窗", () => {
	const input = new EventTarget();
	const dialog = new EventTarget();
	let closed = false;
	let prevented = false;
	handleDialogCancel(
		{
			target: input,
			currentTarget: dialog,
			preventDefault: () => {
				prevented = true;
			},
		},
		() => {
			closed = true;
		},
	);
	assert.equal(closed, false);
	assert.equal(prevented, false);
});

test("弹窗自己的取消请求先阻止浏览器默认关闭，再交给关闭回调", () => {
	const dialog = new EventTarget();
	const steps: string[] = [];
	handleDialogCancel(
		{
			target: dialog,
			currentTarget: dialog,
			preventDefault: () => steps.push("prevent"),
		},
		() => steps.push("close"),
	);
	assert.deepEqual(steps, ["prevent", "close"]);
});

test("提交中的关闭回调拒绝离开时，浏览器也不能自行关闭弹窗", () => {
	const dialog = new EventTarget();
	let open = true;
	let prevented = false;
	const pending = true;
	handleDialogCancel(
		{
			target: dialog,
			currentTarget: dialog,
			preventDefault: () => {
				prevented = true;
			},
		},
		() => {
			if (!pending) open = false;
		},
	);
	assert.equal(open, true);
	assert.equal(prevented, true);
});
