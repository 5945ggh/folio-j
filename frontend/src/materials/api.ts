import { api } from "../api/client";
import type { components } from "../api/schema";
import { requireData } from "../content";
import { waitForPositionWrites } from "./persistence";
export type Material = components["schemas"]["MaterialResponse"];
export type Chapter = components["schemas"]["MaterialChapterResponse"];
export type Position = Omit<
	components["schemas"]["ReadingPositionUpdate"],
	"expected_revision"
>;
export type Settings = components["schemas"]["ReadingSettings"];
export const materialKeys = {
	list: (id: string) => ["materials", "source", id] as const,
	book: (id: string) => ["materials", id] as const,
	chapter: (id: string, chapter: string) =>
		["materials", id, "chapter", chapter] as const,
};
export async function listMaterials(id: string) {
	const { data, error, response } = await api.GET(
		"/api/sources/{source_id}/materials",
		{ params: { path: { source_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function importMaterial(id: string, file: File) {
	const { data, error, response } = await api.POST(
		"/api/sources/{source_id}/materials",
		{
			params: { path: { source_id: id }, query: { filename: file.name } },
			headers: { "Content-Type": "application/epub+zip" },
			body: "",
			bodySerializer: () => file,
		},
	);
	return requireData(data, error, response.status);
}
export async function getMaterial(id: string) {
	await waitForPositionWrites(id);
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}",
		{ params: { path: { material_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function getChapter(id: string, chapter: string) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/chapters/{chapter_id}",
		{ params: { path: { material_id: id, chapter_id: chapter } } },
	);
	return requireData(data, error, response.status);
}
export async function savePosition(
	id: string,
	position: Position,
	revision: number,
) {
	const { data, error, response } = await api.PUT(
		"/api/materials/{material_id}/reading-position",
		{
			params: { path: { material_id: id } },
			body: { ...position, expected_revision: revision },
		},
	);
	return requireData(data, error, response.status);
}

export type MaterialUsage = components["schemas"]["MaterialUsageResponse"];
export const usageKey = (id: string) => ["materials", id, "usage"] as const;
export async function getUsage(id: string) {
	const { data, error, response } = await api.GET(
		"/api/materials/{material_id}/usage",
		{ params: { path: { material_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function recordOpened(
	id: string,
	actionId: string,
	revision: number,
) {
	const { data, error, response } = await api.POST(
		"/api/materials/{material_id}/opened",
		{
			params: { path: { material_id: id } },
			body: { action_id: actionId, expected_revision: revision },
		},
	);
	return requireData(data, error, response.status);
}
export async function setUsage(
	id: string,
	status: MaterialUsage["status"],
	revision: number,
) {
	const { data, error, response } = await api.PUT(
		"/api/materials/{material_id}/usage",
		{
			params: { path: { material_id: id } },
			body: { status, expected_revision: revision },
		},
	);
	return requireData(data, error, response.status);
}
