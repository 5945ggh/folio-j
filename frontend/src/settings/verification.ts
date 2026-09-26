import type { Model } from "./api";

export type Capability = "text" | "stream";
export type VerificationState =
	| "unknown"
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "interrupted";

export function undiscoveredRegistrations(
	discovered: readonly string[],
	registered: readonly Pick<Model, "model_id">[],
): string[] {
	const existing = new Set(registered.map((model) => model.model_id));
	return [...new Set(discovered)].filter((id) => !existing.has(id));
}

export function capabilityPresentation(state: VerificationState): {
	icon: string;
	label: string;
} {
	switch (state) {
		case "succeeded":
			return { icon: "✓", label: "可用" };
		case "queued":
		case "running":
			return { icon: "◌", label: "验证中" };
		case "failed":
			return { icon: "!", label: "验证失败" };
		case "interrupted":
			return { icon: "↺", label: "验证中断" };
		default:
			return { icon: "—", label: "未验证" };
	}
}

export function isActiveVerification(state: VerificationState): boolean {
	return state === "queued" || state === "running";
}
