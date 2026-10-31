import type { MaterialProvenance } from "./study-api.ts";

type LocatedRecord = { material_provenance: MaterialProvenance };
type RecordHit = {
	segmentIds: string[];
	translationIds?: string[];
	fixed?: boolean;
	anchorPlacement?: string;
};

export type MarginRecordEntry =
	| { kind: "segment" | "translation"; id: string }
	| { kind: "list"; tab: "segment" | "translation" };

function isMarginHit(hit: RecordHit) {
	return !hit.fixed && hit.anchorPlacement?.startsWith("margin-") === true;
}

/** Use the clicked margin's identities before overlap expansion selects its full record group. */
export function marginRecordEntry(
	hit: RecordHit | null,
): MarginRecordEntry | undefined {
	if (!hit || !isMarginHit(hit)) return undefined;
	const { segmentIds, translationIds = [] } = hit;
	const count = segmentIds.length + translationIds.length;
	if (!count) return undefined;
	if (count > 1)
		return {
			kind: "list",
			tab: segmentIds.length ? "segment" : "translation",
		};
	const segmentId = segmentIds[0];
	if (segmentId) return { kind: "segment", id: segmentId };
	const translationId = translationIds[0];
	return translationId ? { kind: "translation", id: translationId } : undefined;
}

/** A text hit with the same record IDs switches to the margin entry instead of toggling it closed. */
export function sameMarginRecordHit(a: RecordHit, b: RecordHit): boolean {
	return isMarginHit(a) && sameRecordHit(a, b);
}

/** Ambiguous or mixed records keep the existing chooser; only a direct translation is inline. */
export function inlineTranslationAtHit<
	S extends LocatedRecord & { segment_id: string },
	T extends LocatedRecord & { identity_sha256: string },
>(
	segments: readonly S[],
	translations: readonly T[],
	hit: RecordHit,
	direction: "horizontal-tb" | "vertical-rl",
): T | null {
	if (
		direction !== "horizontal-tb" ||
		hit.fixed ||
		(hit.anchorPlacement && hit.anchorPlacement !== "text")
	)
		return null;
	const records = recordsAtHit(segments, translations, hit);
	return !records.segments.length && records.translations.length === 1
		? (records.translations[0] ?? null)
		: null;
}

export function sameRecordHit(a: RecordHit, b: RecordHit): boolean {
	return ["segmentIds", "translationIds"].every((field) => {
		const key = field as "segmentIds" | "translationIds";
		const left = a[key] ?? [],
			right = b[key] ?? [];
		return (
			left.length === right.length && left.every((id) => right.includes(id))
		);
	});
}

export function recordReferencesOverlap(
	a: MaterialProvenance,
	b: MaterialProvenance,
): boolean {
	return (
		a.material_id === b.material_id &&
		a.version_id === b.version_id &&
		a.ranges.some((left) =>
			b.ranges.some(
				(right) =>
					left.resource_id === right.resource_id &&
					left.spine_index === right.spine_index &&
					left.start < right.end &&
					right.start < left.end,
			),
		)
	);
}

/** A connected overlap is one entry, including clicks on either end of a partial overlap. */
export function recordsAtHit<
	S extends LocatedRecord & { segment_id: string },
	T extends LocatedRecord & { identity_sha256: string },
>(
	segments: readonly S[],
	translations: readonly T[],
	hit: RecordHit | null,
): { segments: readonly S[]; translations: readonly T[] } {
	if (!hit) return { segments: [], translations: [] };
	if (hit.fixed) return { segments, translations };
	const segmentIds = new Set(hit.segmentIds),
		translationIds = new Set(hit.translationIds ?? []);
	const selected: LocatedRecord[] = [
		...segments.filter((item) => segmentIds.has(item.segment_id)),
		...translations.filter((item) => translationIds.has(item.identity_sha256)),
	];
	for (let index = 0; index < selected.length; index++) {
		const reference = selected[index]?.material_provenance;
		if (!reference) continue;
		for (const item of segments)
			if (
				!segmentIds.has(item.segment_id) &&
				recordReferencesOverlap(reference, item.material_provenance)
			) {
				segmentIds.add(item.segment_id);
				selected.push(item);
			}
		for (const item of translations)
			if (
				!translationIds.has(item.identity_sha256) &&
				recordReferencesOverlap(reference, item.material_provenance)
			) {
				translationIds.add(item.identity_sha256);
				selected.push(item);
			}
	}
	return {
		segments: segments.filter((item) => segmentIds.has(item.segment_id)),
		translations: translations.filter((item) =>
			translationIds.has(item.identity_sha256),
		),
	};
}

export function completeChapterTranslations<
	T extends { identity_sha256: string },
>(pages: { items: T[]; next_cursor: string | null }[] | undefined): T[] {
	if (!pages?.length || pages.at(-1)?.next_cursor !== null) return [];
	return [
		...new Map(
			pages.flatMap((page) =>
				page.items.map((item) => [item.identity_sha256, item] as const),
			),
		).values(),
	];
}
