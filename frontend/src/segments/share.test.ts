import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Segment } from "../content.ts";
import type { SegmentProvenance } from "../materials/study-api.ts";
import { segmentShareText } from "./share.ts";

const segment: Segment = {
	id: "segment",
	source_id: "source",
	text: "　机の前に座っているだけになった。\n次の行。　",
	context_before: "前の文。\n\n　空白も残す。",
	context_after: "後の文。",
	source_ref: "第3巻 p.42",
	translation: "不应分享的译文",
	transcription: "不应分享的听写",
	note: "不应分享的个人备注",
	revision: 1,
	text_sha256: "a".repeat(64),
	text_locked_at: null,
	created_at: "2026-10-24T00:00:00Z",
	updated_at: "2026-10-24T00:00:00Z",
};
const provenance: SegmentProvenance = {
	segment_id: segment.id,
	status: "resolved",
	material_provenance: null,
	assembly_rule: "concat-nfc-v1",
	title: "本の名前",
	chapter_title: "第一章",
	display: "本の名前 · 第一章 · 章内约 12%",
};
const verified = (data: SegmentProvenance) => ({
	data,
	isSuccess: true,
	isFetching: false,
});

test("分享先呈现语境与引用目标，末尾附自然出处，不带内部位置", () => {
	const result = segmentShareText(segment, "作品", verified(provenance));
	assert.equal(
		result.full,
		`${segment.context_before}\n\n> 　机の前に座っているだけになった。\n> 次の行。　\n\n${segment.context_after}\n\n——《本の名前》\n第一章\n第3巻 p.42`,
	);
	assert.equal(result.original, segment.text);
	assert.equal(result.source, "《本の名前》\n第一章\n第3巻 p.42");
	assert.doesNotMatch(result.full, /不应分享/);
});

test("空出处和空白语境不生成空标题，纯原文复制不加标记", () => {
	const result = segmentShareText({
		...segment,
		source_ref: " \n",
		context_before: "　\n",
		context_after: " ",
	});
	assert.equal(result.full, segment.text);
	assert.equal(result.source, "");
	assert.equal(result.original, segment.text);
});

test("手动出处在没有精确材料出处时仍可分享", () => {
	assert.equal(segmentShareText(segment, "作品").source, "作品\n第3巻 p.42");
});

test("有效出处兼容无 display 的结构化书名与章名", () => {
	assert.match(
		segmentShareText(
			segment,
			undefined,
			verified({ ...provenance, display: null }),
		).source,
		/《本の名前》\n第一章/,
	);
});

for (const status of [
	"material_deleted",
	"version_unavailable",
	"snapshot_mismatch",
	"invalid_reference",
	"none",
] as const) {
	test(`出处状态 ${status} 只保留材料名，不导出失效的章节或位置`, () => {
		const result = segmentShareText(
			segment,
			undefined,
			verified({
				...provenance,
				status,
			}),
		);
		assert.match(result.source, /《本の名前》/);
		assert.doesNotMatch(result.source, /第一章|12%/);
		assert.ok(result.full.includes("> 　机の前に座っているだけになった。"));
	});
}

test("其他片段的迟到出处不能出现在分享文本", () => {
	const result = segmentShareText(
		segment,
		undefined,
		verified({
			...provenance,
			segment_id: "other-segment",
		}),
	);
	assert.equal(result.source, "第3巻 p.42");
});

test("出处核对中不分享上次成功缓存的章节或位置", () => {
	const result = segmentShareText(segment, "作品", {
		...verified(provenance),
		isFetching: true,
	});
	assert.equal(result.source, "作品\n第3巻 p.42");
});

test("成功缓存后刷新失败，复制降级到来源与已保存出处", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const key = ["segments", segment.id, "material-provenance"];
	client.setQueryData(key, provenance);
	const observer = new QueryObserver<SegmentProvenance>(client, {
		queryKey: key,
		queryFn: () => Promise.reject(new Error("network unavailable")),
		enabled: false,
	});
	try {
		const query = await observer.refetch();
		assert.equal(query.isError, true);
		assert.equal(query.data, provenance);
		assert.equal(
			segmentShareText(segment, "作品", query).source,
			"作品\n第3巻 p.42",
		);
	} finally {
		observer.destroy();
		client.clear();
	}
});

test("无语境时原文直接接出处，同名来源与重复补充不重复输出", () => {
	const result = segmentShareText(
		{ ...segment, context_before: "", context_after: "", source_ref: "第一章" },
		"本の名前",
		verified(provenance),
	);
	assert.equal(result.full, `${segment.text}\n\n——《本の名前》\n第一章`);
	assert.equal(result.source, "《本の名前》\n第一章");
});

test("不从 display 猜章节，空材料名回退来源，已有书名括号不重复", () => {
	assert.equal(
		segmentShareText(
			{ ...segment, source_ref: "" },
			"系列",
			verified({ ...provenance, title: "《本の名前》", chapter_title: null }),
		).source,
		"《本の名前》",
	);
	assert.equal(
		segmentShareText(
			{ ...segment, source_ref: "" },
			"系列",
			verified({ ...provenance, title: " ", chapter_title: null }),
		).source,
		"系列",
	);
});
