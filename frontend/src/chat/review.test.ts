import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "./api";
import { describeReview } from "./review.ts";

test("审核说明保留目标块的原文与拟更新内容", () => {
	const proposal = {
		tool_call_id: "call",
		tool_name: "update_analysis_section",
		source_run_id: "run",
		analysis_id: "a",
		base_revision_id: "r",
		title: "讲解",
		before: "## 旧标题\n旧正文",
		after: "## 新标题\n\n新正文",
		operation: {
			kind: "update_section",
			sid: "old-uid",
			title: "新标题",
			body: "新正文",
		},
	} satisfies NonNullable<Job["review_proposal"]>;
	const base = {
		sections: [
			{
				id: "row",
				uid: "old-uid",
				handle: "02",
				kind: "section",
				title: "旧标题",
				raw: "## 旧标题\n旧正文",
			},
		],
	};
	const result = describeReview(
		proposal,
		base as Parameters<typeof describeReview>[1],
	);
	assert.equal(result?.target, "旧标题");
	assert.equal(result?.before, "## 旧标题\n旧正文");
	assert.equal(result?.after, "## 新标题\n\n新正文");
});

test("插入审核按方案顺序列出所有新块", () => {
	const proposal = {
		tool_call_id: "call",
		tool_name: "insert_analysis_sections",
		source_run_id: "run",
		analysis_id: "a",
		base_revision_id: "r",
		title: "讲解",
		before: "",
		after: "## 第一\n\n甲\n## 第二\n\n乙",
		operation: {
			kind: "insert_sections",
			sections: [
				{ title: "第一", body: "甲" },
				{ title: "第二", body: "乙" },
			],
		},
	} satisfies NonNullable<Job["review_proposal"]>;
	const result = describeReview(proposal);
	assert.match(result?.after ?? "", /第一[\s\S]*第二/);
});
