export class ElementNode {
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
export class TextNode {
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
export function harness(chunks: string[], originalIndex = -1) {
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
