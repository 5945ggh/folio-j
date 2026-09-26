import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
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
import { RunDetail } from "./RunHistory";
import {
	type Capability,
	capabilityPresentation,
	isActiveVerification,
	undiscoveredRegistrations,
	type VerificationState,
} from "./verification";

function TimeStamp({ value }: { value: string }) {
	const date = new Date(value);
	const label = new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
	return (
		<time dateTime={value} title={date.toLocaleString("zh-CN")}>
			{label}
		</time>
	);
}

function ActionMenu({
	className,
	label,
	glyph = "···",
	children,
}: {
	className: string;
	label: string;
	glyph?: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node))
				ref.current?.removeAttribute("open");
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && ref.current?.open) {
				ref.current.open = false;
				ref.current.querySelector("summary")?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, []);
	return (
		<details className={className} ref={ref}>
			<summary className="button secondary" aria-label={label}>
				{glyph}
			</summary>
			<div className="action-menu-panel">{children}</div>
		</details>
	);
}

export function ProviderSettings({ providers }: { providers: Provider[] }) {
	const [creating, setCreating] = useState(false);
	const [discoveryFailed, setDiscoveryFailed] = useState(false);
	const models = providers.flatMap((provider) => provider.models);
	const textReady = models.filter(
		(model) =>
			(model.text_verification?.status ?? model.text_status) === "succeeded" &&
			(model.stream_verification?.status ?? model.stream_status) ===
				"succeeded",
	).length;
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
				{providers.length} 个 Provider · {models.length} 个已登记模型 ·{" "}
				{textReady}{" "}
				个模型两项文本验证通过。发现列表仅说明列表接口可访问；文本和流式能力需分别验证。
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
	keyOnly = false,
}: {
	provider?: Provider;
	onClose: () => void;
	onDiscoveryResult?: (failed: boolean) => void;
	keyOnly?: boolean;
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
			const keyChange = clearKey
				? { api_key: "" }
				: apiKey.trim()
					? { api_key: apiKey }
					: {};
			if (provider) {
				const result = await api.PATCH("/api/providers/{provider_id}", {
					params: { path: { provider_id: provider.id } },
					body: keyOnly ? keyChange : { ...fields, ...keyChange },
				});
				return requireData(result.data, result.error, result.response.status);
			}
			const result = await api.POST("/api/providers", {
				body: { ...fields, ...keyChange },
			});
			return requireData(result.data, result.error, result.response.status);
		},
		onSuccess: (savedProvider) => {
			setApiKey("");
			setClearKey(false);
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
			onClose();
			if (!provider && savedProvider.enabled) {
				onDiscoveryResult?.(savedProvider.discovery_status === "failed");
			}
		},
	});
	return (
		<form
			className={
				provider ? "provider-editor-form" : "editor-card settings-editor"
			}
			onSubmit={(event: FormEvent) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			{provider ? (
				<h2 id={`edit-provider-${provider.id}`}>
					{keyOnly ? "更新 API Key" : `编辑 ${provider.name}`}
				</h2>
			) : (
				<h3>添加 Provider</h3>
			)}
			<div className="form-grid">
				{!keyOnly && (
					<>
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
					</>
				)}
				<label className="field full">
					<span>{keyOnly ? "新 API Key" : "API Key（可选）"}</span>
					<input
						type="password"
						required={keyOnly && !clearKey}
						autoComplete="new-password"
						value={apiKey}
						disabled={clearKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={
							keyOnly
								? "输入新 API Key"
								: provider?.has_api_key
									? "已保存；留空则保留"
									: "未设置"
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
				{!provider && (
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
				)}
			</div>
			<InlineError error={save.error} />
			<div className="actions">
				<button
					className="button primary"
					type="submit"
					disabled={save.isPending}
				>
					{keyOnly ? "保存 API Key" : provider ? "保存" : "保存 Provider"}
				</button>
				<button
					className="button secondary"
					type="button"
					data-dialog-cancel
					onClick={onClose}
				>
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
	const [expanded, setExpanded] = useState(true);
	const [editing, setEditing] = useState<"details" | "key" | null>(null);
	const [addingModel, setAddingModel] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [selectedModels, setSelectedModels] = useState<string[]>([]);
	const [registering, setRegistering] = useState(false);
	const [registrationError, setRegistrationError] = useState<string | null>(
		null,
	);
	const available = undiscoveredRegistrations(
		provider.discovered_models,
		provider.models,
	);
	const selected = selectedModels.filter((id) => available.includes(id));
	const registerSelected = async () => {
		setRegistering(true);
		setRegistrationError(null);
		const failed: string[] = [];
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
				if (response.status !== 409) requireData(data, error, response.status);
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
		setRegistering(false);
	};
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
				<div className="provider-heading-main">
					<h3 className="provider-title">
						{provider.name}{" "}
						<span
							className={`status-tag ${provider.enabled ? "enabled" : "muted"}`}
						>
							<span aria-hidden="true">{provider.enabled ? "●" : "○"} </span>
							{provider.enabled ? "已启用" : "已停用"}
						</span>
						<span className="provider-caret" aria-hidden="true">
							{expanded ? "⌄" : "›"}
						</span>
					</h3>
					<p className="provider-meta">
						<span>{provider.base_url}</span>
						<span>
							{provider.protocol === "responses"
								? "Responses API"
								: "Chat Completions API"}
						</span>
						<span>
							{provider.has_api_key
								? "API Key 已配置"
								: "未配置 API Key（可选）"}
						</span>
					</p>
					<button
						className="provider-heading-toggle"
						type="button"
						aria-label={`${expanded ? "收起" : "展开"} ${provider.name}`}
						aria-expanded={expanded}
						aria-controls={`provider-body-${provider.id}`}
						onClick={() => setExpanded(!expanded)}
					/>
				</div>
				<div className="actions provider-actions">
					<button
						className="button secondary"
						type="button"
						disabled={toggle.isPending}
						onClick={() => toggle.mutate()}
					>
						{provider.enabled ? "停用" : "启用"}
					</button>
					<ActionMenu
						className="provider-menu action-menu"
						label={`${provider.name} 更多操作`}
					>
						<button
							type="button"
							onClick={(event) => {
								event.currentTarget.closest("details")?.removeAttribute("open");
								setEditing("details");
							}}
						>
							编辑
						</button>
						<button
							type="button"
							onClick={(event) => {
								event.currentTarget.closest("details")?.removeAttribute("open");
								setEditing("key");
							}}
						>
							更新 API Key
						</button>
						<button
							className="text-danger"
							type="button"
							disabled={remove.isPending}
							onClick={(event) => {
								event.currentTarget.closest("details")?.removeAttribute("open");
								remove.reset();
								setDeleting(true);
							}}
						>
							删除
						</button>
					</ActionMenu>
				</div>
			</div>
			<InlineError error={toggle.error} />
			{editing && (
				<ConfirmDialog
					titleId={`edit-provider-${provider.id}`}
					onClose={() => setEditing(null)}
				>
					<ProviderEditor
						key={`${provider.revision}-${editing}`}
						provider={provider}
						keyOnly={editing === "key"}
						onClose={() => setEditing(null)}
					/>
				</ConfirmDialog>
			)}
			{deleting && (
				<ConfirmDialog
					titleId={`delete-provider-${provider.id}`}
					onClose={() => {
						if (!remove.isPending) setDeleting(false);
					}}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id={`delete-provider-${provider.id}`}>
						删除「{provider.name}」？
					</h2>
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
							data-dialog-cancel
							disabled={remove.isPending}
							onClick={() => setDeleting(false)}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
			<div
				className="provider-body"
				id={`provider-body-${provider.id}`}
				hidden={!expanded}
			>
				<div className="discovery-line">
					<div className="discovery-summary">
						<strong>模型发现</strong>
						<span>
							{provider.discovery_status === "succeeded"
								? "同步成功"
								: provider.discovery_status === "failed"
									? "同步失败，保留缓存"
									: "尚未同步"}
						</span>
						<span>已发现 {provider.discovered_models.length}</span>
						<span>
							其中已登记 {provider.discovered_models.length - available.length}
						</span>
						<span>待添加 {available.length}</span>
						<span>
							最近同步{" "}
							{provider.last_discovered_at ? (
								<TimeStamp value={provider.last_discovered_at} />
							) : (
								"—"
							)}
						</span>
					</div>
					<div className="discovery-actions">
						<button
							className="button secondary"
							type="button"
							disabled={refresh.isPending}
							onClick={() => refresh.mutate()}
						>
							{refresh.isPending ? "拉取中…" : "拉取模型列表"}
						</button>
						<button
							className="button secondary"
							type="button"
							onClick={() => setAddingModel(true)}
						>
							手动登记模型
						</button>
					</div>
				</div>
				{provider.discovery_error && (
					<p className="field-warning" role="status">
						{provider.discovery_error}
					</p>
				)}
				<InlineError error={refresh.error} />
				{provider.discovered_models.length > 0 && (
					<details className="discovered-models">
						<summary>查看发现列表并登记模型</summary>
						<p className="settings-hint">
							发现仅说明列表接口可访问；能力需要单独验证。已登记的模型不能重复选择。
						</p>
						<div className="discovery-list">
							{[...new Set(provider.discovered_models)].map((id) => {
								const registered = provider.models.some(
									(model) => model.model_id === id,
								);
								return (
									<label className="discovery-item" key={id}>
										<input
											type="checkbox"
											disabled={registered || registering}
											checked={registered || selected.includes(id)}
											onChange={(event) =>
												setSelectedModels(
													event.target.checked
														? [...selected, id]
														: selected.filter((value) => value !== id),
												)
											}
										/>
										<span>{id}</span>
										<small>{registered ? "已登记" : "待添加"}</small>
									</label>
								);
							})}
						</div>
						<div className="discovery-actions">
							<button
								className="button primary"
								type="button"
								disabled={selected.length === 0 || registering}
								onClick={() => void registerSelected()}
							>
								{registering ? "登记中…" : `登记所选（${selected.length}）`}
							</button>
						</div>
						{registrationError && (
							<p className="field-warning" role="status">
								{registrationError}
							</p>
						)}
					</details>
				)}
				{addingModel && (
					<ModelEditor
						providerId={provider.id}
						onClose={() => setAddingModel(false)}
					/>
				)}
				{provider.models.length === 0 ? (
					<p className="settings-hint">
						尚未登记模型。从发现列表勾选登记，或手动添加模型 ID。
					</p>
				) : (
					<table className="model-table">
						<thead>
							<tr>
								<th>模型</th>
								<th>协议</th>
								<th>普通文本</th>
								<th>流式</th>
								<th>
									结构化 <small className="table-note">暂未开放验证</small>
								</th>
								<th className="model-last-verified">最近验证</th>
								<th className="model-actions">操作</th>
							</tr>
						</thead>
						<tbody>
							{provider.models.map((model) => (
								<ModelRow
									key={model.id}
									model={model}
									providerEnabled={provider.enabled}
								/>
							))}
						</tbody>
					</table>
				)}
			</div>
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
	const [showRecord, setShowRecord] = useState<Capability | null>(null);
	const [optimistic, setOptimistic] = useState<Capability[]>([]);
	const textSummary = model.text_verification;
	const streamSummary = model.stream_verification;
	const textState: VerificationState = optimistic.includes("text")
		? "queued"
		: ((textSummary?.status ?? model.text_status) as VerificationState);
	const streamState: VerificationState = optimistic.includes("stream")
		? "queued"
		: ((streamSummary?.status ?? model.stream_status) as VerificationState);
	const latest = [textSummary, streamSummary]
		.filter((item) => item !== null)
		.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
	const busy =
		isActiveVerification(textState) || isActiveVerification(streamState);
	const verify = useMutation({
		mutationFn: async (targets: Capability[]) => {
			let accepted = 0;
			for (const target of targets) {
				try {
					const { data, error, response } = await api.POST(
						"/api/provider-models/{model_id}/verifications",
						{
							params: { path: { model_id: model.id } },
							body: { stream: target === "stream" },
						},
					);
					requireData(data, error, response.status);
					accepted += 1;
				} catch (error) {
					const reason = error instanceof Error ? error.message : "请求未完成";
					throw new Error(
						`已接受 ${accepted} 项验证；${target === "text" ? "普通文本" : "流式文本"}请求未确认接受，其余尚未发送。${reason}。可刷新状态核实后重试。`,
					);
				}
			}
		},
		onSettled: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: settingsKeys.providers }),
				client.invalidateQueries({ queryKey: settingsKeys.runs }),
			]);
			setOptimistic([]);
		},
	});
	const startVerification = (targets: Capability[]) => {
		if (
			!providerEnabled ||
			!model.enabled ||
			busy ||
			verify.isPending ||
			targets.length === 0
		)
			return;
		verify.reset();
		setOptimistic(targets);
		verify.mutate(targets);
	};
	const status = (state: VerificationState) => {
		const presentation = capabilityPresentation(state);
		return (
			<span className={`capability-status ${state}`}>
				<span aria-hidden="true">{presentation.icon}</span> {presentation.label}
			</span>
		);
	};
	return (
		<>
			<tr className="model-row">
				<td data-label="模型">
					<div className="model-title">
						<strong>{model.model_id}</strong>
						{!model.enabled && <span className="status-tag muted">已停用</span>}
					</div>
				</td>
				<td data-label="协议">
					<span className="model-protocol">
						{model.effective_protocol === "responses"
							? "Responses"
							: "Chat Completions"}
					</span>
				</td>
				<td data-label="普通文本">
					{status(textState)}
					{textSummary?.status === "failed" && (
						<button
							className="status-detail-link"
							type="button"
							onClick={() =>
								setShowRecord(showRecord === "text" ? null : "text")
							}
						>
							查看原因
						</button>
					)}
				</td>
				<td data-label="流式">
					{status(streamState)}
					{streamSummary?.status === "failed" && (
						<button
							className="status-detail-link"
							type="button"
							onClick={() =>
								setShowRecord(showRecord === "stream" ? null : "stream")
							}
						>
							查看原因
						</button>
					)}
				</td>
				<td data-label="结构化（暂未开放验证）">{status("unknown")}</td>
				<td data-label="最近验证" className="model-last-verified">
					{latest ? <TimeStamp value={latest.created_at} /> : "—"}
				</td>
				<td data-label="操作" className="model-actions">
					<div className="actions">
						<ActionMenu
							className="verification-menu action-menu"
							label={`${model.model_id} 可用性验证`}
							glyph="可用性验证 ▾"
						>
							<button
								type="button"
								disabled={
									!providerEnabled || !model.enabled || busy || verify.isPending
								}
								onClick={(event) => {
									event.currentTarget
										.closest("details")
										?.removeAttribute("open");
									startVerification(["text"]);
								}}
							>
								验证普通文本
							</button>
							<button
								type="button"
								disabled={
									!providerEnabled || !model.enabled || busy || verify.isPending
								}
								onClick={(event) => {
									event.currentTarget
										.closest("details")
										?.removeAttribute("open");
									startVerification(["stream"]);
								}}
							>
								验证流式文本
							</button>
							<button
								type="button"
								disabled={
									!providerEnabled || !model.enabled || busy || verify.isPending
								}
								onClick={(event) => {
									event.currentTarget
										.closest("details")
										?.removeAttribute("open");
									startVerification(["text", "stream"]);
								}}
							>
								重新验证两项（2 次调用）
							</button>
						</ActionMenu>
						<ActionMenu
							className="model-menu action-menu"
							label={`${model.model_id} 更多操作`}
						>
							<button
								type="button"
								onClick={(event) => {
									event.currentTarget
										.closest("details")
										?.removeAttribute("open");
									setEditing(true);
								}}
							>
								模型设置
							</button>
						</ActionMenu>
					</div>
				</td>
			</tr>
			{(editing || showRecord || verify.error) && (
				<tr className="model-detail-row">
					<td colSpan={7}>
						<div className="verification-detail">
							<InlineError error={verify.error} />
							{showRecord &&
								(showRecord === "text" ? textSummary : streamSummary) && (
									<RunDetail
										id={
											(showRecord === "text" ? textSummary : streamSummary)
												?.id ?? ""
										}
									/>
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
					</td>
				</tr>
			)}
		</>
	);
}
