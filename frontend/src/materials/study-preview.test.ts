import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisDetail, AnalysisItem } from "../analysis/api.ts";
import { previewAnalyses, previewDocument } from "./study-preview.ts";

function analysis(
	id: string,
	updatedAt: string,
	segmentId = "segment-a",
): AnalysisItem {
	return {
		id,
		segment_id: segmentId,
		current_revision_id: `revision-${id}`,
		title: id,
		excerpt: "讲解正文",
		created_at: "2026-10-20T08:00:00Z",
		updated_at: updatedAt,
	};
}

test("预览从共享分页中选择最近更新的当前片段讲解，不修改缓存", () => {
	const first = analysis("older", "2026-10-21T08:00:00Z");
	const newest = analysis("newest", "2026-10-22T08:00:00Z");
	const foreign = analysis("foreign", "2026-10-23T08:00:00Z", "segment-b");
	const pages = [
		[first, foreign],
		[newest, first],
	];
	assert.deepEqual(previewAnalyses(pages, "segment-a"), [newest, first]);
	assert.deepEqual(pages, [
		[first, foreign],
		[newest, first],
	]);
	assert.deepEqual(previewAnalyses(undefined, "segment-a"), []);
});

test("晚到的其他片段、讲解或修订响应不能作为当前预览正文", () => {
	const selected = analysis("analysis-a", "2026-10-22T08:00:00Z");
	const document: AnalysisDetail = {
		...selected,
		revision_id: selected.current_revision_id,
		source_md: "# 标题\n\n讲解正文",
		sections: [],
		warnings: [],
		normalizer_version: 1,
		origin: "manual",
		parent_revision_id: null,
		run_id: null,
	};
	assert.equal(previewDocument(document, "segment-a", selected), document);
	assert.equal(previewDocument(document, "segment-b", selected), null);
	assert.equal(
		previewDocument(document, "segment-a", { ...selected, id: "other" }),
		null,
	);
	assert.equal(
		previewDocument(document, "segment-a", {
			...selected,
			current_revision_id: "newer",
		}),
		null,
	);
	assert.equal(previewDocument(undefined, "segment-a", selected), null);
	assert.equal(previewDocument(document, "segment-a", undefined), null);
});
