import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
} from "react";
import { DictionaryText } from "./DictionaryDefinitions";
import type { DictionaryPassage } from "./dictionary-passage";
import type { DictionaryMode } from "./preferences";

/** A host supplies lookup behavior; text renderers remain usable on their own. */
export const LookupTextContext = createContext<{
	mode: DictionaryMode;
	enabled: boolean;
	onLookup: (passage: DictionaryPassage) => void;
	onContentChange: () => void;
	lookupEpoch: number;
} | null>(null);

export function LookupText({
	children,
	contentKey,
	className,
	lang,
	enabled = true,
}: {
	children: ReactNode;
	contentKey: unknown;
	className: string;
	lang?: string;
	enabled?: boolean;
}) {
	const context = useContext(LookupTextContext);
	const lookup = enabled ? context : null;
	const onContentChange = lookup?.onContentChange;
	// biome-ignore lint/correctness/useExhaustiveDependencies: Replacing displayed text invalidates a lookup even if its DOM nodes are reused.
	useLayoutEffect(() => onContentChange?.(), [contentKey, onContentChange]);
	return lookup ? (
		<DictionaryText
			mode={lookup.mode}
			enabled={lookup.enabled}
			onLookup={lookup.onLookup}
			contentKey={contentKey}
			resetKey={lookup.lookupEpoch}
			className={className}
			lang={lang}
			requireShift
		>
			{children}
		</DictionaryText>
	) : (
		<div className={className} lang={lang}>
			{children}
		</div>
	);
}
