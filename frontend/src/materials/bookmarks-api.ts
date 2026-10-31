import { api } from "../api/client";
import type { components } from "../api/schema";
import { errorMessage, requireData } from "../content";

export type Bookmark = components["schemas"]["BookmarkResponse"];
export type BookmarkCreate = components["schemas"]["BookmarkCreate"];
export type BookmarkCreateResult = Awaited<ReturnType<typeof createBookmark>>;
export type BookmarkPosition = Bookmark["position"];
export const bookmarkKeys = {
	list: (materialId: string, versionId: string) =>
		["materials", materialId, versionId, "position-bookmarks"] as const,
	item: (materialId: string, id: string) =>
		["materials", materialId, "position-bookmark", id] as const,
};
export async function listBookmarks(
	materialId: string,
	versionId: string,
	offset: number,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/bookmarks",
		{
			params: {
				path: { material_id: materialId },
				query: { version_id: versionId, offset, limit: 40 },
			},
			signal,
		},
	);
	return requireData(data, error, response.status);
}
export async function createBookmark(materialId: string, body: BookmarkCreate) {
	const { data, error, response } = await api.POST(
		"/api/materials/{material_id}/bookmarks",
		{
			params: { path: { material_id: materialId } },
			body,
		},
	);
	return requireData(data, error, response.status);
}
export async function getBookmark(
	materialId: string,
	id: string,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/bookmarks/{bookmark_id}",
		{
			params: { path: { material_id: materialId, bookmark_id: id } },
			signal,
		},
	);
	return requireData(data, error, response.status);
}
export async function updateBookmark(
	materialId: string,
	id: string,
	note: string,
	revision: number,
) {
	const { data, error, response } = await api.PATCH(
		"/api/materials/{material_id}/bookmarks/{bookmark_id}",
		{
			params: { path: { material_id: materialId, bookmark_id: id } },
			body: { note, expected_revision: revision },
		},
	);
	return requireData(data, error, response.status);
}
export async function deleteBookmark(
	materialId: string,
	id: string,
	revision: number,
) {
	const { error, response } = await api.DELETE(
		"/api/materials/{material_id}/bookmarks/{bookmark_id}",
		{
			params: {
				path: { material_id: materialId, bookmark_id: id },
				query: { expected_revision: revision },
			},
		},
	);
	if (error || !response.ok) throw errorMessage(error, response.status);
}
