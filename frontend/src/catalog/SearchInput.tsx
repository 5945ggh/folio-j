import { type ComponentPropsWithRef, useLayoutEffect, useState } from "react";
import { useLocation } from "react-router";
import { createSearchDraft } from "./search-draft";

type SearchInputProps = Omit<
	ComponentPropsWithRef<"input">,
	| "type"
	| "value"
	| "defaultValue"
	| "onChange"
	| "onCompositionStart"
	| "onCompositionEnd"
> & {
	value: string;
	onValueChange: (value: string) => void;
};

/** Keep the native IME draft synchronous; only committed text reaches the URL. */
export function SearchInput({
	value,
	onValueChange,
	onKeyDown,
	...props
}: SearchInputProps) {
	const { pathname } = useLocation();
	const [draft] = useState(() => createSearchDraft(value));
	const [input, setInput] = useState(value);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Route changes reset an active IME draft even when the query is identical.
	useLayoutEffect(() => {
		draft.receive(value);
		setInput(draft.value);
	}, [draft, value, pathname]);
	function update(commit: string | undefined) {
		setInput(draft.value);
		// Navigation may flush synchronously, so the draft is ready before calling out.
		if (commit !== undefined) onValueChange(commit);
	}
	return (
		<input
			{...props}
			type="search"
			value={input}
			onChange={(event) => {
				update(
					draft.change(
						event.currentTarget.value,
						(event.nativeEvent as InputEvent).isComposing,
					),
				);
			}}
			onCompositionStart={() => draft.startComposition()}
			onCompositionEnd={(event) => {
				update(draft.endComposition(event.currentTarget.value));
			}}
			onKeyDown={(event) => {
				if (
					(event.key === "Escape" || event.key === "Enter") &&
					draft.isComposingKey(event.nativeEvent)
				) {
					event.stopPropagation();
					return;
				}
				onKeyDown?.(event);
			}}
		/>
	);
}
