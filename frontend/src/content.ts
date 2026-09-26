import { api } from "./api/client";
import type { components } from "./api/schema";

export type Source = components["schemas"]["SourceResponse"];
export type Segment = components["schemas"]["SegmentResponse"];
export type SourceFields = Required<components["schemas"]["SourceCreate"]>;
export type SegmentFields = Required<components["schemas"]["SegmentCreate"]>;

export class RequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export function errorMessage(error: unknown, status: number): RequestError {
	const detail =
		error && typeof error === "object" && "detail" in error
			? error.detail
			: undefined;
	if (typeof detail === "string") return new RequestError(detail, status);
	if (status === 404) return new RequestError("记录不存在或已删除。", status);
	if (status === 409)
		return new RequestError(
			"目标原文已锁定，无法修改。其他附带信息仍可编辑。",
			status,
		);
	if (status === 422)
		return new RequestError("输入未通过验证，请检查必填项和长度。", status);
	if (status === 0)
		return new RequestError("无法连接服务，请检查本地服务后重试。", status);
	return new RequestError(
		typeof detail === "string" ? detail : "操作失败，请稍后重试。",
		status,
	);
}

export function requireData<T>(
	data: T | undefined,
	error: unknown,
	status: number,
): T {
	if (data === undefined) throw errorMessage(error, status);
	return data;
}

export const queries = {
	sources: ["sources"] as const,
	source: (id: string) => ["source", id] as const,
	segments: (id: string) => ["source-segments", id] as const,
	segment: (id: string) => ["segment", id] as const,
	impact: (id: string) => ["source-delete-impact", id] as const,
	segmentImpact: (id: string) => ["segment-delete-impact", id] as const,
};

export async function listSources() {
	const { data, error, response } = await api.GET("/api/sources");
	return requireData(data, error, response.status);
}
export async function getSource(id: string) {
	const { data, error, response } = await api.GET("/api/sources/{source_id}", {
		params: { path: { source_id: id } },
	});
	return requireData(data, error, response.status);
}
export async function listSegments(id: string) {
	const { data, error, response } = await api.GET(
		"/api/sources/{source_id}/segments",
		{ params: { path: { source_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function getSegment(id: string) {
	const { data, error, response } = await api.GET(
		"/api/segments/{segment_id}",
		{ params: { path: { segment_id: id } } },
	);
	return requireData(data, error, response.status);
}
export async function getDeleteImpact(id: string) {
	const { data, error, response } = await api.GET(
		"/api/sources/{source_id}/delete-impact",
		{ params: { path: { source_id: id } } },
	);
	return requireData(data, error, response.status);
}

export async function getSegmentDeleteImpact(id: string) {
	const { data, error, response } = await api.GET(
		"/api/segments/{segment_id}/delete-impact",
		{ params: { path: { segment_id: id } } },
	);
	return requireData(data, error, response.status);
}
