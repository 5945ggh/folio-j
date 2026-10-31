import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../api/client";
import { requireData } from "../../content";
import { NativeSelect } from "../../NativeSelect";
import { ConfirmDialog, InlineError } from "../../Shared";
import {
	type Model,
	type ModelInput,
	type Provider,
	type ProviderInput,
	settingsKeys,
} from "../api";
import { SettingsEditorDialog } from "../SettingsForms";
import { DiscoveredModelList } from "./DiscoveredModelList";
import { useProviderDiscovery } from "./ProviderDiscovery";

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
						body: keyOnly
							? keyChange
							: {
									...(fields.name !== initial.name && { name: fields.name }),
									...(fields.base_url !== initial.base_url && {
										base_url: fields.base_url,
									}),
									...(fields.protocol !== initial.protocol && {
										protocol: fields.protocol,
									}),
								},
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
		? provider?.has_api_key
			? "更换密钥"
			: "添加密钥"
		: provider
			? "编辑连接"
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
							‹ 返回连接设置
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
							{(!provider || keyOnly) && (
								<label className="settings-field full">
									<span>{keyOnly ? "新密钥" : "API Key（可选）"}</span>
									<input
										type="password"
										autoComplete="new-password"
										required={keyOnly && !clearKey}
										pattern={keyOnly ? ".*\\S.*" : undefined}
										disabled={clearKey}
										value={apiKey}
										onChange={(event) => setApiKey(event.target.value)}
										placeholder={
											provider?.has_api_key ? "输入新密钥" : "未设置"
										}
									/>
									<small>保存后只显示密钥的配置状态。</small>
								</label>
							)}
							{keyOnly && provider?.has_api_key && (
								<div className="settings-field full">
									<button
										className="settings-button secondary"
										type="button"
										onClick={() => {
											setClearKey(!clearKey);
											setApiKey("");
										}}
									>
										{clearKey ? "取消移除" : "移除密钥"}
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
					{provider &&
						(fields.base_url !== initial.base_url ||
							fields.protocol !== initial.protocol ||
							apiKey.trim() ||
							clearKey) && (
							<p className="settings-hint">
								保存后，已登记模型的验证状态会重置为「未验证」，模型发现列表需重新获取。
							</p>
						)}
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
									? clearKey
										? "确认移除密钥"
										: "保存密钥"
									: provider
										? "保存连接"
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
	provider,
	onClose,
}: {
	model?: Model;
	provider: Provider;
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
	const discovery = useProviderDiscovery(provider);
	const [mode, setMode] = useState<"list" | "manual">(
		model ? "manual" : "list",
	);
	const [confirmSwitch, setConfirmSwitch] = useState(false);
	const dirty =
		mode === "list"
			? discovery.selected.length > 0
			: JSON.stringify(initial) !== JSON.stringify(fields);
	const save = useMutation({
		mutationFn: async () => {
			const { model_id: _modelId, ...patch } = fields;
			const result = model
				? await api.PATCH("/api/provider-models/{model_id}", {
						params: { path: { model_id: model.id } },
						body: patch,
					})
				: await api.POST("/api/providers/{provider_id}/models", {
						params: { path: { provider_id: provider.id } },
						body: fields,
					});
			return requireData(result.data, result.error, result.response.status);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
			return client.invalidateQueries({ queryKey: settingsKeys.providers });
		},
	});
	const pending = save.isPending || discovery.registering;
	function switchMode() {
		discovery.clear();
		setFields(initial);
		save.reset();
		setConfirmSwitch(false);
		setMode(mode === "list" ? "manual" : "list");
	}
	async function saveDraft() {
		if (mode === "list") return discovery.registerSelected();
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
			id={`model-editor-${model?.id ?? provider.id}`}
			title={model ? `编辑 ${model.model_id}` : "登记模型"}
			dirty={dirty}
			pending={pending}
			save={saveDraft}
			onClose={onClose}
			className="provider-editor-dialog provider-detail-dialog"
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
					<div className="provider-registration-context">
						<button
							type="button"
							className="provider-back"
							disabled={pending}
							onClick={requestClose}
						>
							‹ 返回模型列表
						</button>
						<span className="settings-hint">{provider.name}</span>
					</div>
					{!model && (
						<fieldset
							className="provider-registration-modes"
							aria-label="登记方式"
						>
							{(["list", "manual"] as const).map((method) => (
								<button
									type="button"
									key={method}
									disabled={pending}
									aria-pressed={mode === method}
									onClick={() => {
										if (mode === method) return;
										if (dirty) setConfirmSwitch(true);
										else switchMode();
									}}
								>
									{method === "list" ? "从列表选择" : "手动填写"}
								</button>
							))}
						</fieldset>
					)}
					{mode === "list" ? (
						<DiscoveredModelList provider={provider} discovery={discovery} />
					) : (
						<>
							<fieldset
								className="provider-form-fields"
								disabled={save.isPending}
							>
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
								<details
									className="provider-advanced-fields"
									onInvalidCapture={(event) => {
										event.currentTarget.open = true;
									}}
									open={Boolean(model)}
								>
									<summary>高级设置</summary>
									<div className="settings-form-grid">
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
												<option value="chat_completions">
													Chat Completions
												</option>
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
													setFields({
														...fields,
														enabled: event.target.checked,
													})
												}
											/>
											启用模型
										</label>
									</div>
								</details>
							</fieldset>
							<InlineError error={save.error} />
						</>
					)}
					<div className="settings-actions">
						<button
							className="settings-button primary"
							type="submit"
							disabled={
								pending ||
								(mode === "list" &&
									(!discovery.selected.length || discovery.refresh.isPending))
							}
						>
							{pending
								? "保存中…"
								: mode === "list"
									? `登记所选模型（${discovery.selected.length}）`
									: model
										? "保存模型"
										: "登记模型"}
						</button>
					</div>
					{confirmSwitch && (
						<ConfirmDialog
							className="settings-dialog settings-leave-dialog"
							titleId="switch-registration-method"
							onClose={() => setConfirmSwitch(false)}
						>
							<h2 id="switch-registration-method">切换登记方式？</h2>
							<p>
								{mode === "list"
									? "切换后将清除本次勾选。"
									: "切换后将清除本次填写的内容。"}
							</p>
							<div className="settings-actions">
								<button
									type="button"
									className="settings-button secondary"
									onClick={switchMode}
								>
									放弃并切换
								</button>
								<button
									type="button"
									data-dialog-cancel
									className="settings-button primary"
									onClick={() => setConfirmSwitch(false)}
								>
									继续编辑
								</button>
							</div>
						</ConfirmDialog>
					)}
				</form>
			)}
		</SettingsEditorDialog>
	);
}
