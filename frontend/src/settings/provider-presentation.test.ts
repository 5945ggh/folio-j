import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "./api.ts";
import { historyFilters, summarizeProvider } from "./provider-presentation.ts";

function model(overrides: Partial<Model> = {}): Model {
	return {
		id: "registered-model",
		provider_id: "provider",
		model_id: "remote-model",
		enabled: true,
		effective_protocol: "responses",
		revision: 1,
		text_status: "unknown",
		stream_status: "unknown",
		text_verification: null,
		stream_verification: null,
		...overrides,
	};
}

test("provider summary requires both text capabilities and enabled configuration", () => {
	assert.equal(
		summarizeProvider({
			enabled: true,
			models: [model({ text_status: "succeeded" })],
		}).ready,
		0,
	);
	const ready = model({ text_status: "succeeded", stream_status: "succeeded" });
	assert.equal(summarizeProvider({ enabled: true, models: [ready] }).ready, 1);
	assert.equal(summarizeProvider({ enabled: false, models: [ready] }).ready, 0);
	assert.equal(
		summarizeProvider({ enabled: true, models: [{ ...ready, enabled: false }] })
			.ready,
		0,
	);
	assert.match(
		summarizeProvider({ enabled: true, models: [ready] }).label,
		/文本验证/,
	);
});

test("current interrupted verification overrides a historical success", () => {
	const current = model({
		text_status: "succeeded",
		stream_status: "succeeded",
		text_verification: {
			id: "run",
			status: "interrupted",
			created_at: "2026-10-15T00:00:00Z",
			finished_at: "2026-10-15T00:00:01Z",
			error: "worker stopped",
		},
	});
	const summary = summarizeProvider({ enabled: true, models: [current] });
	assert.equal(summary.ready, 0);
	assert.equal(summary.tone, "warning");
});

test("history filters use registered model identity and fixed provider scope", () => {
	assert.deepEqual(
		historyFilters("fixed", "other", "registered-model", "failed"),
		{
			provider_id: "fixed",
			model_id: "registered-model",
			status: "failed",
		},
	);
	assert.deepEqual(historyFilters(undefined, "selected", "", ""), {
		provider_id: "selected",
	});
	assert.deepEqual(historyFilters(undefined, "", "", ""), {});
});
