import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bookMetadataUpdate,
	bookTitleError,
	coverFileError,
	MAX_COVER_BYTES,
	metadataDraftChanged,
	normalizedBookTitle,
} from "./book-metadata.ts";

test("书名提交采用 NFC 与去空白，并按 Unicode 码点限制长度", () => {
	assert.equal(normalizedBookTitle("  は\u3099な  "), "ばな");
	assert.equal(bookTitleError("　 "), "书名须为 1–300 个字符。");
	assert.equal(bookTitleError("𠮷".repeat(300)), null);
	assert.ok(bookTitleError("𠮷".repeat(301)));
});
test("取消识别原始输入和封面意图，恢复原书封面也属于草稿", () => {
	assert.equal(metadataDraftChanged("本", "本", "keep"), false);
	assert.equal(metadataDraftChanged("本", " 本 ", "keep"), true);
	assert.equal(metadataDraftChanged("本", "本", "replace"), true);
	assert.equal(metadataDraftChanged("本", "本", "reset"), true);
});
test("自定义封面在读取前检查类型、空文件与大小边界", () => {
	assert.equal(coverFileError("image/png", MAX_COVER_BYTES), null);
	assert.equal(coverFileError("image/jpeg", 100), null);
	assert.ok(coverFileError("image/png", MAX_COVER_BYTES + 1));
	assert.ok(coverFileError("image/gif", 100));
	assert.ok(coverFileError("image/jpeg", 0));
});

test("同次保存包含规范化书名、原修订与封面意图，保持或恢复不发送旧图片", () => {
	const cover = { media_type: "image/png" as const, data_base64: "image-data" };
	assert.deepEqual(bookMetadataUpdate(" は\u3099な ", 7, "replace", cover), {
		title: "ばな",
		expected_revision: 7,
		cover_action: "replace",
		cover,
	});
	for (const action of ["keep", "reset"] as const)
		assert.deepEqual(bookMetadataUpdate(" 本 ", 7, action, cover), {
			title: "本",
			expected_revision: 7,
			cover_action: action,
		});
	assert.throws(() => bookMetadataUpdate("本", 7, "replace"));
	assert.throws(() => bookMetadataUpdate(" ", 7, "keep"));
});
