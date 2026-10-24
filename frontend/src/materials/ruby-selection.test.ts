import assert from "node:assert/strict";
import test from "node:test";
import type { ReadingsToken } from "./api";
import { projectPart } from "./dom.ts";
import { applyAutomaticRuby } from "./ruby.ts";

class ElementNode {
	nodeType = 1;
	dataset: Record<string, string> = {};
	childNodes: Array<ElementNode | TextNode> = [];
	parentElement: ElementNode | null = null;
	tag: string;
	constructor(tag: string) {
		this.tag = tag;
	}
	get children() {
		return this.childNodes.filter((node) => node instanceof ElementNode);
	}
	get textContent(): string {
		return this.childNodes
			.map((node) => (node instanceof TextNode ? node.data : node.textContent))
			.join("");
	}
	set textContent(value: string) {
		this.childNodes = [];
		this.append(new TextNode(value));
	}
	append(node: ElementNode | TextNode) {
		node.parentElement = this;
		this.childNodes.push(node);
	}
	contains(node: ElementNode | TextNode): boolean {
		return (
			this === node ||
			this.childNodes.some(
				(child) =>
					child === node ||
					(child instanceof ElementNode && child.contains(node)),
			)
		);
	}
	closest(selector: string): ElementNode | null {
		return selector.split(",").includes(this.tag)
			? this
			: (this.parentElement?.closest(selector) ?? null);
	}
	matches(selector: string) {
		if (selector === this.tag) return true;
		return (
			selector === "ruby[data-auto-ruby]" &&
			this.tag === "ruby" &&
			this.dataset.autoRuby !== undefined
		);
	}
}
class TextNode {
	nodeType = 3;
	parentElement: ElementNode | null = null;
	data: string;
	constructor(data: string) {
		this.data = data;
	}
	get length() {
		return this.data.length;
	}
	get isConnected() {
		return this.parentElement !== null;
	}
	splitText(offset: number) {
		const next = new TextNode(this.data.slice(offset));
		this.data = this.data.slice(0, offset);
		const parent = this.parentElement;
		if (!parent) throw new Error("detached");
		next.parentElement = parent;
		parent.childNodes.splice(parent.childNodes.indexOf(this) + 1, 0, next);
		return next;
	}
	replaceWith(node: ElementNode) {
		const parent = this.parentElement;
		if (!parent) throw new Error("detached");
		parent.childNodes.splice(parent.childNodes.indexOf(this), 1, node);
		node.parentElement = parent;
		this.parentElement = null;
	}
}
function harness(chunks: string[], originalIndex = -1) {
	const leaves = chunks.map((text, index) => {
		const leaf = new ElementNode("span");
		leaf.dataset.locatorLeaf = String(index);
		leaf.append(new TextNode(text));
		if (index === originalIndex) {
			const ruby = new ElementNode("ruby");
			ruby.append(leaf);
		}
		return leaf;
	});
	const doc = {
		querySelectorAll: () => leaves,
		createElement: (tag: string) => new ElementNode(tag),
		createTreeWalker: (root: ElementNode) => {
			const nodes: TextNode[] = [];
			const collect = (element: ElementNode) => {
				for (const child of element.childNodes)
					if (child instanceof TextNode) nodes.push(child);
					else collect(child);
			};
			collect(root);
			let index = 0;
			return { nextNode: () => nodes[index++] ?? null };
		},
	} as unknown as Document;
	return { doc, leaves };
}
function token(start: number, surface: string, reading: string): ReadingsToken {
	return {
		start,
		end: start + Array.from(surface).length,
		surface,
		reading,
		dictionary_form: surface,
		normalized_form: surface,
		pos: [],
		is_oov: false,
	};
}

for (const [surface, reading, backward] of [
	["食べる", "タベル", false],
	["食べる", "タベル", true],
	["まな板", "マナイタ", false],
	["まな板", "マナイタ", true],
] as const) {
	test(`automatic ruby preserves ${backward ? "backward" : "forward"} original text selection for ${surface}`, () => {
		const h = harness([`𠮷${surface}`, "今日か\u3099"]);
		const projection = projectPart(h.doc, `𠮷${surface}今日が`, 0);
		const first = projection.entries[0]?.node;
		const last = projection.entries[1]?.node;
		assert.ok(first);
		assert.ok(last);
		const selection = {
			isCollapsed: false,
			anchorNode: backward ? last : first,
			anchorOffset: backward ? 1 : 3,
			focusNode: backward ? first : last,
			focusOffset: backward ? 3 : 1,
			setBaseAndExtent(anchor: Text, a: number, focus: Text, f: number) {
				this.anchorNode = anchor;
				this.anchorOffset = a;
				this.focusNode = focus;
				this.focusOffset = f;
			},
		};
		h.doc.getSelection = () => selection as unknown as Selection;
		const originalSplit = TextNode.prototype.splitText;
		TextNode.prototype.splitText = function (offset) {
			const next = originalSplit.call(this, offset);
			if (
				selection.anchorNode === (this as unknown as Text) &&
				selection.anchorOffset > offset
			) {
				selection.anchorNode = next as unknown as Text;
				selection.anchorOffset -= offset;
			}
			if (
				selection.focusNode === (this as unknown as Text) &&
				selection.focusOffset > offset
			) {
				selection.focusNode = next as unknown as Text;
				selection.focusOffset -= offset;
			}
			return next;
		};
		const originalReplace = TextNode.prototype.replaceWith;
		TextNode.prototype.replaceWith = function (node) {
			// Model live Range relocation after the original selected Text is removed.
			if (selection.anchorNode === (this as unknown as Text))
				selection.anchorOffset = 0;
			if (selection.focusNode === (this as unknown as Text))
				selection.focusOffset = 0;
			originalReplace.call(this, node);
		};
		try {
			applyAutomaticRuby(
				h.doc,
				projection,
				[token(1, surface, reading), token(4, "今日", "キョウ")],
				0,
			);
			const fresh = projectPart(h.doc, projection.raw.normalize("NFC"), 0);
			const offset = (node: Text, local: number) =>
				(fresh.entries.find((e) => e.node === node)?.start ?? Number.NaN) +
				local;
			assert.equal(
				offset(selection.anchorNode, selection.anchorOffset),
				backward ? 6 : 3,
			);
			assert.equal(
				offset(selection.focusNode, selection.focusOffset),
				backward ? 3 : 6,
			);
		} finally {
			TextNode.prototype.replaceWith = originalReplace;
			TextNode.prototype.splitText = originalSplit;
		}
	});
}

test("same Text boundaries and independent part documents retain their own selections", () => {
	for (const raw of ["今日食べる", "𠮷今日か\u3099"]) {
		const h = harness([raw]);
		const projection = projectPart(h.doc, raw.normalize("NFC"), 0);
		const node = projection.entries[0]?.node;
		assert.ok(node);
		let restored: [Node, number, Node, number] | null = null;
		h.doc.getSelection = () =>
			({
				isCollapsed: false,
				anchorNode: node,
				anchorOffset: 0,
				focusNode: node,
				focusOffset: raw.length,
				setBaseAndExtent(...args: [Node, number, Node, number]) {
					restored = args;
				},
			}) as unknown as Selection;
		applyAutomaticRuby(
			h.doc,
			projection,
			[token(raw.startsWith("𠮷") ? 1 : 0, "今日", "キョウ")],
			0,
		);
		assert.ok(restored);
		const [anchor, a, focus, f] = restored as [Node, number, Node, number];
		const fresh = projectPart(h.doc, raw.normalize("NFC"), 0);
		assert.equal(
			(fresh.entries.find((e) => e.node === anchor)?.start ?? Number.NaN) + a,
			0,
		);
		assert.equal(
			(fresh.entries.find((e) => e.node === focus)?.start ?? Number.NaN) + f,
			raw.length,
		);
	}
});

test("absent and collapsed selections do not invoke Selection restoration", () => {
	for (const collapsed of [false, true]) {
		const h = harness(["今日"]);
		h.doc.getSelection = () =>
			collapsed
				? ({
						isCollapsed: true,
						setBaseAndExtent() {
							assert.fail("collapsed selection restored");
						},
					} as unknown as Selection)
				: null;
		applyAutomaticRuby(
			h.doc,
			projectPart(h.doc, "今日", 0),
			[token(0, "今日", "キョウ")],
			0,
		);
	}
});

test("element-boundary selection is restored onto the rebuilt original text", () => {
	const h = harness(["今日"]);
	const projection = projectPart(h.doc, "今日", 0);
	const leaf = h.leaves[0];
	assert.ok(leaf);
	let restored: [Node, number, Node, number] | null = null;
	h.doc.getSelection = () =>
		({
			isCollapsed: false,
			anchorNode: leaf,
			anchorOffset: 0,
			focusNode: leaf,
			focusOffset: 1,
			setBaseAndExtent(...args: [Node, number, Node, number]) {
				restored = args;
			},
		}) as unknown as Selection;
	h.doc.createRange = () => {
		let boundary = 0;
		return {
			setStart(_node: Node, offset: number) {
				boundary = offset === 0 ? 0 : 2;
			},
			collapse() {},
			comparePoint(_node: Node, offset: number) {
				return Math.sign(offset - boundary);
			},
		} as unknown as Range;
	};
	applyAutomaticRuby(h.doc, projection, [token(0, "今日", "キョウ")], 0);
	assert.ok(restored);
	const [anchor, a, focus, f] = restored as [Node, number, Node, number];
	const fresh = projectPart(h.doc, "今日", 0);
	assert.equal(
		(fresh.entries.find((e) => e.node === anchor)?.start ?? Number.NaN) + a,
		0,
	);
	assert.equal(
		(fresh.entries.find((e) => e.node === focus)?.start ?? Number.NaN) + f,
		2,
	);
});

for (const tag of ["rt", "rp", "aside"]) {
	test(`${tag} element selection remains outside the original text projection`, () => {
		const h = harness(["今日"]);
		const excluded = new ElementNode(tag);
		excluded.append(new TextNode("外部文字"));
		let restored: [Node, number, Node, number] | null = null;
		h.doc.getSelection = () =>
			({
				isCollapsed: false,
				anchorNode: excluded,
				anchorOffset: 0,
				focusNode: excluded,
				focusOffset: 1,
				setBaseAndExtent(...args: [Node, number, Node, number]) {
					restored = args;
				},
			}) as unknown as Selection;
		h.doc.createRange = () => {
			throw new Error("external endpoint projected");
		};
		applyAutomaticRuby(
			h.doc,
			projectPart(h.doc, "今日", 0),
			[token(0, "今日", "キョウ")],
			0,
		);
		assert.equal(restored, null);
	});
}
