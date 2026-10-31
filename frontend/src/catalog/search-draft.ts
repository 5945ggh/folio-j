type CompositionKey = {
	isComposing?: boolean;
	keyCode?: number;
};

export function createSearchDraft(initial: string) {
	let value = initial;
	let committed = initial;
	let composing = false;

	function commit(next: string): string | undefined {
		if (next === committed) return undefined;
		committed = next;
		return next;
	}

	return {
		get value(): string {
			return value;
		},
		get composing(): boolean {
			return composing;
		},
		change(next: string, nativeComposing = false): string | undefined {
			value = next;
			if (nativeComposing) composing = true;
			return composing ? undefined : commit(next);
		},
		startComposition(): void {
			composing = true;
		},
		endComposition(next: string): string | undefined {
			if (!composing) return undefined;
			composing = false;
			value = next;
			return commit(next);
		},
		receive(next: string): void {
			value = next;
			committed = next;
			composing = false;
		},
		isComposingKey(event: CompositionKey): boolean {
			return composing || event.isComposing === true || event.keyCode === 229;
		},
	};
}
