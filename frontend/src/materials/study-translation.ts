import type { TranslationResult } from "../translation/api.ts";
import type { ChapterTranslation } from "./chapter-translations-query.ts";
import type { MaterialProvenance } from "./study-api.ts";

/** Trim only the whole target's Unicode whitespace, retaining its exact occurrence. */
export function translationReferenceKey(
	reference: MaterialProvenance,
): string | null {
	const pieces = reference.ranges.map((range) => Array.from(range.exact));
	if (
		pieces.some(
			(points, index) =>
				points.length !==
				(reference.ranges[index]?.end ?? 0) -
					(reference.ranges[index]?.start ?? 0),
		)
	)
		return null;
	const points = pieces.flat();
	let start = 0;
	let end = points.length;
	while (start < end && /\p{White_Space}/u.test(points[start] ?? "")) start++;
	while (end > start && /\p{White_Space}/u.test(points[end - 1] ?? "")) end--;
	if (start === end) return null;
	const ranges: MaterialProvenance["ranges"] = [];
	let offset = 0;
	for (const [index, range] of reference.ranges.entries()) {
		const text = pieces[index] ?? [];
		const left = Math.max(0, start - offset);
		const right = Math.min(text.length, end - offset);
		offset += text.length;
		if (left >= right) continue;
		const next = {
			...range,
			start: range.start + left,
			end: range.start + right,
			exact: text.slice(left, right).join(""),
		};
		const previous = ranges.at(-1);
		if (
			previous &&
			previous.resource_id === next.resource_id &&
			previous.spine_index === next.spine_index &&
			previous.text_sha256 === next.text_sha256 &&
			previous.end === next.start
		) {
			previous.end = next.end;
			previous.exact += next.exact;
		} else ranges.push(next);
	}
	return JSON.stringify([
		reference.contract_version,
		reference.material_id,
		reference.version_id,
		ranges.map((range) => [
			range.resource_id,
			range.spine_index,
			range.start,
			range.end,
			range.text_sha256,
			range.exact,
		]),
	]);
}

export function matchingStudyTranslation(
	reference: MaterialProvenance,
	latest: readonly ChapterTranslation[],
	preferred: readonly TranslationResult[],
): string | null {
	const key = translationReferenceKey(reference);
	if (!key) return null;
	const selected = [...preferred]
		.reverse()
		.find(
			(result) =>
				!result.material_deleted &&
				!result.reader_deleted &&
				translationReferenceKey(result.material_provenance) === key,
		);
	if (selected) return selected.id;
	return (
		[...latest]
			.filter(
				(item) => translationReferenceKey(item.material_provenance) === key,
			)
			.sort(
				(left, right) =>
					right.created_at.localeCompare(left.created_at) ||
					right.result_id.localeCompare(left.result_id),
			)[0]?.result_id ?? null
	);
}
