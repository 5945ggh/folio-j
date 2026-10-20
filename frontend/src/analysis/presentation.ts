type ReadingBlock = { id: string | null; raw: string };

type ReadingTitle = { sectionId: string | null; markdown: string };

/** A rendering copy only: stored Markdown, section identity and revisions stay intact. */
export function analysisPresentation(document: {
	title: string;
	source_md: string;
	sections: readonly { id: string; raw: string }[];
}): { title: ReadingTitle | null; blocks: ReadingBlock[] } {
	const blocks: ReadingBlock[] = document.sections.length
		? document.sections.map(({ id, raw }) => ({ id, raw }))
		: [{ id: null, raw: document.source_md }];
	const first = blocks.find((block) => block.raw.trim());
	if (!first) return { title: null, blocks };

	// Only the first nonblank line can own the title. Never search through code,
	// prose, HTML or other Markdown blocks for an apparent heading.
	const blankPrefix = /^(?:[ \t]*\r?\n)*/.exec(first.raw)?.[0] ?? "";
	const leading = /^ {0,3}(#{1,2})[ \t]+([^\r\n]+)(\r?\n|$)/.exec(
		first.raw.slice(blankPrefix.length),
	);
	if (!leading) return { title: null, blocks };
	const text = leading[2]?.replace(/[ \t]+#+[ \t]*$/, "").trim() ?? "";
	if (!text || /^#+$/.test(text) || /[\\`*_~[\]<>&]/.test(text))
		return { title: null, blocks };
	if (
		leading[1] === "##" &&
		text.normalize("NFC") !== document.title.trim().normalize("NFC")
	)
		return { title: null, blocks };

	const markdown = leading[0];
	first.raw = first.raw.slice(blankPrefix.length + leading[0].length);
	return { title: { sectionId: first.id, markdown }, blocks };
}
