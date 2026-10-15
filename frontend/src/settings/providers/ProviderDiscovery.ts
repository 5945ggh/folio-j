import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../../api/client";
import { requireData } from "../../content";
import { type Provider, settingsKeys } from "../api";
import { undiscoveredRegistrations } from "../verification";

export function useProviderDiscovery(provider: Provider) {
	const client = useQueryClient();
	const [selectedModels, setSelectedModels] = useState<string[]>([]);
	const [registering, setRegistering] = useState(false);
	const registrationLock = useRef(false);
	const [registrationError, setRegistrationError] = useState<string | null>(
		null,
	);
	const available = undiscoveredRegistrations(
		provider.discovered_models,
		provider.models,
	);
	const selected = selectedModels.filter((id) => available.includes(id));
	async function registerSelected(): Promise<boolean> {
		if (registrationLock.current) return false;
		if (selected.length === 0) return true;
		registrationLock.current = true;
		setRegistering(true);
		setRegistrationError(null);
		const failed: string[] = [];
		try {
			for (const modelId of selected) {
				try {
					const { data, error, response } = await api.POST(
						"/api/providers/{provider_id}/models",
						{
							params: { path: { provider_id: provider.id } },
							body: {
								model_id: modelId,
								enabled: true,
								protocol_override: null,
								temperature: null,
								max_output_tokens: null,
								reasoning_effort: null,
							},
						},
					);
					if (response.status !== 409)
						requireData(data, error, response.status);
				} catch {
					failed.push(modelId);
				} finally {
					await client.invalidateQueries({ queryKey: settingsKeys.providers });
				}
			}
			setSelectedModels(failed);
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
			if (failed.length > 0)
				setRegistrationError(
					`${selected.length - failed.length} 个已登记；${failed.length} 个未成功，已保留选择，可重试。`,
				);
			return failed.length === 0;
		} finally {
			registrationLock.current = false;
			setRegistering(false);
		}
	}
	const refresh = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await api.POST(
				"/api/providers/{provider_id}/refresh-models",
				{ params: { path: { provider_id: provider.id } } },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
		},
	});
	return {
		available,
		selected,
		registering,
		registrationError,
		refresh,
		registerSelected,
		select: (id: string, checked: boolean) =>
			setSelectedModels(
				checked ? [...selected, id] : selected.filter((value) => value !== id),
			),
		clear: () => {
			setSelectedModels([]);
			setRegistrationError(null);
		},
	};
}

export type ProviderDiscovery = ReturnType<typeof useProviderDiscovery>;
