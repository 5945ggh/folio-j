import type { BookUiPreferences } from "./preferences.ts";

type PreferenceContext = {
	chapter: string;
	current: BookUiPreferences;
	readingsReady: boolean;
	loadReadings: () => Promise<unknown>;
	store: (next: BookUiPreferences) => boolean;
	commit: (
		next: BookUiPreferences,
		result: { geometryChanged: boolean; storageFailed: boolean },
	) => void;
	status: (preparing: boolean, error: Error | null) => void;
};
/** Owns preference intent, asset waiting and the effects of an accepted submission. */
export class ReaderPreferenceSubmission {
	private intent = 0;
	private context: PreferenceContext | null = null;
	private current: BookUiPreferences | null = null;
	bind(context: PreferenceContext): void {
		const changed = this.context?.chapter !== context.chapter;
		this.context = context;
		this.current = context.current;
		if (changed) {
			this.intent++;
			context.status(false, null);
		}
	}
	suspend(): void {
		this.intent++;
		this.context = null;
	}
	async submit(next: BookUiPreferences): Promise<void> {
		const context = this.context;
		if (!context) return;
		const intent = ++this.intent;
		const accepts = () =>
			this.context?.chapter === context.chapter && this.intent === intent;
		context.status(false, null);
		if (next.rubyScope === "all" && !context.readingsReady) {
			context.status(true, null);
			try {
				await context.loadReadings();
			} catch (failure) {
				if (accepts())
					this.context?.status(
						false,
						failure instanceof Error ? failure : new Error(String(failure)),
					);
				return;
			}
			if (!accepts()) return;
			this.context?.status(false, null);
		}
		if (!accepts()) return;
		const active = this.context;
		const current = this.current;
		if (!active || !current) return;
		const geometryChanged =
			next.font !== current.font ||
			next.width !== current.width ||
			next.rubyScope !== current.rubyScope;
		this.current = next;
		const storageFailed = !active.store(next);
		active.commit(next, { geometryChanged, storageFailed });
	}
}
