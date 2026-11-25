import { type CSSProperties, Fragment, type ReactNode } from "react";
import type { DictionaryNode } from "./dictionary-api";
import "./dictionary.css";

function definitionStyle(
	style: DictionaryNode["style"],
): CSSProperties | undefined {
	if (!style) return undefined;
	const properties = Object.fromEntries(
		Object.entries(style).filter(([, value]) => value != null),
	);
	// Preserve the dictionary's colors on both reader papers.
	for (const [key, paper, percent] of [
		["color", "--reader-fg", 48],
		["backgroundColor", "--reader-bg", 24],
		["borderColor", "--reader-fg", 52],
	] as const) {
		const color = style[key];
		if (color)
			properties[key] =
				`light-dark(${color}, color-mix(in srgb, ${color} ${percent}%, var(${paper})))`;
	}
	return properties;
}

/** The same styled definition tree can host lookup or plain-text excerpt actions. */
export function DictionaryDefinitionNodes({
	nodes,
	actionFor,
}: {
	nodes: readonly DictionaryNode[];
	actionFor?: (node: DictionaryNode) => ReactNode;
}) {
	function renderNodes(
		children: readonly DictionaryNode[],
		path: string,
	): ReactNode[] {
		return children.map((node, index) => {
			const key = `${path}.${index}`;
			const Tag = node.tag ?? "span";
			if (Tag === "br") return <br key={key} />;
			const action = actionFor?.(node);
			// Keep controls outside ruby annotations and list containers.
			const actionOutside =
				Tag === "ruby" || Tag === "rt" || Tag === "ol" || Tag === "ul";
			return (
				<Fragment key={key}>
					{actionOutside && action}
					<Tag
						lang={node.lang ?? undefined}
						data-dict-role={node.role ?? undefined}
						style={definitionStyle(node.style)}
					>
						{!actionOutside && action}
						{node.text}
						{node.content && renderNodes(node.content, key)}
					</Tag>
				</Fragment>
			);
		});
	}
	return renderNodes(nodes, "");
}
