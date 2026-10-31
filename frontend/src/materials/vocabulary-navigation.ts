import type { components } from "../api/schema";
import type { Chapter, Material, Position, Settings } from "./api.ts";
import { referenceParts } from "./reader-selection.ts";

type NavigationItem = components["schemas"]["MaterialVocabularyOccurrence"];
export type VocabularyReaderTarget = {
	material_id: string;
	version_id: string;
	chapter_id: string;
	part_index: number;
	spine_index: number;
	resource_id: string;
	start: number;
	end: number;
	exact: string;
	text_sha256: string;
};
const PARAM = "vocabulary";
const failure = () =>
	new Error("词汇原文位置已失效或无法校验，请返回词汇页重新选择。");
function valid(value: unknown): value is VocabularyReaderTarget {
	if (!value || typeof value !== "object") return false;
	const target = value as Record<string, unknown>;
	for (const key of [
		"material_id",
		"version_id",
		"chapter_id",
		"resource_id",
		"exact",
		"text_sha256",
	])
		if (typeof target[key] !== "string" || !target[key]) return false;
	for (const key of ["part_index", "spine_index", "start", "end"])
		if (!Number.isSafeInteger(target[key]) || (target[key] as number) < 0)
			return false;
	return (
		(target.end as number) > (target.start as number) &&
		Array.from(target.exact as string).length ===
			(target.end as number) - (target.start as number)
	);
}
/** A temporary URL reference; this creates no learning content or stored occurrence. */
export function vocabularyReaderHref(
	materialId: string,
	versionId: string,
	item: NavigationItem,
): string | null {
	const target = {
		material_id: materialId,
		version_id: versionId,
		chapter_id: item.chapter_id,
		part_index: item.part_index,
		spine_index: item.spine_index,
		resource_id: item.resource_id,
		start: item.start,
		end: item.end,
		exact: item.match,
		text_sha256: item.text_sha256,
	};
	if (!valid(target)) return null;
	return `/materials/${encodeURIComponent(materialId)}?${new URLSearchParams({ [PARAM]: JSON.stringify(target) })}`;
}
/** A present but malformed target must fail, never fall back to ordinary resume. */
export function readVocabularyReaderTarget(
	search: string,
): VocabularyReaderTarget | null {
	const params = new URLSearchParams(search);
	if (!params.has(PARAM)) return null;
	if (params.getAll(PARAM).length !== 1 || params.has("segment"))
		throw failure();
	try {
		const value: unknown = JSON.parse(params.get(PARAM) ?? "");
		if (!valid(value)) throw failure();
		return value;
	} catch {
		throw failure();
	}
}
export function validateVocabularyReaderTarget(
	target: VocabularyReaderTarget,
	book: Pick<Material, "id" | "version_id">,
	chapter: Chapter,
): void {
	if (
		target.material_id !== book.id ||
		target.version_id !== book.version_id ||
		chapter.material_id !== book.id ||
		chapter.version_id !== book.version_id ||
		chapter.id !== target.chapter_id
	)
		throw failure();
	const part = chapter.parts[target.part_index];
	if (
		!part ||
		part.resource_id !== target.resource_id ||
		part.spine_index !== target.spine_index ||
		target.start < part.start ||
		target.start >= part.end
	)
		throw failure();
	try {
		referenceParts(chapter, [target]);
	} catch {
		throw failure();
	}
}
export function vocabularyReaderPosition(
	target: VocabularyReaderTarget,
	settings: Settings,
): Position {
	return {
		version_id: target.version_id,
		chapter_id: target.chapter_id,
		part_index: target.part_index,
		resource_id: target.resource_id,
		kind: "text",
		offset: target.start,
		at_chapter_end: false,
		settings,
	};
}
