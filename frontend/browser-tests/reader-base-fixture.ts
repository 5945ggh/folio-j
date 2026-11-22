import type { components } from "../src/api/schema";

type Schema = components["schemas"];
type ReaderBook = Schema["MaterialResponse"];
type Chapter = Schema["MaterialChapterResponse"];
type Options = {
	sourceTitle?: string;
	segmentCount?: number;
	generationId?: string;
	tokenCount?: number;
};

export function readerBaseData(
	method: string,
	path: string,
	book: ReaderBook,
	chapters: Chapter[],
	options: Options = {},
): unknown {
	const base = `/api/materials/${book.id}`;
	const identity = {
		material_id: book.id,
		version_id: book.version_id,
		generation_id: options.generationId ?? "generation",
	};
	if (method === "POST" && path === `${base}/readings/prepare`)
		return {
			...identity,
			token_count: options.tokenCount ?? 0,
		} satisfies Schema["MaterialReadingsSummary"];
	if (
		(method === "POST" && path === `${base}/opened`) ||
		(method === "GET" && path === `${base}/usage`)
	)
		return {
			material_id: book.id,
			status: "in_progress",
			revision: 1,
			last_opened_at: book.created_at,
			updated_at: book.created_at,
		} satisfies Schema["MaterialUsageResponse"];
	if (method !== "GET") return undefined;
	if (path === base) return book;
	if (path === `/api/sources/${book.source_id}`)
		return {
			id: book.source_id,
			title: options.sourceTitle ?? "Source",
			description: "",
			note: "",
			segment_count: options.segmentCount ?? 0,
			created_at: book.created_at,
			updated_at: book.created_at,
		} satisfies Schema["SourceResponse"];
	if (path === `${base}/readings`)
		return {
			...identity,
			resources: [],
		} satisfies Schema["MaterialReadingsResponse"];
	if (path === `${base}/translations`)
		return { results: [], tasks: [], next_offset: null };
	for (const chapter of chapters) {
		const chapterPath = `${base}/chapters/${chapter.id}`;
		if (path === chapterPath) return chapter;
		if (
			path === `${chapterPath}/segments` ||
			path === `${chapterPath}/translations`
		)
			return { items: [], next_cursor: null, unavailable_count: 0 };
	}
	return undefined;
}

export function readerBaseResponse(
	...args: Parameters<typeof readerBaseData>
): Response {
	const data = readerBaseData(...args);
	if (data === undefined)
		throw new Error(`Unmocked reader request ${args[0]} ${args[1]}`);
	return Response.json(data);
}
