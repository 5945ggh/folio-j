import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { NativeSelect } from "../NativeSelect";
import { useAutosavingFields } from "./AutosavingSettings";
import {
	type Provider,
	patchSettings,
	type Settings,
	settingsKeys,
} from "./api";
import { SettingsLink as Link } from "./SettingsNavigation";
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
}: {
	settings?: Settings;
	providers: Provider[];
}) {
	const client = useQueryClient();
	const edited = useRef(new Map<keyof ModelFields, string | null>());
	const draft = useAutosavingFields(
		"model-defaults",
		"模型配置",
		modelFields(settings),
		async (fields, accept) => {
			const current = modelFields(
				client.getQueryData<Settings>(settingsKeys.settings),
			);
			const changes: Partial<ModelFields> = {};
			const submitted = [...edited.current.keys()];
			for (const key of submitted) {
				if (fields[key] !== current[key]) changes[key] = fields[key];
			}
			const acceptSaved = (saved: ModelFields) => {
				for (const key of submitted) {
					if (edited.current.get(key) === fields[key])
						edited.current.delete(key);
				}
				accept(saved);
			};
			if (Object.keys(changes).length) {
				const result = await patchSettings({ defaults: changes });
				await commitSettingsResponse(client, result, () =>
					acceptSaved(modelFields(result)),
				);
			} else {
				acceptSaved(current);
			}
		},
		"请选择可用的模型。",
	);
	useEffect(() => {
		if (!draft.dirty && !draft.pending) edited.current.clear();
	}, [draft.dirty, draft.pending]);
	const choices = providers.flatMap((provider) =>
		provider.models.map((model) => ({ model, provider })),
	);
	const hasAvailableModels = choices.some(
		({ model, provider }) => provider.enabled && model.enabled,
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
					<NativeSelect
						className="settings-control"
						value={draft.fields[purpose] ?? ""}
						onChange={(event) => {
							const value = event.target.value || null;
							edited.current.set(purpose, value);
							draft.select({
								...draft.fields,
								[purpose]: value,
							});
						}}
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
					</NativeSelect>
					{selected && (
						<small className="settings-hint settings-model-identity">
							{selected.provider.name} · {selected.model.model_id}
						</small>
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
			{!hasAvailableModels && (
				<aside className="settings-model-guide">
					<strong>
						{providers.length === 0 ? "还没有模型服务。" : "还没有可用的模型。"}
					</strong>
					<p>
						{providers.length === 0
							? "先添加模型服务并添加模型，再返回这里选择默认模型。"
							: "请在「模型服务」中添加模型，或启用已有服务和模型，再返回这里选择。"}
					</p>
					<Link to="/settings?section=providers">前往模型服务 →</Link>
				</aside>
			)}
			{settings && (
				<section
					className="settings-section"
					aria-labelledby="default-models-heading"
				>
					<div className="settings-section-heading">
						<h3 id="default-models-heading">按用途选择模型</h3>
					</div>
					<form
						id="model-defaults-form"
						ref={draft.form}
						onSubmit={(event) => {
							event.preventDefault();
							draft.finishEditing();
						}}
					>
						<div className="settings-group">
							{modelSelect(
								"对话与讲解模型",
								"chat_model_id",
								"新对话和「创建 AI 讲解」默认使用这个模型。",
							)}
							{modelSelect(
								"讲解模型（旧版）",
								"analysis_model_id",
								"仅用于兼容旧版讲解配置，当前讲解均使用上方模型。",
							)}
						</div>
					</form>
					{draft.feedback}
					<p className="settings-hint settings-section-note">
						已有对话将继续使用各自原有的模型。
					</p>
				</section>
			)}
		</div>
	);
}
