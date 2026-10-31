import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../api/client";
import { requireData } from "../../content";
import { NativeSelect } from "../../NativeSelect";
import { InlineError } from "../../Shared";
import {
	type Model,
	type ModelInput,
	type Provider,
	type ProviderInput,
	settingsKeys,
} from "../api";
import { SettingsEditorDialog } from "../SettingsForms";

export function ProviderEditor({
	provider,
	keyOnly = false,
	onClose,
	onCreated,
}: {
	provider?: Provider;
	keyOnly?: boolean;
	onClose: () => void;
	onCreated?: (provider: Provider) => void;
}) {
	const client = useQueryClient();
	const form = useRef<HTMLFormElement>(null);
	const saving = useRef(false);
	const [initial] = useState<Omit<ProviderInput, "api_key">>(() => ({
		name: provider?.name ?? "",
		base_url: provider?.base_url ?? "",
		protocol: provider?.protocol ?? "chat_completions",
		enabled: provider?.enabled ?? true,
	}));
	const [fields, setFields] = useState(initial);
	const [apiKey, setApiKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const dirty =
		JSON.stringify(fields) !== JSON.stringify(initial) ||
		apiKey.length > 0 ||
		clearKey;
	const save = useMutation({
		mutationFn: async () => {
			const keyChange = clearKey
				? { api_key: "" }
				: apiKey.trim()
					? { api_key: apiKey }
					: {};
			const result = provider
				? await api.PATCH("/api/providers/{provider_id}", {
						params: { path: { provider_id: provider.id } },
						body: keyOnly ? keyChange : { ...fields, ...keyChange },
					})
				: await api.POST("/api/providers", {
						body: { ...fields, ...keyChange },
					});
			return requireData(result.data, result.error, result.response.status);
		},
		onSuccess: (saved) => {
			setApiKey("");
			setClearKey(false);
			client.setQueryData<Provider[]>(settingsKeys.providers, (current) =>
				current?.some((item) => item.id === saved.id)
					? current.map((item) => (item.id === saved.id ? saved : item))
					: [...(current ?? []), saved],
			);
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	async function saveDraft() {
		if (saving.current || !form.current?.reportValidity()) return false;
		saving.current = true;
		try {
			const saved = await save.mutateAsync();
			if (!provider) onCreated?.(saved);
			return true;
		} catch {
			return false;
		} finally {
			saving.current = false;
		}
	}
	const title = keyOnly
		? "更新 API Key"
		: provider
			? `编辑 ${provider.name}`
			: "添加服务";
	return (
		<SettingsEditorDialog
			id={`provider-editor-${provider?.id ?? "new"}`}
			title={title}
			dirty={dirty}
			pending={save.isPending}
			save={saveDraft}
			onClose={onClose}
			className="provider-editor-dialog"
		>
			{(requestClose) => (
				<form
					ref={form}
					className="settings-editor-form"
					onSubmit={async (event: FormEvent) => {
						event.preventDefault();
						if (await saveDraft()) onClose();
					}}
				>
					{provider && (
						<button
							type="button"
							className="provider-back"
							disabled={save.isPending}
							onClick={requestClose}
						>
							‹ 返回服务详情
						</button>
					)}
					<fieldset disabled={save.isPending} className="provider-form-fields">
						<div className="settings-form-grid">
							{!keyOnly && (
								<>
									<label className="settings-field">
										<span>名称</span>
										<input
											required
											value={fields.name}
											onChange={(event) =>
												setFields({ ...fields, name: event.target.value })
											}
										/>
									</label>
									<label className="settings-field">
										<span>默认协议</span>
										<NativeSelect
											value={fields.protocol}
											onChange={(event) =>
												setFields({
													...fields,
													protocol: event.target
														.value as ProviderInput["protocol"],
												})
											}
										>
											<option value="chat_completions">Chat Completions</option>
											<option value="responses">Responses</option>
										</NativeSelect>
									</label>
									<label className="settings-field full">
										<span>API 地址</span>
										<input
											required
											type="url"
											value={fields.base_url}
											placeholder="https://api.example.com/v1"
											onChange={(event) =>
												setFields({ ...fields, base_url: event.target.value })
											}
										/>
									</label>
								</>
							)}
							<label className="settings-field full">
								<span>{keyOnly ? "新 API Key" : "API Key（可选）"}</span>
								<input
									type="password"
									autoComplete="new-password"
									required={keyOnly && !clearKey}
									disabled={clearKey}
									value={apiKey}
									onChange={(event) => setApiKey(event.target.value)}
									placeholder={
										provider?.has_api_key ? "已保存；留空则保留" : "未设置"
									}
								/>
								<small>密钥不会重新显示；保存后清空输入。</small>
							</label>
							{provider?.has_api_key && (
								<div className="settings-field full">
									<button
										className="settings-button secondary"
										type="button"
										onClick={() => {
											setClearKey(!clearKey);
											setApiKey("");
										}}
									>
										{clearKey ? "取消清除密钥" : "清除已保存的密钥"}
									</button>
									{clearKey && <small>保存后此服务将不再携带 API Key。</small>}
								</div>
							)}
							{!provider && (
								<label className="provider-check full">
									<input
										type="checkbox"
										checked={fields.enabled}
										onChange={(event) =>
											setFields({ ...fields, enabled: event.target.checked })
										}
									/>
									启用服务，并尝试发现模型
								</label>
							)}
						</div>
					</fieldset>
					<InlineError error={save.error} />
					<div className="settings-actions">
						<button
							className="settings-button primary"
							type="submit"
							disabled={save.isPending}
						>
							{save.isPending
								? "保存中…"
								: keyOnly
									? "保存 API Key"
									: "保存服务"}
						</button>
						<button
							className="settings-button secondary"
							type="button"
							disabled={save.isPending}
							onClick={requestClose}
						>
							取消
						</button>
					</div>
				</form>
			)}
		</SettingsEditorDialog>
	);
}

export function ModelEditor({
	model,
	providerId,
	onClose,
}: {
	model?: Model;
	providerId: string;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const form = useRef<HTMLFormElement>(null);
	const saving = useRef(false);
	const [initial] = useState<ModelInput>(() => ({
		model_id: model?.model_id ?? "",
		protocol_override: model?.protocol_override ?? null,
		enabled: model?.enabled ?? true,
		temperature: model?.temperature ?? null,
		max_output_tokens: model?.max_output_tokens ?? null,
		reasoning_effort: model?.reasoning_effort ?? null,
	}));
	const [fields, setFields] = useState(initial);
	const save = useMutation({
		mutationFn: async () => {
			const { model_id: _modelId, ...patch } = fields;
			const result = model
				? await api.PATCH("/api/provider-models/{model_id}", {
						params: { path: { model_id: model.id } },
						body: patch,
					})
				: await api.POST("/api/providers/{provider_id}/models", {
						params: { path: { provider_id: providerId } },
						body: fields,
					});
			return requireData(result.data, result.error, result.response.status);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	async function saveDraft() {
		if (saving.current || !form.current?.reportValidity()) return false;
		saving.current = true;
		try {
			await save.mutateAsync();
			return true;
		} catch {
			return false;
		} finally {
			saving.current = false;
		}
	}
	return (
		<SettingsEditorDialog
			id={`model-editor-${model?.id ?? providerId}`}
			title={model ? `编辑 ${model.model_id}` : "手动登记模型"}
			dirty={JSON.stringify(initial) !== JSON.stringify(fields)}
			pending={save.isPending}
			save={saveDraft}
			onClose={onClose}
			className="provider-editor-dialog"
		>
			{(requestClose) => (
				<form
					ref={form}
					className="settings-editor-form"
					onSubmit={async (event: FormEvent) => {
						event.preventDefault();
						if (await saveDraft()) onClose();
					}}
				>
					<button
						type="button"
						className="provider-back"
						disabled={save.isPending}
						onClick={requestClose}
					>
						‹ 返回服务详情
					</button>
					<fieldset className="provider-form-fields" disabled={save.isPending}>
						<div className="settings-form-grid">
							<label className="settings-field">
								<span>上游模型 ID</span>
								<input
									required
									disabled={Boolean(model)}
									value={fields.model_id}
									onChange={(event) =>
										setFields({ ...fields, model_id: event.target.value })
									}
								/>
							</label>
							<label className="settings-field">
								<span>协议覆盖</span>
								<NativeSelect
									value={fields.protocol_override ?? ""}
									onChange={(event) =>
										setFields({
											...fields,
											protocol_override: (event.target.value ||
												null) as ModelInput["protocol_override"],
										})
									}
								>
									<option value="">继承服务默认协议</option>
									<option value="chat_completions">Chat Completions</option>
									<option value="responses">Responses</option>
								</NativeSelect>
							</label>
							<label className="settings-field">
								<span>Temperature（可选）</span>
								<input
									type="number"
									min="0"
									max="2"
									step="0.1"
									value={fields.temperature ?? ""}
									onChange={(event) =>
										setFields({
											...fields,
											temperature:
												event.target.value === ""
													? null
													: Number(event.target.value),
										})
									}
								/>
							</label>
							<label className="settings-field">
								<span>最大输出 token（可选）</span>
								<input
									type="number"
									min="1"
									step="1"
									value={fields.max_output_tokens ?? ""}
									placeholder="使用服务默认值"
									onChange={(event) =>
										setFields({
											...fields,
											max_output_tokens:
												event.target.value === ""
													? null
													: Number(event.target.value),
										})
									}
								/>
								<small>
									填写整数，如
									131072；留空不发送此参数，实际可用上限由模型服务决定。
								</small>
							</label>
							<label className="settings-field">
								<span>推理强度（可选）</span>
								<NativeSelect
									value={fields.reasoning_effort ?? ""}
									onChange={(event) =>
										setFields({
											...fields,
											reasoning_effort: (event.target.value ||
												null) as ModelInput["reasoning_effort"],
										})
									}
								>
									<option value="">不传递</option>
									<option value="none">none</option>
									<option value="low">low</option>
									<option value="medium">medium</option>
									<option value="high">high</option>
								</NativeSelect>
							</label>
							<label className="provider-check">
								<input
									type="checkbox"
									checked={fields.enabled}
									onChange={(event) =>
										setFields({ ...fields, enabled: event.target.checked })
									}
								/>
								启用模型
							</label>
						</div>
					</fieldset>
					<InlineError error={save.error} />
					<div className="settings-actions">
						<button
							className="settings-button primary"
							type="submit"
							disabled={save.isPending}
						>
							{save.isPending ? "保存中…" : "保存模型"}
						</button>
						<button
							className="settings-button secondary"
							type="button"
							disabled={save.isPending}
							onClick={requestClose}
						>
							取消
						</button>
					</div>
				</form>
			)}
		</SettingsEditorDialog>
	);
}
