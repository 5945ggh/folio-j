import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import type { components } from "../api/schema";
import { RequestError, requireData } from "../content";

export type AnkiBuiltins = components["schemas"]["AnkiBuiltins"];
export type AnkiExportPreset = components["schemas"]["AnkiExportPreset"];
export type BuiltinNoteType = components["schemas"]["BuiltinNoteType"];
export type AnkiBuiltinNoteTypeRef =
	components["schemas"]["AnkiBuiltinNoteTypeRef"];
export type AnkiBuiltinNoteTypeTarget =
	components["schemas"]["AnkiBuiltinNoteTypeTarget"];
export type AnkiExternalNoteTypeTarget =
	components["schemas"]["AnkiExternalNoteTypeTarget"];
export type AnkiNoteTypeTarget =
	| AnkiBuiltinNoteTypeTarget
	| AnkiExternalNoteTypeTarget;
export type AnkiDeckTarget = components["schemas"]["AnkiDeckTarget"];
export type AnkiTargetScope = components["schemas"]["AnkiTargetScope"];
export type AnkiFieldDefinition = components["schemas"]["AnkiFieldDefinition"];
export type AnkiConfigurationInput =
	components["schemas"]["AnkiConfigurationInput"];
export type AnkiConfigurationResponse =
	components["schemas"]["AnkiConfigurationResponse"];
export type AnkiConnectionInput = components["schemas"]["AnkiConnectionInput"];
export type AnkiConnectionResponse =
	components["schemas"]["AnkiConnectionResponse"];
export type AnkiCollectionInfo = components["schemas"]["AnkiCollectionInfo"];
export type AnkiCatalog = components["schemas"]["AnkiCatalog"];
export type AnkiCatalogItem = components["schemas"]["AnkiCatalogItem"];
export type AnkiTypeFields = components["schemas"]["AnkiTypeFields"];
export type AnkiExportInput = components["schemas"]["AnkiExportInput"];
export type AnkiExportField = components["schemas"]["AnkiExportField"];
export type AnkiExportAttachment =
	components["schemas"]["AnkiExportAttachment"];
export type AnkiExportResponse = components["schemas"]["AnkiExportResponse"];
export type AnkiReadFailure = components["schemas"]["AnkiReadFailure"];
export type AnkiFailureCode = NonNullable<AnkiReadFailure["code"]>;

export const ankiKeys = {
	builtins: ["anki", "builtins"] as const,
	connection: ["anki", "connection"] as const,
	configurations: ["anki", "configurations"] as const,
	catalog: ["anki", "catalog"] as const,
	noteTypeFields: (endpoint: string, profile: string, noteTypeId: string) =>
		["anki", "note-type-fields", endpoint, profile, noteTypeId] as const,
};

export class AnkiRequestError extends RequestError {
	readonly code: AnkiFailureCode | null;

	constructor(
		message: string,
		status: number,
		code: AnkiFailureCode | null = null,
	) {
		super(message, status);
		this.name = "AnkiRequestError";
		this.code = code;
	}
}

export function ankiError(error: unknown, status: number): AnkiRequestError {
	if (error && typeof error === "object") {
		const record = error as { detail?: unknown; code?: unknown };
		const detail =
			typeof record.detail === "string" && record.detail.trim()
				? record.detail.trim()
				: undefined;
		const code =
			typeof record.code === "string" ? (record.code as AnkiFailureCode) : null;
		if (detail) return new AnkiRequestError(detail, status, code);
	}
	if (status === 403)
		return new AnkiRequestError(
			"AnkiConnect 拒绝访问，请检查 API 密钥。",
			status,
			"authentication",
		);
	if (status === 422)
		return new AnkiRequestError("请检查输入格式与必填项。", status, null);
	if (status === 0)
		return new AnkiRequestError("无法连接本地服务，请稍后重试。", status, null);
	return new AnkiRequestError("Anki 请求失败，请稍后重试。", status, null);
}

function requireAnkiData<T>(
	data: T | undefined,
	error: unknown,
	status: number,
): T {
	if (data === undefined) throw ankiError(error, status);
	return data;
}

export async function getAnkiBuiltins(signal?: AbortSignal) {
	const { data, error, response } = await api.GET("/api/anki/builtins", {
		signal,
	});
	return requireData(data, error, response.status);
}

export async function getAnkiConnection(signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/settings/anki/connection",
		{ signal },
	);
	return requireData(data, error, response.status);
}

export async function saveAnkiConnection(body: AnkiConnectionInput) {
	const { data, error, response } = await api.PUT(
		"/api/settings/anki/connection",
		{ body },
	);
	return requireData(data, error, response.status);
}

export async function listAnkiConfigurations(signal?: AbortSignal) {
	const { data, error, response } = await api.GET(
		"/api/settings/anki/configurations",
		{ signal },
	);
	return requireData(data, error, response.status);
}

export async function createAnkiConfiguration(body: AnkiConfigurationInput) {
	const { data, error, response } = await api.POST(
		"/api/settings/anki/configurations",
		{ body },
	);
	return requireData(data, error, response.status);
}

export async function updateAnkiConfiguration(
	id: string,
	body: AnkiConfigurationInput,
) {
	const { data, error, response } = await api.PUT(
		"/api/settings/anki/configurations/{configuration_id}",
		{ params: { path: { configuration_id: id } }, body },
	);
	return requireData(data, error, response.status);
}

export async function deleteAnkiConfiguration(id: string) {
	const { error, response } = await api.DELETE(
		"/api/settings/anki/configurations/{configuration_id}",
		{ params: { path: { configuration_id: id } } },
	);
	if (!response.ok) throw ankiError(error, response.status);
}

export async function probeAnkiConnection(
	body?: AnkiConnectionInput | null,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.POST("/api/anki/probe", {
		body: body ?? undefined,
		signal,
	});
	return requireAnkiData(data, error, response.status);
}

export async function getAnkiCatalog(signal?: AbortSignal) {
	const { data, error, response } = await api.GET("/api/anki/catalog", {
		signal,
	});
	return requireAnkiData(data, error, response.status);
}

export function ankiTypeFieldsOptions(
	catalog: AnkiCatalog | undefined,
	targetId?: string,
) {
	return queryOptions({
		queryKey: ankiKeys.noteTypeFields(
			catalog?.endpoint ?? "",
			catalog?.profile ?? "",
			targetId ?? "",
		),
		queryFn: ({ signal }) => {
			if (!catalog || !targetId) throw new Error("缺少当前笔记类型");
			return getAnkiNoteTypeFields(
				catalog.endpoint,
				catalog.profile,
				targetId,
				signal,
			);
		},
		enabled: Boolean(catalog && targetId),
		retry: false,
	});
}

export async function getAnkiNoteTypeFields(
	endpoint: string,
	profile: string,
	noteTypeId: string,
	signal?: AbortSignal,
) {
	const { data, error, response } = await api.POST(
		"/api/anki/note-type-fields",
		{
			body: { endpoint, profile, note_type_id: noteTypeId },
			signal,
		},
	);
	return requireAnkiData(data, error, response.status);
}

export async function exportAnkiNote(body: AnkiExportInput) {
	const { data, error, response } = await api.POST("/api/anki/export", {
		body,
	});
	return requireAnkiData(data, error, response.status);
}
