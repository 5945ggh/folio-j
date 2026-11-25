import type { components } from "../api/schema";
import type { Chapter } from "../materials/api";
import { recordReferencesOverlap } from "../materials/chapter-records.ts";
import { rubyBoundaries } from "../materials/ruby.ts";
import {
	ContextPrefillError,
	chapterTarget,
	splitContextSentences,
} from "../materials/study-context.ts";

type MaterialProvenance = components["schemas"]["MaterialProvenance"];
type DictionaryMatch = components["schemas"]["DictionaryMatch"];

export type AnkiContextOrigin =
	| "selection"
	| "dictionary"
	| "translation"
	| "segment";

export type AnkiDictionarySeed = {
	surface: string;
	term: string;
	reading: string;
	entries: readonly DictionaryMatch[];
	dictionaryTitle?: string;
	partOfSpeech?: string;
};

export type AnkiSentenceRuby = components["schemas"]["AnkiSentenceRuby"];
export type AnkiSentenceFocus = components["schemas"]["AnkiSentenceFocus"];

export type AnkiSentenceSource = {
	sentence: string;
	original: string;
	chapter: Chapter;
	parts: { part: Chapter["parts"][number]; text: string; start: number }[];
	focus?: AnkiSentenceFocus;
};

export type AnkiMaterialContext = {
	/** Stable session identity for isolating stale async responses. */
	key: string;
	origin: AnkiContextOrigin;
	selection: string;
	sentence: string;
	sentenceFocus?: AnkiSentenceFocus;
	sentenceRuby?: readonly AnkiSentenceRuby[];
	sentenceRubyPending?: boolean;
	sourceMetadata: string;
	reference: MaterialProvenance | null;
	dictionarySeed?: AnkiDictionarySeed;
	/** Initial segment or translation highlighted when launched from a record view. */
	initialSegmentId?: string;
	initialTranslation?: components["schemas"]["TranslationResultResponse"];
	/** Snapshot of the lookup input for on-demand dictionary lookup inside the composer. */
	lookupInput?: {
		text: string;
		position?: number;
		selection_start?: number;
		selection_end?: number;
	};
};

function normalizeSentence(text: string): string {
	return text.replace(/\r\n/g, "\n").normalize("NFC");
}

function tidySentence(text: string): string {
	return normalizeSentence(
		text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""),
	);
}

/** Map the verified raw span through the same whitespace and NFC rules as the sentence. */
function sentenceFocus(
	original: string,
	sentence: string,
	start: number,
	end: number,
	selection: string,
): AnkiSentenceFocus | undefined {
	const raw = original.slice(
		Math.max(0, start),
		Math.min(end, original.length),
	);
	const leadingTrimmed = raw.replace(/^\p{White_Space}+/u, "");
	const content = leadingTrimmed.replace(/\p{White_Space}+$/u, "");
	const left = Math.max(0, start) + raw.length - leadingTrimmed.length;
	const text = normalizeSentence(content);
	if (!text || text === sentence || text !== tidySentence(selection)) return;
	const before = normalizeSentence(original.slice(0, left));
	const after = normalizeSentence(original.slice(left + content.length));
	if (before + text + after !== sentence) return;
	const startPoint = Array.from(before).length;
	return {
		start: startPoint,
		end: startPoint + Array.from(text).length,
		text,
	};
}

/**
 * Join non-empty parts with " · ", deduplicating adjacent identical segments
 * after whitespace trimming and NFC normalization.
 */
export function formatSourceMetadata(
	parts: readonly (string | null | undefined)[],
): string {
	const result: string[] = [];
	for (const raw of parts) {
		const cleaned = (raw ?? "").trim().normalize("NFC");
		if (!cleaned) continue;
		if (result.at(-1) === cleaned) continue;
		result.push(cleaned);
	}
	return result.join(" · ");
}

/**
 * Expand a verified provenance selection to the full enclosing sentence(s)
 * within the same chapter using the reader's shared sentence splitter.
 * Falls back to the verified selection text when expansion cannot be verified.
 */
export function extractExpandedSentence(
	chapter: Chapter | null | undefined,
	reference: MaterialProvenance | null | undefined,
	fallbackSelection: string,
): string {
	return (
		expandedSentenceSource(chapter, reference)?.sentence ??
		tidySentence(fallbackSelection)
	);
}

/** Resolve the original sentence occurrence and retain the participating part ranges. */
export function expandedSentenceSource(
	chapter: Chapter | null | undefined,
	reference: MaterialProvenance | null | undefined,
	focusSelection?: string,
): AnkiSentenceSource | null {
	if (!chapter || !reference) return null;
	let target: ReturnType<typeof chapterTarget>;
	try {
		target = chapterTarget(chapter, reference);
	} catch (error) {
		if (error instanceof ContextPrefillError) return null;
		throw error;
	}
	let point = 0;
	let start: number | undefined;
	let end: number | undefined;
	for (const sentence of splitContextSentences(target.text)) {
		const next = point + Array.from(sentence).length;
		if (point < target.end && next > target.start) {
			start ??= point;
			end = next;
		}
		point = next;
	}
	if (start === undefined || end === undefined) return null;

	const boundaries = rubyBoundaries(target.raw);
	const rawStart = boundaries[start];
	const rawEnd = boundaries[end];
	if (rawStart === undefined || rawEnd === undefined) return null;
	const raw = target.raw.slice(rawStart, rawEnd);
	const trimmedStart = raw.replace(/^\p{White_Space}+/u, "");
	const original = trimmedStart.replace(/\p{White_Space}+$/u, "");
	if (!original) return null;
	const origin = rawStart + raw.length - trimmedStart.length;
	const limit = origin + original.length;

	const parts: AnkiSentenceSource["parts"] = [];
	let offset = 0;
	for (const part of target.parts) {
		const partStart = offset;
		offset += part.text.length;
		if (partStart < limit && offset > origin)
			parts.push({ part, text: part.text, start: partStart - origin });
	}
	const sentence = normalizeSentence(original);
	const focusStart = boundaries[target.start];
	const focusEnd = boundaries[target.end];
	const focus =
		focusSelection !== undefined &&
		focusStart !== undefined &&
		focusEnd !== undefined
			? sentenceFocus(
					original,
					sentence,
					focusStart - origin,
					focusEnd - origin,
					focusSelection,
				)
			: undefined;
	return { chapter, sentence, original, parts, focus };
}

/**
 * Find records sharing at least one verified codepoint with the frozen original
 * selection. Never expands via sentence context or transitive overlap.
 */
export function intersectingRecords<
	S extends { material_provenance: MaterialProvenance },
	T extends { material_provenance: MaterialProvenance },
>(
	reference: MaterialProvenance | null,
	segments: readonly S[],
	translations: readonly T[],
): { segments: S[]; translations: T[] } {
	if (!reference) return { segments: [], translations: [] };
	return {
		segments: segments.filter((item) =>
			recordReferencesOverlap(reference, item.material_provenance),
		),
		translations: translations.filter((item) =>
			recordReferencesOverlap(reference, item.material_provenance),
		),
	};
}

/** Flatten a DictionaryMatch definition tree into readable plain text lines. */
export function flattenDictionaryNodes(
	nodes: readonly components["schemas"]["DictionaryNode"][],
): string {
	const parts: string[] = [];
	for (const node of nodes) {
		const tag = node.tag ?? "";
		if (tag === "br") {
			parts.push("\n");
			continue;
		}
		const block = ["div", "p", "li", "tr", "ul", "ol"].includes(tag);
		const text = node.text ?? "";
		const children = node.content ? flattenDictionaryNodes(node.content) : "";
		const combined = `${text}${children}`;
		if (!combined) continue;
		if (block && parts.length > 0 && !parts.at(-1)?.endsWith("\n")) {
			parts.push("\n");
		}
		parts.push(combined);
		if (block && !combined.endsWith("\n")) {
			parts.push("\n");
		}
	}
	return parts
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Extract top-level sense items from a dictionary entry when structured as list items
 * or multiple top-level definition blocks, for one-click adoption into a card field.
 */
export function dictionarySenseTexts(entry: DictionaryMatch) {
	type Node = DictionaryMatch["definitions"][number];
	const senses = new Map<Node, string>();
	const seen = new Set<string>();
	const visit = (node: Node) => {
		const children = node.content ?? [];
		const list = node.tag === "ol" || node.tag === "ul";
		if (
			node.tag !== "li" &&
			((list && children.some((child) => child.tag === "li")) ||
				children.some((child) => child.tag === "ol" || child.tag === "ul"))
		) {
			for (const child of children) visit(child);
			return;
		}
		const text = flattenDictionaryNodes([node]).replace(/\s+\n/g, "\n").trim();
		if (text && !seen.has(text)) {
			seen.add(text);
			senses.set(node, text);
		}
	};
	for (const node of entry.definitions) visit(node);
	if (!senses.size) {
		const root = entry.definitions.find((node) => node.tag !== "br");
		const text = flattenDictionaryNodes(entry.definitions);
		if (root && text) senses.set(root, text);
	}
	return senses;
}
