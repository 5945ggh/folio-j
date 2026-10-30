import type { MaterialProvenance } from "../materials/study-api.ts";
import { translationReferenceKey } from "../materials/study-translation.ts";
import type { TranslationResult } from "./api.ts";

const RECENT_CHOICES = 32;

/** Keep a bounded user choice, without retaining the result or its entire chapter. */
export class TranslationPreferences {
	private choices = new Map<string, { reference: string; resultId: string }>();
	remember(result: TranslationResult): void {
		if (result.reader_deleted || result.material_deleted) return;
		const reference = translationReferenceKey(result.material_provenance);
		if (!reference) return;
		this.choices.delete(result.identity_sha256);
		this.choices.set(result.identity_sha256, {
			reference,
			resultId: result.id,
		});
		while (this.choices.size > RECENT_CHOICES) {
			const oldest = this.choices.keys().next().value;
			if (oldest === undefined) break;
			this.choices.delete(oldest);
		}
	}
	forget(identity: string): void {
		this.choices.delete(identity);
	}
	matching(reference: MaterialProvenance): string | null {
		const key = translationReferenceKey(reference);
		return (
			[...this.choices.values()]
				.reverse()
				.find((choice) => choice.reference === key)?.resultId ?? null
		);
	}
}
