import type { Model, Provider, Run, RunFilters } from "./api";
import { isActiveVerification } from "./verification.ts";

export function summarizeProvider(
	provider: Pick<Provider, "enabled" | "models">,
) {
	const enabled = provider.enabled
		? provider.models.filter((model) => model.enabled)
		: [];
	const states = (model: Model) => [
		model.text_verification?.status ?? model.text_status,
		model.stream_verification?.status ?? model.stream_status,
	];
	const ready = enabled.filter((model) =>
		states(model).every((state) => state === "succeeded"),
	).length;
	const active = enabled.some((model) =>
		states(model).some(isActiveVerification),
	);
	const failed = enabled.some((model) =>
		states(model).some(
			(state) => state === "failed" || state === "interrupted",
		),
	);
	if (!provider.enabled)
		return { ready, tone: "neutral", label: "已停用" } as const;
	if (active) return { ready, tone: "busy", label: "验证中" } as const;
	if (ready > 0)
		return {
			ready,
			tone: "ready",
			label: `${ready} 个模型已验证`,
		} as const;
	if (failed) return { ready, tone: "warning", label: "验证未通过" } as const;
	return {
		ready,
		tone: "neutral",
		label: "尚未验证",
	} as const;
}

export function historyFilters(
	providerId: string | undefined,
	selectedProvider: string,
	modelId: string,
	status: Run["status"] | "",
): RunFilters {
	const provider = providerId ?? selectedProvider;
	return {
		...(provider ? { provider_id: provider } : {}),
		...(modelId ? { model_id: modelId } : {}),
		...(status ? { status } : {}),
	};
}
