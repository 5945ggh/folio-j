import {
	type ComponentProps,
	type Ref,
	useImperativeHandle,
	useRef,
} from "react";
import {
	Dictionary,
	type DictionaryControl as LookupControl,
} from "../dictionary/Dictionary";
import type {
	ReaderLookupHit,
	StudyMarkHit,
	StudySelection,
} from "./reader-study";

export type DictionaryControl = Omit<LookupControl, "lookup"> & {
	lookup: (hit: ReaderLookupHit | null) => void;
	selection: (value: StudySelection) => void;
};

/** Converts reader coordinates and record actions into the shared lookup interface. */
export function ReaderDictionary({
	ref,
	onRecord,
	...props
}: Omit<ComponentProps<typeof Dictionary>, "ref"> & {
	ref: Ref<DictionaryControl>;
	onRecord: (hit: StudyMarkHit) => void;
}) {
	const control = useRef<LookupControl>(null);
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
							record: studyHit ? () => onRecord(studyHit) : undefined,
							highlight: hit.highlight,
							clear: hit.clearHighlight,
						}
					: null,
			);
		},
		selection(value) {
			const text = value.target.reference.ranges.map((r) => r.exact).join("");
			control.current?.lookup({
				input: {
					text,
					selection_start: 0,
					selection_end: Array.from(text).length,
				},
				anchor: value.anchor,
			});
		},
		close: () => control.current?.close() ?? false,
		dismissMenu: () => control.current?.dismissMenu(),
		back: () => control.current?.back() ?? false,
		isOpen: () => control.current?.isOpen() ?? false,
	}));
	return <Dictionary {...props} ref={control} />;
}
