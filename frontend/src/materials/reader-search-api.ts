import { api } from "../api/client";
import { requireData } from "../content";
import { searchMaterial } from "./api";
import type { ReaderSearchKind, RecordSearchKind } from "./reader-search";

export const readerSearchKey = (materialId: string, versionId: string) =>
	["materials", materialId, versionId, "book-search"] as const;
export async function searchRecords(
	materialId: string,
	versionId: string,
	kind: RecordSearchKind,
	query: string,
	chapterIds: string[] | null,
	offset: number,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/record-search",
		{
			params: {
				path: { material_id: materialId },
				query: {
					version_id: versionId,
					kind,
					q: query,
					offset,
					limit: 40,
					...(chapterIds === null ? {} : { chapter_ids: chapterIds }),
				},
			},
			signal,
		},
	);
	return requireData(data, error, response.status);
}
export async function searchReaderKind(
	materialId: string,
	versionId: string,
	kind: ReaderSearchKind,
	query: string,
	chapterIds: string[] | null,
	offset: number,
	signal?: AbortSignal,
) {
	if (kind === "original") {
		const page = await searchMaterial(
			materialId,
			versionId,
			query,
			offset,
			signal,
			chapterIds,
		);
		return {
			...page,
			items: page.items.map((item) => ({ kind: "original" as const, item })),
		};
	}
	const page = await searchRecords(
		materialId,
		versionId,
		kind,
		query,
		chapterIds,
		offset,
		signal,
	);
	return {
		...page,
		items: page.items.map((item) => ({ kind: "record" as const, item })),
	};
}
export type ReaderSearchHit = Awaited<
	ReturnType<typeof searchReaderKind>
>["items"][number];
