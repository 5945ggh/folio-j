import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef } from "react";
import { InlineError } from "../Shared";
import { type Provider, patchSettings, type Settings } from "./api";
import {
	SettingsSaveBar,
	useSettingsDraft,
	useSettingsFields,
} from "./SettingsForms";
import { commitSettingsResponse } from "./settings-cache";

type ModelFields = Pick<
	Settings["defaults"],
	"analysis_model_id" | "chat_model_id"
>;
const modelFields = (settings?: Settings): ModelFields => ({
	analysis_model_id: settings?.defaults.analysis_model_id ?? null,
	chat_model_id: settings?.defaults.chat_model_id ?? null,
});

export function ModelDefaults({
	settings,
	providers,
	children,
}: {
	settings?: Settings;
	providers: Provider[];
	children?: ReactNode;
}) {
	const client = useQueryClient();
	const draft = useSettingsFields(modelFields(settings));
	const form = useRef<HTMLFormElement>(null);
	const save = useMutation({
		mutationFn: (defaults: ModelFields) => patchSettings({ defaults }),
	});
	async function persist() {
		if (!settings || !form.current?.reportValidity()) return false;
		const submitted = draft.fields;
		try {
			const result = await save.mutateAsync(submitted);
			await commitSettingsResponse(client, result, () =>
				draft.accept(submitted, modelFields(result)),
			);
			return true;
		} catch {
			return false;
		}
	}
	useSettingsDraft({
		id: "model-defaults",
		label: "默认模型",
		dirty: draft.dirty,
		pending: save.isPending,
		save: persist,
		discard: draft.reset,
	});
	const choices = providers.flatMap((provider) =>
		provider.models.map((model) => ({ model, provider })),
	);
	function modelSelect(
		label: string,
		purpose: keyof ModelFields,
		description: string,
	) {
		const selected = choices.find(
			({ model }) => model.id === draft.fields[purpose],
		);
		const unavailable =
			draft.fields[purpose] &&
			(!selected?.provider.enabled || !selected.model.enabled);
		return (
			<label className="settings-preference-row">
				<span className="settings-row-copy">
					<strong>{label}</strong>
					<small>{description}</small>
				</span>
				<span className="settings-model-control">
					<select
						className="settings-control"
						value={draft.fields[purpose] ?? ""}
						onChange={(event) =>
							draft.change({
								...draft.fields,
								[purpose]: event.target.value || null,
							})
						}
					>
						<option value="">未选择</option>
						{draft.fields[purpose] && !selected && (
							<option value={draft.fields[purpose] ?? ""}>
								当前模型不可用
							</option>
						)}
						{providers.map((provider) => {
							const models = provider.models.filter(
								(model) =>
									(provider.enabled && model.enabled) ||
									model.id === draft.fields[purpose],
							);
							return (
								models.length > 0 && (
									<optgroup key={provider.id} label={provider.name}>
										{models.map((model) => (
											<option key={model.id} value={model.id}>
												{model.model_id}
												{!provider.enabled || !model.enabled
													? "（已停用）"
													: ""}
											</option>
										))}
									</optgroup>
								)
							);
						})}
					</select>
					{selected && (
						<small className="settings-hint">{selected.provider.name}</small>
					)}
					{unavailable && (
						<small className="field-warning">
							当前默认模型不可用，请重新选择。
						</small>
					)}
				</span>
			</label>
		);
	}
	return (
		<div className="settings-model-page">
			{settings && (
				<section
					className="settings-section"
					aria-labelledby="default-models-heading"
				>
					<div className="settings-section-heading">
						<h3 id="default-models-heading">默认模型</h3>
					</div>
					<form
						id="model-defaults-form"
						ref={form}
						onSubmit={(event) => {
							event.preventDefault();
							void persist();
						}}
					>
						<fieldset disabled={save.isPending}>
							<div className="settings-group">
								{modelSelect(
									"讲解模型",
									"analysis_model_id",
									"单独发起讲解时使用。",
								)}
								{modelSelect(
									"讨论模型",
									"chat_model_id",
									"新对话预选的讨论模型。",
								)}
							</div>
						</fieldset>
					</form>
					<p className="settings-hint settings-section-note">
						已有对话继续使用各自的模型；已接受的任务不受影响。
					</p>
				</section>
			)}
			{children}
			{settings && (
				<>
					<p className="settings-hint settings-section-note">
						条目整理功能尚未开放，已保存的模型配置会保留。
					</p>
					<InlineError error={save.error} />
					<SettingsSaveBar
						formId="model-defaults-form"
						saveLabel="保存默认模型"
						dirty={draft.dirty}
						saved={draft.saved}
						pending={save.isPending}
						onReset={draft.reset}
					/>
				</>
			)}
		</div>
	);
}
