import {
	type ComponentProps,
	type Ref,
	useImperativeHandle,
	useRef,
} from "react";
import type { AnkiMaterialContext } from "../anki/context";
import {
	Dictionary,
	type DictionaryControl as LookupControl,
} from "../dictionary/Dictionary";
import type { DictionaryAnkiSelection } from "../dictionary/DictionaryCards";
import type {
	ReaderLookupHit,
	ScreenAnchor,
	StudyMarkHit,
	StudySelection,
} from "./reader-study";
import type { MaterialProvenance } from "./study-api";

export type ReaderDictionaryAnkiPayload = DictionaryAnkiSelection & {
	anchor: ScreenAnchor;
	reference: MaterialProvenance | null;
	lookupInput: NonNullable<AnkiMaterialContext["lookupInput"]>;
};

export type DictionaryControl = Omit<LookupControl, "lookup"> & {
	lookup: (hit: ReaderLookupHit | null) => void;
	selection: (value: StudySelection) => void;
};

/** Converts reader coordinates and record actions into the shared lookup interface. */
export function ReaderDictionary({
	ref,
	onRecord,
	onAnki,
	...props
}: Omit<ComponentProps<typeof Dictionary>, "ref"> & {
	ref: Ref<DictionaryControl>;
	onRecord: (hit: StudyMarkHit) => void;
	onAnki?: (payload: ReaderDictionaryAnkiPayload) => void;
}) {
	const control = useRef<LookupControl>(null);
	const ankiRef = useRef(onAnki);
	ankiRef.current = onAnki;
	useImperativeHandle(ref, () => ({
		lookup(hit) {
			const studyHit = hit?.studyHit;
			control.current?.lookup(
				hit
					? {
							input: {
								text: hit.text,
								position: hit.offset,
								tokens: hit.tokens,
							},
							anchor: hit.anchor,
							hover: hit.hover,
							record: studyHit ? () => onRecord(studyHit) : undefined,
							anki: ankiRef.current
								? (selected) =>
										ankiRef.current?.({
											...selected,
											anchor: hit.anchor,
											reference:
												hit.referenceForSpan?.(selected.start, selected.end) ??
												null,
											lookupInput: { text: hit.text, position: hit.offset },
										})
								: undefined,
							highlight: hit.highlight,
							unhighlight: hit.unhighlight,
							clear: hit.clearHighlight,
						}
					: null,
			);
		},
		selection(value) {
			const text = value.reference.ranges.map((r) => r.exact).join("");
			const input = {
				text,
				selection_start: 0,
				selection_end: Array.from(text).length,
			};
			control.current?.lookup({
				input,
				anchor: value.anchor,
				anki: ankiRef.current
					? (selected) =>
							ankiRef.current?.({
								...selected,
								anchor: value.anchor,
								reference:
									selected.start === input.selection_start &&
									selected.end === input.selection_end
										? value.reference
										: null,
								lookupInput: input,
							})
					: undefined,
			});
		},
		close: () => control.current?.close() ?? false,
		dismissMenu: () => control.current?.dismissMenu(),
		back: () => control.current?.back() ?? false,
		isOpen: () => control.current?.isOpen() ?? false,
	}));
	return <Dictionary {...props} ref={control} />;
}
