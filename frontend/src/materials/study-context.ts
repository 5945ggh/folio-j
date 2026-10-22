import type { components } from "../api/schema";
import type { Chapter } from "./api";

type MaterialProvenance = components["schemas"]["MaterialProvenance"];

export type ContextBudget = Pick<
	components["schemas"]["SegmentContextSettingsResponse"],
	| "enabled"
	| "before_sentences"
	| "after_sentences"
	| "before_characters"
	| "after_characters"
>;

export class ContextPrefillError extends Error {
	readonly code:
		| "invalid_budget"
		| "invalid_reference"
		| "invalid_chapter"
		| "unsafe_normalization";

	constructor(code: ContextPrefillError["code"], message: string) {
		super(message);
		this.name = "ContextPrefillError";
		this.code = code;
	}
}

const sentenceEnds = new Set(Array.from("。！？!?"));
const sentenceClosers = new Set(Array.from("」』）)]】〉》”’"));
const whitespace = /\p{White_Space}/u;
const hasContent = (text: string) => /\P{White_Space}/u.test(text);

/** context-sentences-v1: punctuation/LF boundaries retain all adjacent whitespace. */
export function splitContextSentences(text: string): string[] {
	const points = Array.from(text.normalize("NFC"));
	const sentences: string[] = [];
	let start = 0;
	let cursor = 0;
	let content = false;
	while (cursor < points.length) {
		const point = points[cursor] ?? "";
		if (sentenceEnds.has(point) || (point === "\n" && content)) {
			if (sentenceEnds.has(point)) {
				cursor++;
				while (
					cursor < points.length &&
					(sentenceEnds.has(points[cursor] ?? "") ||
						sentenceClosers.has(points[cursor] ?? ""))
				) {
					cursor++;
				}
			}
			while (cursor < points.length && whitespace.test(points[cursor] ?? "")) {
				cursor++;
			}
			sentences.push(points.slice(start, cursor).join(""));
			start = cursor;
			content = false;
		} else {
			if (!whitespace.test(point)) content = true;
			cursor++;
		}
	}
	if (content) sentences.push(points.slice(start).join(""));
	return sentences;
}

function validateBudget(budget: ContextBudget): void {
	if (
		typeof budget.enabled !== "boolean" ||
		[
			budget.before_sentences,
			budget.after_sentences,
			budget.before_characters,
			budget.after_characters,
		].some((value) => !Number.isInteger(value) || value < 0 || value > 100000)
	) {
		throw new ContextPrefillError(
			"invalid_budget",
			"语境预算须为 0–100000 的整数",
		);
	}
}

/** Map resource-local codepoints before NFC can combine across resource seams. */
function chapterTarget(chapter: Chapter, reference: MaterialProvenance) {
	if (
		reference.contract_version !== "1" ||
		reference.material_id !== chapter.material_id ||
		reference.version_id !== chapter.version_id ||
		!reference.ranges.length
	) {
		throw new ContextPrefillError(
			"invalid_reference",
			"目标材料或版本与章节不一致",
		);
	}
	const resources = new Map<
		string,
		Chapter["resources"][number] & { points: string[] }
	>();
	for (const resource of chapter.resources) {
		const previous = resources.get(resource.id);
		if (
			resource.text.normalize("NFC") !== resource.text ||
			(previous &&
				(previous.text !== resource.text ||
					previous.text_sha256 !== resource.text_sha256))
		) {
			throw new ContextPrefillError(
				"invalid_chapter",
				"章节资源正文身份不一致",
			);
		}
		resources.set(resource.id, {
			...resource,
			points: Array.from(resource.text),
		});
	}
	let offset = 0;
	const parts = chapter.parts.map((part) => {
		const resource = resources.get(part.resource_id);
		const points = resource?.points ?? [];
		if (
			!resource ||
			![part.start, part.end, part.spine_index].every(Number.isSafeInteger) ||
			part.start < 0 ||
			part.end < part.start ||
			part.end > points.length ||
			part.spine_index < 0
		) {
			throw new ContextPrefillError("invalid_chapter", "章节 part 范围不可用");
		}
		const positioned = {
			...part,
			offset,
			text: points.slice(part.start, part.end).join(""),
		};
		offset += part.end - part.start;
		return positioned;
	});
	let start: number | undefined;
	let end: number | undefined;
	for (const range of reference.ranges) {
		const resource = resources.get(range.resource_id);
		if (
			!resource ||
			![range.start, range.end, range.spine_index].every(
				Number.isSafeInteger,
			) ||
			range.start < 0 ||
			range.end <= range.start ||
			range.spine_index < 0 ||
			range.text_sha256 !== resource.text_sha256 ||
			resource.points.slice(range.start, range.end).join("") !== range.exact ||
			range.end > resource.points.length
		) {
			throw new ContextPrefillError(
				"invalid_reference",
				"目标原文与章节资源不一致",
			);
		}
		let cursor = range.start;
		let rangeEnd: number | undefined;
		let rangeStart: number | undefined;
		for (const part of parts) {
			if (
				part.resource_id !== range.resource_id ||
				part.spine_index !== range.spine_index
			) {
				continue;
			}
			const left = Math.max(part.start, range.start);
			const right = Math.min(part.end, range.end);
			if (left >= right) continue;
			const position = part.offset + left - part.start;
			if (
				left !== cursor ||
				(rangeEnd !== undefined && rangeEnd !== position)
			) {
				throw new ContextPrefillError(
					"invalid_reference",
					"目标出现位置重复或不连续",
				);
			}
			rangeStart ??= position;
			rangeEnd = part.offset + right - part.start;
			cursor = right;
		}
		if (
			cursor !== range.end ||
			rangeStart === undefined ||
			rangeEnd === undefined ||
			(end !== undefined && end !== rangeStart)
		) {
			throw new ContextPrefillError(
				"invalid_reference",
				"目标未完整且连续地位于本章",
			);
		}
		start ??= rangeStart;
		end = rangeEnd;
	}
	if (start === undefined || end === undefined) {
		throw new ContextPrefillError("invalid_reference", "目标范围为空");
	}
	const raw = parts.map((part) => part.text).join("");
	const points = Array.from(raw);
	const before = points.slice(0, start).join("").normalize("NFC");
	const selected = points.slice(start, end).join("").normalize("NFC");
	const after = points.slice(end).join("").normalize("NFC");
	if (before + selected + after !== raw.normalize("NFC")) {
		throw new ContextPrefillError(
			"unsafe_normalization",
			"目标边界跨越 Unicode 组合字符，无法安全预装语境",
		);
	}
	if (!hasContent(selected)) {
		throw new ContextPrefillError("invalid_reference", "目标原文为空白");
	}
	return {
		text: before + selected + after,
		start: Array.from(before).length,
		end: Array.from(before + selected).length,
	};
}

function tidyContextCopy(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (hasContent(line) ? line : ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
		.normalize("NFC");
}

function takeSide(
	candidates: string[],
	sentenceLimit: number,
	characterLimit: number,
	before: boolean,
) {
	if (!sentenceLimit || !characterLimit) return { text: "", truncated: false };
	const near = before ? [...candidates].reverse() : [...candidates];
	const selected: string[] = [];
	let count = 0;
	for (const candidate of near) {
		if (count >= sentenceLimit) break;
		selected.push(candidate);
		if (hasContent(candidate)) count++;
	}
	// Tidying the combined copy once is equivalent to extending it near-first,
	// and keeps long chapters from repeatedly scanning every accepted sentence.
	const copy = tidyContextCopy(
		(before ? [...selected].reverse() : selected).join(""),
	);
	const points = Array.from(copy);
	if (points.length <= characterLimit) return { text: copy, truncated: false };
	const text = tidyContextCopy(
		(before
			? points.slice(-characterLimit)
			: points.slice(0, characterLimit)
		).join(""),
	);
	// Whitespace at a sentence boundary can exhaust the budget without cutting
	// any sentence content. Only a partially kept content-bearing sentence counts.
	let kept = Array.from(text).filter(hasContent).length;
	for (const candidate of selected) {
		const content = Array.from(candidate).filter(hasContent).length;
		if (kept < content) return { text, truncated: kept > 0 };
		kept -= content;
	}
	return { text, truncated: false };
}

/** Pure local prefill. Errors leave the caller's target and editable draft untouched. */
export function prefillContext(
	chapter: Chapter,
	reference: MaterialProvenance,
	budget: ContextBudget,
): {
	before: string;
	after: string;
	beforeTruncated: boolean;
	afterTruncated: boolean;
} {
	validateBudget(budget);
	if (!budget.enabled) {
		return {
			before: "",
			after: "",
			beforeTruncated: false,
			afterTruncated: false,
		};
	}
	const target = chapterTarget(chapter, reference);
	let offset = 0;
	const before: string[] = [];
	const after: string[] = [];
	for (const sentence of splitContextSentences(target.text)) {
		const points = Array.from(sentence);
		const end = offset + points.length;
		if (offset < target.start) {
			before.push(
				points.slice(0, Math.min(target.start, end) - offset).join(""),
			);
		}
		if (end > target.end) {
			after.push(points.slice(Math.max(target.end - offset, 0)).join(""));
		}
		offset = end;
	}
	const left = takeSide(
		before,
		budget.before_sentences,
		budget.before_characters,
		true,
	);
	const right = takeSide(
		after,
		budget.after_sentences,
		budget.after_characters,
		false,
	);
	return {
		before: left.text,
		after: right.text,
		beforeTruncated: left.truncated,
		afterTruncated: right.truncated,
	};
}
