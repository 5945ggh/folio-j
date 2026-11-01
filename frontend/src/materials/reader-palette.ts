/** Palette values live in reader-r1.css; CSS color-scheme resolves light-dark(). */
export const READER_PALETTE_PROPERTIES = [
	"--reader-bg",
	"--reader-fg",
	"--reader-selection-bg",
	"--reader-location-highlight",
	"--reader-study",
	"--reader-translation",
] as const;
export type ReaderPalette = Partial<
	Record<(typeof READER_PALETTE_PROPERTIES)[number], string>
>;

/** An iframe is a separate CSS document, so explicitly bridge Reader-owned tokens. */
export function frameReaderPalette(doc: Document): ReaderPalette {
	const source = doc.defaultView?.frameElement?.closest(".reader-r1");
	const view = source?.ownerDocument.defaultView;
	if (!source || !view) return {};
	const style = view.getComputedStyle(source);
	return Object.fromEntries(
		READER_PALETTE_PROPERTIES.map((name) => [
			name,
			style.getPropertyValue(name).trim(),
		]),
	);
}
