import type { components } from "../src/api/schema";

type Schema = components["schemas"];
const timestamp = "2026-10-24T00:00:00Z";
const hash = "a".repeat(64);
const materialId = "reader-session";
const versionId = "v1";
const chapterId = "long-chapter";
const paragraphs = Array.from(
	{ length: 400 },
	(_, index) =>
		`春の風。第${String(index).padStart(3, "0")}段落。静かな庭を通り抜ける。`,
);
const text = paragraphs.join("");
const startAt = (index: number) => paragraphs.slice(0, index).join("").length;
const targetParagraph = 350;
const targetStart = startAt(targetParagraph);
const targetText = paragraphs[targetParagraph] ?? "";
const reference: Schema["MaterialProvenance"] = {
	contract_version: "1",
	material_id: materialId,
	version_id: versionId,
	ranges: [
		{
			resource_id: "r",
			spine_index: 0,
			start: targetStart,
			end: targetStart + targetText.length,
			exact: targetText,
			text_sha256: hash,
			prefix: "",
			suffix: "",
		},
	],
};
const chapter: Schema["MaterialChapterResponse"] = {
	id: chapterId,
	material_id: materialId,
	version_id: versionId,
	title: "400段の長い章",
	level: 0,
	resources: [
		{
			id: "r",
			text,
			text_sha256: hash,
			href: "chapter.xhtml",
			css: "p{margin:0 0 1.8em}",
			html_attributes: { lang: "ja" },
			body_attributes: {},
		},
	],
	parts: [0, 140, 280].map((first, index) => {
		const end = index === 2 ? 400 : first + 140;
		return {
			resource_id: "r",
			spine_index: 0,
			start: startAt(first),
			end: startAt(end),
			leaf_start: first,
			leaf_end: end,
			html: paragraphs
				.slice(first, end)
				.map(
					(value, local) =>
						`<p><span data-locator-leaf="${first + local}">${value}</span></p>`,
				)
				.join(""),
		};
	}),
};
const book: Schema["MaterialResponse"] = {
	id: materialId,
	source_id: "source",
	title: "阅读会话测量",
	version_id: versionId,
	contract_version: "1",
	product_sha256: hash,
	source_sha256: hash,
	created_at: timestamp,
	warnings: [],
	chapters: [{ id: chapterId, title: chapter.title, level: 0, part_count: 3 }],
	reading_position: {
		chapter_id: chapterId,
		resource_id: "r",
		version_id: versionId,
		part_index: 0,
		kind: "text",
		offset: 0,
		at_chapter_end: false,
		progress: 0,
		revision: 0,
		updated_at: timestamp,
		settings: { font_size: 22, line_height: 2, writing_mode: "horizontal-tb" },
	},
};
const readings: Schema["MaterialReadingsResponse"] = {
	material_id: materialId,
	version_id: versionId,
	generation_id: "generation",
	resources: [
		{
			resource_id: "r",
			text_sha256: hash,
			tokens: paragraphs.map((_, index) => ({
				start: startAt(index),
				end: startAt(index) + 1,
				surface: "春",
				reading: "ハル",
				dictionary_form: "春",
				normalized_form: "春",
				is_oov: false,
				pos: ["名詞"],
			})),
		},
	],
};
export const readerSessionFixture = {
	materialId,
	versionId,
	chapterId,
	targetStart,
	book,
	chapter,
	readings,
	paragraphs,
	startAt,
	reference,
	targetParagraph,
	targetText,
	timestamp,
	hash,
};

/** Shared read-only API fixture; suites retain control of gates, writers and request counters. */
export function readerSessionFixtureData(
	path: string,
	options: {
		realApp?: boolean;
		invalidProvenance?: boolean;
		originChapter?: string;
		studyRecords?: boolean;
		addedStudyRecord?: boolean;
	} = {},
): unknown {
	if (path === "/api/sources/source")
		return {
			id: "source",
			title: "Source",
			description: "",
			note: "",
			segment_count: 1,
			created_at: timestamp,
			updated_at: timestamp,
		} satisfies Schema["SourceResponse"];
	if (options.realApp !== false && path === "/api/segments/saved")
		return {
			id: "saved",
			source_id: "source",
			text: targetText,
			text_sha256: hash,
			context_before: "",
			context_after: "",
			translation: "",
			transcription: "",
			source_ref: "",
			note: "",
			revision: 1,
			text_locked_at: timestamp,
			created_at: timestamp,
			updated_at: timestamp,
			material_provenance: reference,
		} satisfies Schema["SegmentResponse"];
	if (
		options.realApp !== false &&
		(path === "/api/segments/saved/analyses" ||
			path === "/api/segments/saved/translation-results")
	)
		return [];
	if (path.endsWith("/material-provenance"))
		return {
			segment_id: "saved",
			status: options.invalidProvenance ? "snapshot_mismatch" : "resolved",
			title: book.title,
			assembly_rule: "concat-nfc-v1",
			material_provenance: reference,
			chapter_id: options.originChapter ?? chapterId,
			chapter_title: chapter.title,
			parts: [
				{
					range_index: 0,
					part_index: 2,
					resource_id: "r",
					spine_index: 0,
					start: targetStart,
					end: targetStart + targetText.length,
				},
			],
		} satisfies Schema["SegmentProvenanceResponse"];
	if (path.endsWith("/readings/prepare"))
		return {
			material_id: materialId,
			version_id: versionId,
			generation_id: "generation",
			token_count: 400,
		} satisfies Schema["MaterialReadingsSummary"];
	if (path.endsWith("/readings")) return readings;
	if (path === `/api/materials/${materialId}/chapters/${chapterId}`)
		return chapter;
	if (path.endsWith("/segments"))
		return {
			items:
				options.studyRecords === false
					? []
					: [
							...(options.addedStudyRecord
								? [
										{
											segment_id: "new-saved",
											excerpt: paragraphs[20] ?? "",
											created_at: timestamp,
											material_provenance: {
												...reference,
												ranges: reference.ranges.map((range) => ({
													...range,
													start: startAt(20),
													end: startAt(21),
													exact: paragraphs[20] ?? "",
												})),
											},
										},
									]
								: []),
							{
								segment_id: "saved",
								excerpt: targetText,
								material_provenance: reference,
								created_at: timestamp,
							},
						],
			next_cursor: null,
			unavailable_count: 0,
		} satisfies Schema["MaterialChapterSegmentsResponse"];
	if (/\/chapters\/[^/]+\/translations$/.test(path))
		return { items: [], next_cursor: null, unavailable_count: 0 };
	if (path.endsWith("/translations"))
		return { results: [], tasks: [], next_offset: null };
	if (path.endsWith("/usage") || path.endsWith("/opened"))
		return {
			material_id: materialId,
			status: "in_progress",
			revision: 1,
			last_opened_at: timestamp,
			updated_at: timestamp,
		} satisfies Schema["MaterialUsageResponse"];
	return undefined;
}
