export function rawBoundary(raw, offset) {
	if (!Number.isInteger(offset) || offset < 0 || offset > raw.length)
		throw new Error("边界超出正文");
	if (
		offset > 0 &&
		offset < raw.length &&
		/[\uD800-\uDBFF]/.test(raw[offset - 1]) &&
		/[\uDC00-\uDFFF]/.test(raw[offset])
	)
		throw new Error("选区切开了代理对字符");
	const before = raw.slice(0, offset).normalize("NFC");
	if (before + raw.slice(offset).normalize("NFC") !== raw.normalize("NFC"))
		throw new Error("选区切开了跨节点 NFC 组合，无法精确定位");
	return [...before].length;
}
export function rawOffset(raw, point) {
	if (!Number.isInteger(point) || point < 0) throw new Error("码点边界无效");
	const normalized = raw.normalize("NFC");
	// Most imported chapters already use NFC: one code-point walk, no prefix normalization loop.
	if (raw === normalized) {
		let count = 0,
			offset = 0;
		for (const character of raw) {
			if (count === point) return offset;
			count++;
			offset += character.length;
		}
		if (count === point) return offset;
		throw new Error("找不到可验证的原文边界");
	}
	if (typeof Intl.Segmenter !== "function")
		throw new Error("当前浏览器不支持分解正文的精确边界恢复");
	const segments = [
		...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw),
	];
	if (segments.map((s) => s.segment.normalize("NFC")).join("") !== normalized)
		throw new Error("浏览器分段无法验证 NFC 正文");
	let count = 0;
	for (const { segment, index } of segments) {
		const length = [...segment.normalize("NFC")].length;
		if (point >= count && point <= count + length) {
			for (let local = 0; local <= segment.length; local++) {
				try {
					const offset = index + local;
					if (rawBoundary(raw, offset) === point) return offset;
				} catch {
					/* Composition or surrogate interior. */
				}
			}
		}
		count += length;
		if (count > point) break;
	}
	throw new Error("找不到可验证的原文边界");
}
export function validateQuote(quote, book, resource) {
	if (quote.materialVersion !== book.materialVersion)
		throw new Error("材料版本失配");
	if (quote.resourceId !== resource.id)
		throw new Error("资源失配，请打开引用所属资源");
	const chars = [...resource.text];
	if (
		!Number.isInteger(quote.start) ||
		!Number.isInteger(quote.end) ||
		quote.start < 0 ||
		quote.end <= quote.start ||
		quote.end > chars.length
	)
		throw new Error("码点范围无效");
	if (chars.slice(quote.start, quote.end).join("") !== quote.exact)
		throw new Error("原文快照失配，拒绝搜索相同文字");
}
export function projection(doc, expected) {
	const leaves = [...doc.querySelectorAll("[data-locator-leaf]")];
	const entries = [];
	let raw = "";
	for (const [index, leaf] of leaves.entries()) {
		if (leaf.getAttribute("data-locator-leaf") !== String(index))
			throw new Error("正文叶子身份或顺序失配");
		if (leaf.closest("rt,rp")) throw new Error("注音被错误计入正文");
		if (leaf.children.length) throw new Error("正文叶子含子元素");
		for (const node of leaf.childNodes) {
			if (node.nodeType !== 3) continue;
			entries.push({
				node,
				start: raw.length,
				end: raw.length + node.data.length,
				leaf,
			});
			raw += node.data;
		}
	}
	if (raw.normalize("NFC") !== expected)
		throw new Error("阅读 DOM 与定位正文失配");
	return { raw, entries };
}
function visible(entry) {
	const view = entry.node.ownerDocument.defaultView;
	for (let el = entry.leaf; el; el = el.parentElement) {
		const s = view.getComputedStyle(el);
		if (
			s.display === "none" ||
			s.visibility === "hidden" ||
			s.visibility === "collapse" ||
			Number(s.opacity) === 0
		)
			return false;
	}
	return true;
}
function offsetAt(doc, entries, container, offset) {
	const element =
		container.nodeType === 3 ? container.parentElement : container;
	if (!doc.body.contains(container) || element?.closest?.("rt,rp"))
		throw new Error("选区边界位于注音或当前正文以外");
	if (container.nodeType === 3) {
		const entry = entries.find((e) => e.node === container);
		if (!entry) throw new Error("选区边界位于注音或非正文内容");
		return entry.start + offset;
	}
	const probe = doc.createRange();
	probe.setStart(container, offset);
	probe.collapse(true);
	for (const entry of entries) {
		const r = doc.createRange();
		r.selectNodeContents(entry.node);
		if (probe.compareBoundaryPoints(0, r) <= 0) return entry.start;
		if (
			probe.compareBoundaryPoints(
				0,
				(() => {
					const end = doc.createRange();
					end.setStart(entry.node, entry.node.length);
					end.collapse(true);
					return end;
				})(),
			) < 0
		)
			throw new Error("无法识别元素选区边界");
	}
	return entries.at(-1)?.end ?? 0;
}
export function captureRange(doc, range, book, resource) {
	const { raw, entries } = projection(doc, resource.text);
	const a = offsetAt(doc, entries, range.startContainer, range.startOffset);
	const b = offsetAt(doc, entries, range.endContainer, range.endOffset);
	if (entries.some((e) => e.end > a && e.start < b && !visible(e)))
		throw new Error("选区含被作者 CSS 隐藏的正文，无法提供可见定位");
	const start = rawBoundary(raw, a),
		end = rawBoundary(raw, b);
	const chars = [...resource.text];
	const quote = {
		materialVersion: book.materialVersion,
		resourceId: resource.id,
		start,
		end,
		exact: chars.slice(start, end).join(""),
		prefix: chars.slice(Math.max(0, start - 20), start).join(""),
		suffix: chars.slice(end, end + 20).join(""),
	};
	validateQuote(quote, book, resource);
	return quote;
}
export function restoreRange(doc, quote, book, resource) {
	validateQuote(quote, book, resource);
	const { raw, entries } = projection(doc, resource.text);
	const a = rawOffset(raw, quote.start),
		b = rawOffset(raw, quote.end);
	if (entries.some((e) => e.end > a && e.start < b && !visible(e)))
		throw new Error("引用正文被作者 CSS 隐藏，无法还原可见选区");
	const first = entries.find((e) => e.end > a),
		last = entries.find((e) => e.end >= b && e.start < b);
	if (!first || !last) throw new Error("正文节点不可用");
	const range = doc.createRange();
	range.setStart(first.node, a - first.start);
	range.setEnd(last.node, b - last.start);
	const roundTrip = captureRange(doc, range, book, resource);
	if (
		roundTrip.start !== quote.start ||
		roundTrip.end !== quote.end ||
		roundTrip.exact !== quote.exact
	)
		throw new Error("恢复选区往返校验失败");
	return range;
}
