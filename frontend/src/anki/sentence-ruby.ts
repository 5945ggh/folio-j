import type { ReadingsResponse } from "../materials/api";
import { type Projection, projectPart } from "../materials/dom.ts";
import { applyAutomaticRuby, rubyBoundaries } from "../materials/ruby.ts";
import type { AnkiSentenceRuby, AnkiSentenceSource } from "./context.ts";

function rubySpans(projection: Projection): AnkiSentenceRuby[] {
	const bases = new Map<Element, Projection["entries"]>();
	for (const entry of projection.entries) {
		const ruby = entry.node.parentElement?.closest("ruby");
		if (!ruby) continue;
		const entries = bases.get(ruby);
		if (entries) entries.push(entry);
		else bases.set(ruby, [entry]);
	}

	const spans: AnkiSentenceRuby[] = [];
	for (const [ruby, entries] of bases) {
		const annotations = [...ruby.querySelectorAll("rt")].filter(
			(rt) => rt.closest("ruby") === ruby,
		);
		// Explicit rb groups can precede consecutive rt nodes. Otherwise a ruby
		// pairs each annotation with the bases since the previous annotation.
		const groups = [...ruby.children].filter(
			(child) => child.localName === "rb",
		);
		const explicit = groups.length > 1 && groups.length === annotations.length;
		let last = 0;
		for (const [index, rt] of annotations.entries()) {
			const group = explicit ? groups[index] : undefined;
			let groupEntries: Projection["entries"];
			if (group) {
				groupEntries = entries.filter((entry) => group.contains(entry.node));
			} else {
				const first = last;
				while (
					(entries[last]?.node.compareDocumentPosition(rt) ?? 0) &
					Node.DOCUMENT_POSITION_FOLLOWING
				)
					last++;
				groupEntries = entries.slice(first, last);
			}
			const begin = groupEntries[0];
			const end = groupEntries.at(-1);
			const reading = rt.textContent.trim().normalize("NFC");
			const contiguous = groupEntries.every(
				(entry, index) =>
					!index || groupEntries[index - 1]?.end === entry.start,
			);
			if (
				begin &&
				end &&
				contiguous &&
				reading &&
				!/[\r\n]/u.test(reading) &&
				Array.from(reading).length <= 32_768
			)
				spans.push({ start: begin.start, end: end.end, reading });
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

/** Read the same full-ruby projection as the reader, independent of its display preferences. */
export function originalSentenceRuby(
	source: AnkiSentenceSource,
	readings: ReadingsResponse | undefined,
	generation: string,
	owner: Document,
): AnkiSentenceRuby[] {
	const chapter = source.chapter;
	const sentenceLength = source.original.length;
	const assets =
		readings?.material_id === chapter.material_id &&
		readings.version_id === chapter.version_id &&
		readings.generation_id === generation
			? readings.resources
			: [];
	const document = owner.implementation.createHTMLDocument();
	const template = document.createElement("template");
	const offsets = new Map<number, number>();
	const normalized = Array.from(source.original.normalize("NFC"));
	let crlf = 0;
	for (const [point, raw] of rubyBoundaries(source.original).entries()) {
		if (raw !== undefined) offsets.set(raw, point - crlf);
		if (normalized[point] === "\r" && normalized[point + 1] === "\n") crlf++;
	}

	const result: AnkiSentenceRuby[] = [];
	for (const { part, text, start: partStart } of source.parts) {
		const resource = chapter.resources.find(
			(value) => value.id === part.resource_id,
		);
		const asset = assets.find(
			(item) =>
				item.resource_id === part.resource_id &&
				item.text_sha256 === resource?.text_sha256,
		);
		template.innerHTML = part.html;
		document.body.replaceChildren(template.content);
		let projection: Projection;
		try {
			projection = projectPart(document, text, part.leaf_start);
		} catch {
			continue;
		}
		if (asset) {
			const begin =
				part.start + Array.from(text.slice(0, Math.max(0, -partStart))).length;
			const finish =
				part.start +
				Array.from(text.slice(0, sentenceLength - partStart)).length;
			const tokens = asset.tokens.filter(
				(item) => item.start < finish && item.end > begin,
			);
			if (tokens.length) {
				applyAutomaticRuby(document, projection, tokens, part.start);
				projection = projectPart(document, text, part.leaf_start);
			}
		}
		// Locator projections use unnormalized text node coordinates. Normalize
		// the part boundary exactly as the chapter compiler does before mapping it.
		const partOffsets = new Map(
			rubyBoundaries(projection.raw).flatMap((raw, point) =>
				raw === undefined ? [] : [[raw, point] as const],
			),
		);
		const canonicalOffsets = [0];
		for (const character of text)
			canonicalOffsets.push((canonicalOffsets.at(-1) ?? 0) + character.length);
		for (const span of rubySpans(projection)) {
			const raw = projection.raw.slice(span.start, span.end);
			const trimmedStart = raw.trimStart();
			const base = trimmedStart.trimEnd();
			if (!base || /[\r\n]/u.test(base)) continue;
			const baseStart = span.end - trimmedStart.length;
			const baseEnd = baseStart + base.length;
			const begin = canonicalOffsets[partOffsets.get(baseStart) ?? -1];
			const finish = canonicalOffsets[partOffsets.get(baseEnd) ?? -1];
			if (begin === undefined || finish === undefined) continue;
			const start = offsets.get(partStart + begin);
			const end = offsets.get(partStart + finish);
			if (
				start !== undefined &&
				end !== undefined &&
				end > start &&
				start >= (result.at(-1)?.end ?? 0)
			)
				result.push({ start, end, reading: span.reading });
		}
	}
	return result;
}
