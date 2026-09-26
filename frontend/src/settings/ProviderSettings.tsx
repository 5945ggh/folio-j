import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client";
import { errorMessage, requireData } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type Model,
	type ModelInput,
	type Provider,
	type ProviderInput,
	settingsKeys,
} from "./api";

export function ProviderSettings({ providers }: { providers: Provider[] }) {
	const [creating, setCreating] = useState(false);
	const [discoveryFailed, setDiscoveryFailed] = useState(false);
	return (
		<section className="settings-section" aria-labelledby="providers-heading">
			<div className="section-heading">
				<h2 id="providers-heading">模型接入</h2>
				<button
					className="button secondary"
					type="button"
					onClick={() => {
						setDiscoveryFailed(false);
						setCreating(true);
					}}
				>
					添加 Provider
				</button>
			</div>
			<p className="settings-hint">
				登记接入地址与模型。发现列表仅说明列表接口可访问；文本和流式能力需分别验证。
			</p>
			{creating && (
				<ProviderEditor
					onClose={() => setCreating(false)}
					onDiscoveryResult={setDiscoveryFailed}
				/>
			)}
			{discoveryFailed && (
				<p className="field-warning" role="status">
					Provider
					已保存，但模型列表获取失败。可在下方手动登记模型或再次刷新列表。
				</p>
			)}
			<div className="provider-list">
				{providers.map((provider) => (
					<ProviderCard
						key={provider.id}
						provider={provider}
						onDiscoverySuccess={() => setDiscoveryFailed(false)}
					/>
				))}
				{providers.length === 0 && (
					<div className="empty-state">
						<p>
							还没有 Provider。添加后可刷新模型列表，或直接手动登记模型 ID。
						</p>
					</div>
				)}
			</div>
		</section>
	);
}

function ProviderEditor({
	provider,
	onClose,
	onDiscoveryResult,
}: {
	provider?: Provider;
	onClose: () => void;
	onDiscoveryResult?: (failed: boolean) => void;
}) {
	const client = useQueryClient();
	const [fields, setFields] = useState<Omit<ProviderInput, "api_key">>({
		name: provider?.name ?? "",
		base_url: provider?.base_url ?? "",
		protocol: provider?.protocol ?? "chat_completions",
		enabled: provider?.enabled ?? true,
	});
	const [apiKey, setApiKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const save = useMutation({
		mutationFn: async () => {
			const body = {
				...fields,
				...(clearKey
					? { api_key: "" }
					: apiKey.trim()
						? { api_key: apiKey }
						: {}),
			};
			const result = provider
				? await api.PATCH("/api/providers/{provider_id}", {
						params: { path: { provider_id: provider.id } },
						body,
					})
				: await api.POST("/api/providers", { body });
			return requireData(result.data, result.error, result.response.status);
		},
		onSuccess: (savedProvider) => {
			setApiKey("");
			setClearKey(false);
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
			onClose();
			if (!provider && savedProvider.enabled) {
				void (async () => {
					try {
						const { data, error } = await api.POST(
							"/api/providers/{provider_id}/refresh-models",
							{ params: { path: { provider_id: savedProvider.id } } },
						);
						onDiscoveryResult?.(
							Boolean(error || !data || data.discovery_status === "failed"),
						);
					} catch {
						onDiscoveryResult?.(true);
					} finally {
						void client.invalidateQueries({ queryKey: settingsKeys.providers });
					}
				})();
			}
		},
	});
	return (
		<form
			className="editor-card settings-editor"
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<h3>{provider ? `编辑 ${provider.name}` : "添加 Provider"}</h3>
			<div className="form-grid">
				<label className="field">
					<span>名称</span>
					<input
						required
						value={fields.name}
						onChange={(event) =>
							setFields({ ...fields, name: event.target.value })
						}
					/>
				</label>
				<label className="field">
					<span>协议</span>
					<select
						value={fields.protocol}
						onChange={(event) =>
							setFields({
								...fields,
								protocol: event.target.value as ProviderInput["protocol"],
							})
						}
					>
						<option value="chat_completions">Chat Completions</option>
						<option value="responses">Responses</option>
					</select>
				</label>
				<label className="field full">
					<span>API 地址</span>
					<input
						required
						type="url"
						value={fields.base_url}
						onChange={(event) =>
							setFields({ ...fields, base_url: event.target.value })
						}
						placeholder="https://api.example.com/v1"
					/>
				</label>
				<label className="field full">
					<span>API Key（可选）</span>
					<input
						type="password"
						autoComplete="new-password"
						value={apiKey}
						disabled={clearKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={
							provider?.has_api_key ? "已保存；留空则保留" : "未设置"
						}
					/>
					<small>密钥不会重新显示；保存后清空输入。</small>
				</label>
				{provider?.has_api_key && (
					<div className="field full">
						<button
							className="button secondary key-clear"
							type="button"
							onClick={() => {
								setClearKey(!clearKey);
								setApiKey("");
							}}
						>
							{clearKey ? "取消清除密钥" : "清除已保存的密钥"}
						</button>
						{clearKey && <small>保存后此 Provider 将不再携带 API Key。</small>}
					</div>
				)}
				<label className="check-field full">
					<input
						type="checkbox"
						checked={fields.enabled}
						onChange={(event) =>
							setFields({ ...fields, enabled: event.target.checked })
						}
					/>
					启用 Provider
				</label>
			</div>
			<InlineError error={save.error} />
			<div className="actions">
				<button
					className="button primary"
					type="submit"
					disabled={save.isPending}
				>
					保存 Provider
				</button>
				<button className="button secondary" type="button" onClick={onClose}>
					取消
				</button>
			</div>
		</form>
	);
}

function ProviderCard({
	provider,
	onDiscoverySuccess,
}: {
	provider: Provider;
	onDiscoverySuccess: () => void;
}) {
	const client = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [addingModel, setAddingModel] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const refresh = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await api.POST(
				"/api/providers/{provider_id}/refresh-models",
				{ params: { path: { provider_id: provider.id } } },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: (result) => {
			if (result.discovery_status === "succeeded") onDiscoverySuccess();
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
		},
	});
	const toggle = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await api.PATCH(
				"/api/providers/{provider_id}",
				{
					params: { path: { provider_id: provider.id } },
					body: { enabled: !provider.enabled },
				},
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	const remove = useMutation({
		mutationFn: async () => {
			const { error, response } = await api.DELETE(
				"/api/providers/{provider_id}",
				{ params: { path: { provider_id: provider.id } } },
			);
			if (!response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: () => {
			setDeleting(false);
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	return (
		<article className="provider-card">
			<div className="provider-heading">
				<div>
					<h3>
						{provider.name}{" "}
						{!provider.enabled && (
							<span className="status-tag muted">已停用</span>
						)}
					</h3>
					<p>
						{provider.base_url} ·{" "}
						{provider.protocol === "responses"
							? "Responses"
							: "Chat Completions"}{" "}
						· {provider.has_api_key ? "已保存密钥" : "无密钥"}
					</p>
				</div>
				<div className="actions">
					<button
						className="button secondary"
						type="button"
						onClick={() => setEditing(!editing)}
					>
						编辑
					</button>
					<button
						className="button secondary"
						type="button"
						disabled={toggle.isPending}
						onClick={() => toggle.mutate()}
					>
						{provider.enabled ? "停用" : "启用"}
					</button>
					<button
						className="text-danger"
						type="button"
						disabled={remove.isPending}
						onClick={() => {
							remove.reset();
							setDeleting(true);
						}}
					>
						删除
					</button>
				</div>
			</div>
			{deleting && (
				<ConfirmDialog
					titleId="delete-provider-title"
					onClose={() => {
						if (!remove.isPending) setDeleting(false);
					}}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id="delete-provider-title">删除「{provider.name}」？</h2>
					<p>删除后此 Provider 不再用于新验证，历史验证记录会保留。</p>
					<InlineError error={remove.error} />
					<div className="actions">
						<button
							className="button danger"
							type="button"
							disabled={remove.isPending}
							onClick={() => remove.mutate()}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							className="button secondary"
							type="button"
							disabled={remove.isPending}
							onClick={() => setDeleting(false)}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
			{editing && (
				<ProviderEditor
					key={provider.revision}
					provider={provider}
					onClose={() => setEditing(false)}
				/>
			)}
			<div className="discovery-line">
				<span>
					模型列表：
					{provider.discovery_status === "succeeded"
						? `已获取 ${provider.discovered_models.length} 个 ID`
						: provider.discovery_status === "failed"
							? "获取失败，缓存仍保留"
							: "尚未获取"}
				</span>
				<button
					className="button secondary"
					type="button"
					disabled={refresh.isPending || !provider.enabled}
					onClick={() => refresh.mutate()}
				>
					{refresh.isPending ? "获取中…" : "刷新模型列表"}
				</button>
			</div>
			{provider.discovery_error && (
				<p className="field-warning" role="status">
					{provider.discovery_error}
				</p>
			)}
			<InlineError error={refresh.error ?? toggle.error ?? remove.error} />
			{provider.discovered_models.length > 0 && (
				<details className="discovered-models">
					<summary>查看发现的模型 ID</summary>
					<p>{provider.discovered_models.join(" · ")}</p>
					<small>列表获取成功不代表模型可用于文本生成。</small>
				</details>
			)}
			<div className="models-heading">
				<h4>已登记模型</h4>
				<button
					className="button secondary"
					type="button"
					onClick={() => setAddingModel(true)}
				>
					手动登记模型
				</button>
			</div>
			{addingModel && (
				<ModelEditor
					providerId={provider.id}
					onClose={() => setAddingModel(false)}
				/>
			)}
			{provider.models.length === 0 ? (
				<p className="settings-hint">
					尚未登记模型。可输入从列表获取的 ID，也可登记列表中没有的 ID。
				</p>
			) : (
				provider.models.map((model) => (
					<ModelRow
						key={model.id}
						model={model}
						providerEnabled={provider.enabled}
					/>
				))
			)}
		</article>
	);
}

function ModelEditor({
	model,
	providerId,
	onClose,
}: {
	model?: Model;
	providerId: string;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [fields, setFields] = useState<ModelInput>({
		model_id: model?.model_id ?? "",
		protocol_override: model?.protocol_override ?? null,
		enabled: model?.enabled ?? true,
		temperature: model?.temperature ?? null,
		max_output_tokens: model?.max_output_tokens ?? null,
		reasoning_effort: model?.reasoning_effort ?? null,
	});
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
			onClose();
		},
	});
	return (
		<form
			className="editor-card settings-editor"
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<h4>{model ? "编辑模型" : "手动登记模型"}</h4>
			<div className="form-grid">
				<label className="field">
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
				<label className="field">
					<span>协议覆盖</span>
					<select
						value={fields.protocol_override ?? ""}
						onChange={(event) =>
							setFields({
								...fields,
								protocol_override: (event.target.value ||
									null) as ModelInput["protocol_override"],
							})
						}
					>
						<option value="">继承 Provider</option>
						<option value="chat_completions">Chat Completions</option>
						<option value="responses">Responses</option>
					</select>
				</label>
				<label className="field">
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
									event.target.value === "" ? null : Number(event.target.value),
							})
						}
					/>
				</label>
				<label className="field">
					<span>最大输出 token（可选）</span>
					<input
						type="number"
						min="1"
						step="1"
						value={fields.max_output_tokens ?? ""}
						onChange={(event) =>
							setFields({
								...fields,
								max_output_tokens:
									event.target.value === "" ? null : Number(event.target.value),
							})
						}
					/>
				</label>
				<label className="field">
					<span>推理强度（可选）</span>
					<select
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
					</select>
				</label>
				<label className="check-field">
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
			<InlineError error={save.error} />
			<div className="actions">
				<button
					className="button primary"
					type="submit"
					disabled={save.isPending}
				>
					保存模型
				</button>
				<button className="button secondary" type="button" onClick={onClose}>
					取消
				</button>
			</div>
		</form>
	);
}

function ModelRow({
	model,
	providerEnabled,
}: {
	model: Model;
	providerEnabled: boolean;
}) {
	const client = useQueryClient();
	const [editing, setEditing] = useState(false);
	const verify = useMutation({
		mutationFn: async (stream: boolean) => {
			const { data, error, response } = await api.POST(
				"/api/provider-models/{model_id}/verifications",
				{ params: { path: { model_id: model.id } }, body: { stream } },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () =>
			void client.invalidateQueries({ queryKey: settingsKeys.runs }),
	});
	const statusLabel = (value: string) =>
		value === "succeeded" ? "通过" : value === "failed" ? "失败" : "未验证";
	return (
		<div className="model-row">
			<div className="model-title">
				<strong>{model.model_id}</strong>
				{!model.enabled && <span className="status-tag muted">已停用</span>}
				<span className="model-protocol">{model.effective_protocol}</span>
			</div>
			<p>
				普通文本：{statusLabel(model.text_status)} · 流式文本：
				{statusLabel(model.stream_status)} · 结构化输出：未验证
			</p>
			<div className="actions">
				<button
					className="button secondary"
					type="button"
					onClick={() => setEditing(!editing)}
				>
					编辑参数
				</button>
				<button
					className="button secondary"
					type="button"
					disabled={!providerEnabled || !model.enabled || verify.isPending}
					onClick={() => verify.mutate(false)}
				>
					验证普通文本
				</button>
				<button
					className="button secondary"
					type="button"
					disabled={!providerEnabled || !model.enabled || verify.isPending}
					onClick={() => verify.mutate(true)}
				>
					验证流式文本
				</button>
			</div>
			<InlineError error={verify.error} />
			{verify.isSuccess && (
				<p className="save-note" role="status">
					已接受验证任务，记录见下方历史。
				</p>
			)}
			{editing && (
				<ModelEditor
					key={model.revision}
					model={model}
					providerId={model.provider_id}
					onClose={() => setEditing(false)}
				/>
			)}
		</div>
	);
}
