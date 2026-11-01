import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogSegment } from "./api.ts";
import { segmentOriginLabel, segmentOriginParts } from "./segment-origin.ts";

const manual: Pick<
	CatalogSegment,
	"material_provenance" | "provenance_summary" | "source_ref"
> = {
	material_provenance: null,
	provenance_summary: {
		status: "none",
		display: null,
		title: null,
		chapter_title: null,
	},
	source_ref: "",
};
const material: typeof manual = {
	material_provenance: {
		contract_version: "1",
		material_id: "book",
		version_id: "version",
		ranges: [],
	},
	provenance_summary: {
		status: "resolved",
		display: "雪国 · 第一章 · 章内约 35%",
		title: "雪国",
		chapter_title: "第一章",
		chapter_percent: 35,
	},
	source_ref: "",
};

test("独立字段分组不切割名称内部的分隔符", () => {
	const title = "长书名 · 副标题";
	const chapter = "第10话 · 前篇";
	assert.deepEqual(
		segmentOriginParts({
			...material,
			provenance_summary: {
				status: "resolved",
				title,
				chapter_title: chapter,
				chapter_percent: 2,
				display: "兼容显示文案不参与分组",
			},
		}),
		[
			{ kind: "title", text: title },
			{ kind: "chapter", text: chapter },
			{ kind: "position", text: "章内约 2%" },
		],
	);
});

test("缺少章名时仍保留书名和整块位置", () => {
	assert.deepEqual(
		segmentOriginParts({
			...material,
			provenance_summary: {
				status: "resolved",
				title: "雪国",
				chapter_title: null,
				display: "雪国 · 章内约 2%",
				chapter_percent: 2,
			},
		}),
		[
			{ kind: "title", text: "雪国" },
			{ kind: "position", text: "章内约 2%" },
		],
	);
});

test("未知显示格式整体保留，失效状态不提取旧章名或位置", () => {
	assert.deepEqual(
		segmentOriginParts({
			...material,
			provenance_summary: {
				...material.provenance_summary,
				display: "不同格式的可靠出处",
				chapter_percent: undefined,
			},
		}),
		[{ kind: "reference", text: "不同格式的可靠出处" }],
	);
	assert.deepEqual(
		segmentOriginParts({
			...material,
			provenance_summary: {
				...material.provenance_summary,
				status: "material_deleted",
			},
		}),
		[
			{ kind: "title", text: "雪国" },
			{ kind: "state", text: "材料已删除" },
		],
	);
});

test("手动片段展示已填出处，空白时明确未保存出处", () => {
	assert.equal(segmentOriginLabel(manual), "未保存出处");
	assert.equal(
		segmentOriginLabel({ ...manual, source_ref: "  第三集 05:30  " }),
		"第三集 05:30",
	);
});

test("具体材料位置优先，手填出处作为补充且不重复书名", () => {
	assert.equal(segmentOriginLabel(material), "雪国 · 第一章 · 章内约 35%");
	assert.equal(
		segmentOriginLabel({ ...material, source_ref: "文库版" }),
		"雪国 · 第一章 · 章内约 35% · 出处补充：文库版",
	);
	assert.equal(
		segmentOriginLabel({ ...material, source_ref: "雪国" }),
		"雪国 · 第一章 · 章内约 35%",
	);
});

test("失效出处保留可靠书名和状态，不沿用失效的章名与位置", () => {
	for (const [status, label] of [
		["material_deleted", "材料已删除"],
		["version_unavailable", "材料版本不可用"],
		["snapshot_mismatch", "原文快照不一致"],
		["invalid_reference", "无法精确定位"],
	] as const) {
		assert.equal(
			segmentOriginLabel({
				...material,
				provenance_summary: { ...material.provenance_summary, status },
			}),
			`雪国 · ${label}`,
		);
	}
});

test("损坏出处即使缺少原始定位仍显示失效，不冒充手动片段", () => {
	assert.equal(
		segmentOriginLabel({
			...manual,
			provenance_summary: {
				status: "invalid_reference",
				display: null,
				title: null,
				chapter_title: null,
			},
			source_ref: "文库版",
		}),
		"材料出处 · 无法精确定位 · 出处补充：文库版",
	);
});
