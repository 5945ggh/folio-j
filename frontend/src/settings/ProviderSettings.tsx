import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api/client";
import { errorMessage, requireData } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import { type Model, type Provider, settingsKeys } from "./api";
import { summarizeProvider } from "./provider-presentation";
import { ModelEditor, ProviderEditor } from "./providers/ProviderEditors";
import { ProviderModels } from "./providers/ProviderModels";
import { RunHistory } from "./RunHistory";
import "./provider-settings.css";

const protocolName = (protocol: Provider["protocol"]) =>
	protocol === "responses" ? "Responses" : "Chat Completions";

export function ProviderSettings({ providers }: { providers: Provider[] }) {
	const [creating, setCreating] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const provider = providers.find((item) => item.id === selected);
	return (
		<section
			className="settings-section provider-settings"
			aria-labelledby="providers-heading"
		>
			<div className="provider-section-heading">
				<h2 id="providers-heading">模型服务</h2>
				<button
					className="settings-button secondary"
					type="button"
					onClick={() => setCreating(true)}
				>
					添加服务
				</button>
			</div>
			<p className="settings-hint">
				{providers.length} 个服务 ·{" "}
				{providers.reduce((count, item) => count + item.models.length, 0)}{" "}
				个已登记模型
			</p>
			<div className="provider-service-list">
				{providers.map((item) => {
					const summary = summarizeProvider(item);
					return (
						<button
							id={`provider-open-${item.id}`}
							className="provider-service-summary"
							key={item.id}
							type="button"
							onClick={() => setSelected(item.id)}
						>
							<span className="provider-service-mark" aria-hidden="true">
								{item.name.slice(0, 1).toUpperCase()}
							</span>
							<span className="provider-service-main">
								<strong>{item.name}</strong>
								<small>
									{protocolName(item.protocol)} · {item.models.length} 个模型
								</small>
							</span>
							<span className={`provider-health ${summary.tone}`}>
								{summary.label}
							</span>
							<span className="provider-service-arrow" aria-hidden="true">
								›
							</span>
						</button>
					);
				})}
				{providers.length === 0 && (
					<div className="provider-empty">
						<p>还没有模型服务。</p>
						<p className="settings-hint">
							添加 API 地址与凭据后，可以发现模型或手动登记模型 ID。
						</p>
					</div>
				)}
			</div>
			{creating && (
				<ProviderEditor
					onClose={() => setCreating(false)}
					onCreated={(saved) => {
						setSelected(saved.id);
					}}
				/>
			)}
			{!creating && provider && (
				<ProviderDetail
					key={provider.id}
					provider={provider}
					onClose={() => setSelected(null)}
				/>
			)}
		</section>
	);
}

type ProviderView = "models" | "connection" | "history";
type Editor =
	| {
			kind: "provider" | "key" | "add-model" | "delete-provider";
	  }
	| { kind: "model" | "delete-model"; model: Model };

function ProviderDetail({
	provider,
	onClose,
}: {
	provider: Provider;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [view, setView] = useState<ProviderView>("models");
	const [editor, setEditor] = useState<Editor | null>(null);
	const modelsTab = useRef<HTMLButtonElement>(null);
	const toggle = useMutation({
		mutationFn: async (enabled: boolean) => {
			const { data, error, response } = await api.PATCH(
				"/api/providers/{provider_id}",
				{
					params: { path: { provider_id: provider.id } },
					body: { enabled },
				},
			);
			return requireData(data, error, response.status);
		},
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	const remove = useMutation({
		mutationFn: async (model?: Model) => {
			const { error, response } = model
				? await api.DELETE("/api/provider-models/{model_id}", {
						params: { path: { model_id: model.id } },
					})
				: await api.DELETE("/api/providers/{provider_id}", {
						params: { path: { provider_id: provider.id } },
					});
			if (!response.ok) throw errorMessage(error, response.status);
		},
		onSuccess: (_data, model) => {
			setEditor(null);
			if (!model) onClose();
			void client.invalidateQueries({ queryKey: settingsKeys.providers });
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	const returnToDetail = () => setEditor(null);
	if (editor?.kind === "provider" || editor?.kind === "key")
		return (
			<ProviderEditor
				provider={provider}
				keyOnly={editor.kind === "key"}
				onClose={returnToDetail}
			/>
		);
	if (editor?.kind === "model" || editor?.kind === "add-model")
		return (
			<ModelEditor
				model={editor.kind === "model" ? editor.model : undefined}
				provider={provider}
				onClose={returnToDetail}
			/>
		);
	if (editor?.kind === "delete-provider" || editor?.kind === "delete-model") {
		const model = editor.kind === "delete-model" ? editor.model : undefined;
		return (
			<ConfirmDialog
				key={`delete-${model?.id ?? provider.id}`}
				className="settings-dialog provider-delete-dialog"
				titleId={`delete-provider-item-${provider.id}`}
				onClose={() => {
					if (!remove.isPending) returnToDetail();
				}}
				restoreFocusId={`provider-open-${provider.id}`}
			>
				<h2 id={`delete-provider-item-${provider.id}`}>
					删除「{model?.model_id ?? provider.name}」？
				</h2>
				<p>
					{model
						? "删除此模型登记，保留历史验证记录。使用它的用途默认值将失效，需要重新选择；不会自动改用其他模型。"
						: "此服务及其登记的模型将被删除。引用这些模型的讲解、讨论和条目整理默认值将失效，需要重新选择；不会自动改用其他模型。历史验证记录会保留。"}
				</p>
				<InlineError error={remove.error} />
				<div className="settings-actions">
					<button
						className="settings-button danger"
						type="button"
						disabled={remove.isPending}
						onClick={() => remove.mutate(model)}
					>
						{remove.isPending ? "删除中…" : "确认删除"}
					</button>
					<button
						className="settings-button secondary"
						type="button"
						data-dialog-cancel
						disabled={remove.isPending}
						onClick={returnToDetail}
					>
						返回服务详情
					</button>
				</div>
			</ConfirmDialog>
		);
	}
	return (
		<ConfirmDialog
			key="provider-detail"
			className="settings-dialog provider-detail-dialog"
			titleId={`provider-detail-${provider.id}`}
			onClose={onClose}
			restoreFocusId={`provider-open-${provider.id}`}
		>
			<div className="settings-dialog-heading">
				<div>
					<h2 id={`provider-detail-${provider.id}`}>{provider.name}</h2>
					<p className="settings-hint">
						{protocolName(provider.protocol)} · {provider.models.length} 个模型
						· {provider.enabled ? "服务已启用" : "服务已停用"}
					</p>
				</div>
				<button
					className="settings-button secondary"
					type="button"
					aria-label="关闭服务详情"
					data-dialog-cancel
					onClick={onClose}
				>
					×
				</button>
			</div>
			<nav
				className="provider-detail-tabs"
				aria-label={`${provider.name} 详情分类`}
			>
				{(
					[
						["models", "模型"],
						["connection", "连接设置"],
						["history", "验证记录"],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						ref={key === "models" ? modelsTab : undefined}
						className={view === key ? "is-current" : ""}
						type="button"
						aria-current={view === key ? "page" : undefined}
						onClick={() => setView(key)}
					>
						{label}
					</button>
				))}
			</nav>
			<div hidden={view !== "models"}>
				<ProviderModels
					provider={provider}
					onAdd={() => setEditor({ kind: "add-model" })}
					onEdit={(model) => setEditor({ kind: "model", model })}
					onDelete={(model) => {
						remove.reset();
						setEditor({ kind: "delete-model", model });
					}}
				/>
			</div>
			{view === "connection" && (
				<div className="provider-connection-view">
					<section aria-labelledby="provider-connection-title">
						<div className="provider-section-heading">
							<h3 id="provider-connection-title">连接信息</h3>
							<button
								type="button"
								className="settings-button secondary"
								disabled={toggle.isPending}
								onClick={() => setEditor({ kind: "provider" })}
							>
								编辑连接
							</button>
						</div>
						<dl className="settings-group provider-connection-list">
							<div>
								<dt>API 地址</dt>
								<dd>{provider.base_url}</dd>
							</div>
							<div>
								<dt>默认协议</dt>
								<dd>{protocolName(provider.protocol)}</dd>
							</div>
						</dl>
					</section>
					<section aria-labelledby="provider-key-title">
						<h3 className="provider-block-title" id="provider-key-title">
							访问密钥
						</h3>
						<div className="settings-group provider-option-row">
							<div>
								<strong>API Key</strong>
								<span className="settings-hint">
									{provider.has_api_key ? "已配置" : "未配置"}
								</span>
							</div>
							<button
								type="button"
								className="settings-button secondary"
								disabled={toggle.isPending}
								onClick={() => setEditor({ kind: "key" })}
							>
								{provider.has_api_key ? "更换密钥" : "添加密钥"}
							</button>
						</div>
					</section>
					<section aria-labelledby="provider-management-title">
						<h3 className="provider-block-title" id="provider-management-title">
							服务管理
						</h3>
						<label className="settings-group provider-option-row">
							<span>
								<strong>启用此服务</strong>
								<small className="settings-hint">
									停用后，此服务下的模型将无法用于新请求。
								</small>
							</span>
							<input
								type="checkbox"
								role="switch"
								className="learning-context-switch"
								aria-checked={provider.enabled}
								checked={provider.enabled}
								disabled={toggle.isPending}
								onChange={(e) => toggle.mutate(e.target.checked)}
							/>
						</label>
					</section>
					<InlineError error={toggle.error} />
					<div className="provider-danger-zone">
						<button
							className="settings-button danger"
							type="button"
							disabled={toggle.isPending}
							onClick={() => {
								remove.reset();
								setEditor({ kind: "delete-provider" });
							}}
						>
							删除服务
						</button>
					</div>
				</div>
			)}
			{view === "history" && (
				<RunHistory
					providerId={provider.id}
					providers={[provider]}
					onShowModels={() => {
						setView("models");
						modelsTab.current?.focus();
					}}
				/>
			)}
		</ConfirmDialog>
	);
}
