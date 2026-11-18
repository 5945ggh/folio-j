import type { components } from "../src/api/schema";
import type { Book, CatalogSegment } from "../src/catalog/api";

export function overviewItems(sourceId: string, edition: string) {
	const timestamp = "2026-11-10T00:00:00Z";
	const segment: CatalogSegment = {
		id: `seg-${sourceId}`,
		source_id: sourceId,
		text: `例文（${edition}）`,
		text_sha256: "a".repeat(64),
		context_before: "",
		context_after: "",
		created_at: timestamp,
		updated_at: timestamp,
		text_locked_at: null,
		revision: 1,
		note: "",
		source_ref: "",
		transcription: "",
		translation: "",
		material_provenance: null,
		provenance_summary: {
			status: "none",
			display: null,
			title: null,
			chapter_title: null,
		},
	};
	const analysis: components["schemas"]["AnalysisCatalogItem"] = {
		id: `analysis-${sourceId}`,
		current_revision_id: "revision",
		segment_id: segment.id,
		title: `講解（${edition}）`,
		excerpt: "",
		segment_excerpt: "",
		created_at: timestamp,
		updated_at: timestamp,
	};
	const book: Book = {
		id: `book-${sourceId}`,
		title: `書籍（${edition}）`,
		source_id: sourceId,
		source_title: sourceId,
		type: "book",
		version_id: "v1",
		contract_version: "1",
		created_at: timestamp,
		last_opened_at: null,
		cover_url: null,
		status: "not_started",
		usage_revision: 0,
		product_sha256: "a".repeat(64),
		source_sha256: "b".repeat(64),
		warnings: [],
	};
	return { analysis, segment, book };
}

export function showsOverview(
	container: Element,
	items: ReturnType<typeof overviewItems>,
) {
	return (
		[
			["最近更新的讲解", items.analysis.title],
			["最近添加的片段", items.segment.text],
			["所属素材", items.book.title],
		] as const
	).every(([region, text]) =>
		container
			.querySelector(`section[aria-label="${region}"]`)
			?.textContent?.includes(text),
	);
}
