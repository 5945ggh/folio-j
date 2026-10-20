import type { components } from "../api/schema";

type Segment = components["schemas"]["SegmentResponse"];
type Analysis = components["schemas"]["AnalysisDetail"];
type CreateInput = components["schemas"]["ManualAnalysisCreate"];
type RevisionInput = components["schemas"]["ManualAnalysisRevisionCreate"];
type WriteErrorCode =
	components["schemas"]["AnalysisWriteErrorResponse"]["code"];

export type AnalysisEditorBase = {
	segment: Pick<Segment, "id" | "source_id" | "text_sha256" | "text_locked_at">;
	analysis?: Pick<
		Analysis,
		"id" | "segment_id" | "revision_id" | "current_revision_id" | "source_md"
	>;
};
export type AnalysisDraft = {
	sourceMd: string;
	title: string;
};
export type ManualAnalysisRequest =
	| { kind: "create"; segmentId: string; body: Readonly<CreateInput> }
	| { kind: "revision"; analysisId: string; body: Readonly<RevisionInput> };

export const MAX_ANALYSIS_CHARACTERS = 500_000;

export function sourceError(source: string): string | null {
	const normalized = source.normalize("NFC");
	if (!normalized.trim()) return "讲解正文不能为空白。";
	if (Array.from(normalized).length > MAX_ANALYSIS_CHARACTERS)
		return "讲解正文不能超过 500,000 个字符。";
	return null;
}

export function titleError(title: string): string | null {
	return Array.from(title.normalize("NFC").trim()).length > 200
		? "标题不能超过 200 个字符。"
		: null;
}

export function analysisDraftChanged(
	base: AnalysisEditorBase,
	draft: AnalysisDraft,
): boolean {
	return (
		draft.sourceMd.normalize("NFC") !==
			(base.analysis?.source_md ?? "").normalize("NFC") ||
		(!base.analysis && Boolean(draft.title.trim()))
	);
}

export function sourceChanged(
	base: AnalysisEditorBase,
	sourceMd: string,
): boolean {
	return (
		sourceMd.normalize("NFC") !==
		(base.analysis?.source_md ?? "").normalize("NFC")
	);
}

/** A pending request wins over new input; retries never mint another identity. */
export function prepareAnalysisRequest(
	pending: ManualAnalysisRequest | null,
	base: AnalysisEditorBase,
	draft: AnalysisDraft,
	newRequestId: () => string,
): ManualAnalysisRequest {
	if (pending) return pending;
	const invalid =
		sourceError(draft.sourceMd) || (!base.analysis && titleError(draft.title));
	if (invalid) throw new Error(invalid);
	if (base.analysis) {
		if (base.analysis.segment_id !== base.segment.id)
			throw new Error("讲解不属于当前片段。");
		if (base.analysis.revision_id !== base.analysis.current_revision_id)
			throw new Error("历史版本只读，请打开当前版本后编辑。");
		if (!sourceChanged(base, draft.sourceMd)) throw new Error("正文没有变化。");
	}
	const common = {
		request_id: newRequestId(),
		expected_text_sha256: base.segment.text_sha256,
		source_md: draft.sourceMd.normalize("NFC"),
	};
	return base.analysis
		? Object.freeze({
				kind: "revision",
				analysisId: base.analysis.id,
				body: Object.freeze({
					...common,
					base_revision_id: base.analysis.revision_id,
				}),
			})
		: Object.freeze({
				kind: "create",
				segmentId: base.segment.id,
				body: Object.freeze({
					...common,
					origin: "manual",
					title: draft.title.normalize("NFC").trim() || null,
				}),
			});
}

export class AnalysisWriteError extends Error {
	readonly status: number;
	readonly code: WriteErrorCode | undefined;
	constructor(message: string, status: number, code?: WriteErrorCode) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function analysisWriteError(
	error: unknown,
	status: number,
): AnalysisWriteError {
	const body = error && typeof error === "object" ? error : {};
	const codes: readonly WriteErrorCode[] = [
		"not_found",
		"stale_text",
		"stale_revision",
		"idempotency_conflict",
		"no_changes",
	];
	const code =
		"code" in body && codes.includes(body.code as WriteErrorCode)
			? (body.code as WriteErrorCode)
			: undefined;
	const detail =
		"detail" in body && typeof body.detail === "string" ? body.detail : null;
	return new AnalysisWriteError(
		detail ??
			(status === 422
				? "输入未通过验证，请检查正文和标题长度。"
				: status === 404
					? "片段或讲解已不可用。"
					: status >= 400 && status < 500 && status !== 408
						? "保存未被接受，请检查后重试。"
						: "未能确认保存结果，请核实本次保存。"),
		status,
		code,
	);
}

export function analysisFailure(
	error: unknown,
): WriteErrorCode | "rejected" | "uncertain" {
	const status =
		error && typeof error === "object" && "status" in error
			? error.status
			: undefined;
	if (
		typeof status !== "number" ||
		status < 400 ||
		status === 408 ||
		status >= 500
	)
		return "uncertain";
	return error instanceof AnalysisWriteError && error.code
		? error.code
		: "rejected";
}

export function requestAfterFailure(
	request: ManualAnalysisRequest,
	error: unknown,
): ManualAnalysisRequest | null {
	return analysisFailure(error) === "uncertain" ? request : null;
}

export function savedAnalysisLocation(
	result: Pick<Analysis, "id" | "revision_id" | "current_revision_id">,
) {
	return { analysisId: result.id, revisionId: result.revision_id };
}
