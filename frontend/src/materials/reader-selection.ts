import type { Chapter } from "./api.ts";
import type { Projection } from "./dom.ts";
import { inlineTranslationInRange } from "./inline-translation.ts";
import { rawBoundary } from "./position.ts";
import type { MaterialProvenance } from "./study-api.ts";

/** DOM details stop at this seam; the caller gets verified immutable text coordinates. */
export function captureNativeSelection(
	doc: Document,
	projection: Projection,
	part: Chapter["parts"][number],
	resource: Chapter["resources"][number],
	materialId: string,
	versionId: string,
): MaterialProvenance {
	const selection = doc.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
		throw new Error("请在同一个正文区域内选择一段连续原文。");
	const range = selection.getRangeAt(0);
	if (inlineTranslationInRange(doc, range))
		throw new Error("选区包含译文，请只选择原文。");
	const endpoint = (node: Node, offset: number) => {
		if (node.ownerDocument !== doc || !doc.body.contains(node))
			throw new Error("选区已不属于当前正文，请重新选择。");
		const element =
			node.nodeType === 1 ? (node as Element) : node.parentElement;
		if (element?.closest("rt,rp"))
			throw new Error("选区端点不能落在注音文字中。");
		const entry = projection.entries.find((item) => item.node === node);
		if (entry) {
			if (!Number.isInteger(offset) || offset < 0 || offset > entry.node.length)
				throw new Error("选区文字边界无效。");
			return entry.start + offset;
		}
		if (
			node.nodeType !== 1 ||
			!Number.isInteger(offset) ||
			offset < 0 ||
			offset > node.childNodes.length
		)
			throw new Error("选区端点不在定位正文中。");
		if (!projection.entries.some((item) => node.contains(item.node)))
			throw new Error("选区端点不在定位正文结构中。");
		let before = 0;
		for (const item of projection.entries) {
			let child: Node = item.node;
			while (child.parentNode && child.parentNode !== node)
				child = child.parentNode;
			const included =
				child.parentNode === node
					? Array.prototype.indexOf.call(node.childNodes, child) < offset
					: (item.node.compareDocumentPosition(node) & 4) !== 0;
			if (included) before = item.end;
			else break;
		}
		return before;
	};
	const start = rawBoundary(
		projection.raw,
		endpoint(range.startContainer, range.startOffset),
	);
	const end = rawBoundary(
		projection.raw,
		endpoint(range.endContainer, range.endOffset),
	);
	if (end <= start) throw new Error("请选择非空原文，不能只选择注音。");
	const expected = Array.from(resource.text)
		.slice(part.start, part.end)
		.join("");
	if (projection.raw.normalize("NFC") !== expected)
		throw new Error("当前显示正文无法精确映射，请重新打开章节。");
	const exact = Array.from(expected).slice(start, end).join("");
	if (!exact.trim()) throw new Error("目标原文不能只有空白。");
	return {
		contract_version: "1",
		material_id: materialId,
		version_id: versionId,
		ranges: [
			{
				resource_id: part.resource_id,
				spine_index: part.spine_index,
				start: part.start + start,
				end: part.start + end,
				exact,
				text_sha256: resource.text_sha256,
				prefix: "",
				suffix: "",
			},
		],
	};
}

export type ReaderHighlightRange = Pick<
	MaterialProvenance["ranges"][number],
	"resource_id" | "spine_index" | "start" | "end"
> &
	Partial<Pick<MaterialProvenance["ranges"][number], "exact" | "text_sha256">>;

/** Map every interval completely before painting; chapter grouping never becomes reference identity. */
export function referenceParts(
	chapter: Chapter,
	ranges: readonly ReaderHighlightRange[],
) {
	const result = new Map<number, { start: number; end: number }[]>();
	let previousEnd: number | null = null;
	for (const target of ranges) {
		const resource = chapter.resources.find(
			(item) => item.id === target.resource_id,
		);
		if (
			!resource ||
			target.start < 0 ||
			target.end <= target.start ||
			target.end > Array.from(resource.text).length
		)
			throw new Error("出处资源或范围不可用。");
		if (
			(target.text_sha256 && resource.text_sha256 !== target.text_sha256) ||
			(target.exact !== undefined &&
				Array.from(resource.text).slice(target.start, target.end).join("") !==
					target.exact)
		)
			throw new Error("出处原文快照失配，无法精确定位。");
		let cursor = target.start;
		let offset = 0;
		let first: number | null = null;
		let end = 0;
		for (const [index, part] of chapter.parts.entries()) {
			if (
				part.resource_id === target.resource_id &&
				part.spine_index === target.spine_index
			) {
				const left = Math.max(part.start, target.start),
					right = Math.min(part.end, target.end);
				if (left < right) {
					const position = offset + left - part.start;
					if (left !== cursor || (first !== null && position !== end))
						throw new Error("出处在当前章节中的映射不连续。");
					first ??= position;
					end = offset + right - part.start;
					cursor = right;
					const local = result.get(index) ?? [];
					local.push({ start: left - part.start, end: right - part.start });
					result.set(index, local);
				}
			}
			offset += part.end - part.start;
		}
		if (
			cursor !== target.end ||
			first === null ||
			(previousEnd !== null && first !== previousEnd)
		)
			throw new Error("无法完整定位同章原文范围。");
		previousEnd = end;
	}
	if (!result.size) throw new Error("出处没有可定位的原文。");
	return result;
}
