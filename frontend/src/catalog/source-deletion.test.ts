import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { forgetSourceDetails } from "./source-deletion.ts";

test("来源删除只撤销归属已知的片段与书籍详情读取，包括目录预热后的首次详情请求", async () => {
	const client = new QueryClient();
	const signals: AbortSignal[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const reads = [];
	for (const [list, detail] of [
		["books", "book-details"],
		["segments", "segment"],
	] as const) {
		const items = ["removed", "kept"].map((source_id) => ({
			id: `${source_id}-${list}`,
			source_id,
		}));
		client.setQueryData(["catalog", list], { items });
		for (const item of items)
			reads.push(
				client
					.fetchQuery({
						queryKey: [detail, item.id],
						queryFn: async ({ signal }) => {
							signals.push(signal);
							await gate;
							return item;
						},
					})
					.catch(() => undefined),
			);
	}
	await forgetSourceDetails(client, "removed");
	assert.deepEqual(
		signals.map((signal) => signal.aborted),
		[true, false, true, false],
	);
	release();
	await Promise.all(reads);
	for (const [list, detail] of [
		["books", "book-details"],
		["segments", "segment"],
	] as const) {
		assert.equal(client.getQueryState([detail, `removed-${list}`]), undefined);
		assert.ok(client.getQueryData([detail, `kept-${list}`]));
	}
	client.clear();
});
