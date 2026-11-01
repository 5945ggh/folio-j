import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Chapter } from "./api.ts";
import {
	originFailure,
	originPosition,
	recordOriginPosition,
} from "./reader-origin.ts";
import type { ReaderHighlightRange } from "./reader-selection.ts";
import { referenceParts } from "./reader-selection.ts";
import type { SegmentProvenance } from "./study-api.ts";

const settings = {
	font_size: 22,
	line_height: 2,
	writing_mode: "horizontal-tb" as const,
};
const cases = JSON.parse(
	readFileSync(
		new URL("./fixtures/c2-context-cases.json", import.meta.url),
		"utf8",
	),
) as {
	chapter_cases: {
		id: string;
		resources: Chapter["resources"];
		parts: Chapter["parts"];
		ranges: ReaderHighlightRange[];
		navigation: { part_index: number; resource_id: string; offset: number };
		highlights: {
			part_index: number;
			local_start: number;
			local_end: number;
		}[];
	}[];
};

for (const item of cases.chapter_cases) {
	test(`fixed fixture ${item.id} maps every interval and starts at its exact first occurrence`, () => {
		const chapter = {
			id: "chapter",
			material_id: "m",
			version_id: "v",
			resources: item.resources,
			parts: item.parts,
		} as Chapter;
		const projected = referenceParts(chapter, item.ranges);
		assert.deepEqual(
			[...projected].flatMap(([part_index, intervals]) =>
				intervals.map(({ start, end }) => ({
					part_index,
					local_start: start,
					local_end: end,
				})),
			),
			item.highlights.map(({ part_index, local_start, local_end }) => ({
				part_index,
				local_start,
				local_end,
			})),
		);
		const origin = {
			segment_id: "segment",
			status: "resolved",
			chapter_id: "chapter",
			assembly_rule: "concat-nfc-v1",
			material_provenance: {
				contract_version: "1",
				material_id: "m",
				version_id: "v",
				ranges: item.ranges,
			},
			parts: item.highlights.map((part, index) => ({
				range_index: index,
				part_index: part.part_index,
				resource_id: item.ranges[index]?.resource_id,
				spine_index: item.ranges[index]?.spine_index,
				start: item.ranges[index]?.start,
				end: item.ranges[index]?.end,
			})),
		} as SegmentProvenance;
		const anchor = originPosition(origin, settings);
		assert.equal(anchor.part_index, item.navigation.part_index);
		assert.equal(anchor.resource_id, item.navigation.resource_id);
		assert.equal(anchor.offset, item.navigation.offset);
		assert.equal(anchor.at_chapter_end, false);
		assert.equal(originFailure(origin), null);
		const reference = origin.material_provenance;
		assert.ok(reference);
		assert.deepEqual(
			recordOriginPosition(reference, chapter, settings),
			anchor,
		);
		for (const changed of [
			{ ...reference, material_id: "another-book" },
			{ ...reference, version_id: "old-version" },
			{
				...reference,
				ranges: reference.ranges.map((range, index) =>
					index === reference.ranges.length - 1
						? { ...range, exact: "失配した原文" }
						: range,
				),
			},
			{
				...reference,
				ranges: reference.ranges.map((range) => ({
					...range,
					text_sha256: "changed-snapshot",
				})),
			},
			{
				...reference,
				ranges: reference.ranges.map((range) => ({
					...range,
					spine_index: 9999,
				})),
			},
			{ ...reference, ranges: [] },
		])
			assert.throws(() => recordOriginPosition(changed, chapter, settings));
		for (const status of [
			"snapshot_mismatch",
			"material_deleted",
			"version_unavailable",
			"invalid_reference",
			"none",
		] as const) {
			assert.ok(originFailure({ ...origin, status }));
			assert.throws(() => originPosition({ ...origin, status }, settings));
		}
		assert.throws(
			() => originPosition({ ...origin, parts: [] }, settings),
			/完整/,
		);
	});
}
