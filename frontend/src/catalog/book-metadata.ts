import type { components } from "../api/schema";

type MetadataUpdate = components["schemas"]["MaterialMetadataUpdate"];

export const MAX_COVER_BYTES = 4 * 1024 * 1024;
export type CoverIntent = "keep" | "replace" | "reset";
export function normalizedBookTitle(title: string): string {
	return title.normalize("NFC").trim();
}
export function bookTitleError(title: string): string | null {
	const length = Array.from(normalizedBookTitle(title)).length;
	return length < 1 || length > 300 ? "书名须为 1–300 个字符。" : null;
}
export function coverFileError(type: string, size: number): string | null {
	if (type !== "image/png" && type !== "image/jpeg")
		return "请选择 PNG 或 JPEG 图片。";
	if (size > MAX_COVER_BYTES) return "封面不能超过 4 MiB。";
	if (!size) return "图片文件为空，请重新选择。";
	return null;
}
export function metadataDraftChanged(
	originalTitle: string,
	title: string,
	coverAction: CoverIntent,
): boolean {
	return title !== originalTitle || coverAction !== "keep";
}

export function bookMetadataUpdate(
	title: string,
	revision: number,
	coverAction: CoverIntent,
	cover?: MetadataUpdate["cover"],
): MetadataUpdate {
	const error = bookTitleError(title);
	if (error) throw new Error(error);
	if (coverAction === "replace" && !cover)
		throw new Error("请先选择有效封面。");
	return {
		title: normalizedBookTitle(title),
		expected_revision: revision,
		cover_action: coverAction,
		...(coverAction === "replace" ? { cover } : {}),
	};
}
