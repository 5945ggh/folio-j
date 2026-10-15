import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { errorMessage, requireData } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import { type Model, type Provider, settingsKeys } from "./api";
import { summarizeProvider } from "./provider-presentation";
import { useProviderDiscovery } from "./providers/ProviderDiscovery";
import { ModelEditor, ProviderEditor } from "./providers/ProviderEditors";
import { ProviderModels } from "./providers/ProviderModels";
import { RunHistory } from "./RunHistory";
import { useSettingsDraft } from "./SettingsForms";
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
			kind:
				| "provider"
				| "key"
				| "add-model"
				| "delete-provider"
				| "close-selection";
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
	const discovery = useProviderDiscovery(provider);
	useSettingsDraft({
		id: `provider-discovery-${provider.id}`,
		label: `${provider.name} 的模型登记`,
		dirty: discovery.selected.length > 0,
		pending: discovery.registering,
		save: discovery.registerSelected,
		discard: discovery.clear,
	});
	function requestClose() {
		if (discovery.registering) return;
		if (discovery.selected.length > 0) setEditor({ kind: "close-selection" });
		else onClose();
	}
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
	if (editor?.kind === "close-selection")
		return (
			<ConfirmDialog
				key="close-provider-selection"
				className="settings-dialog provider-delete-dialog"
				titleId={`close-provider-${provider.id}`}
				onClose={() => {
					if (!discovery.registering) returnToDetail();
				}}
			>
				<h2 id={`close-provider-${provider.id}`}>还有尚未登记的模型</h2>
				<p>可以登记所选模型后关闭，或放弃这次选择。</p>
				<InlineError
					error={
						discovery.registrationError
							? new Error(discovery.registrationError)
							: null
					}
				/>
				<div className="settings-actions">
					<button
						type="button"
						className="settings-button primary"
						disabled={discovery.registering}
						onClick={async () => {
							if (await discovery.registerSelected()) onClose();
							else returnToDetail();
						}}
					>
						{discovery.registering ? "登记中…" : "登记并关闭"}
					</button>
					<button
						type="button"
						className="settings-button danger"
						disabled={discovery.registering}
						onClick={() => {
							discovery.clear();
							onClose();
						}}
					>
						放弃选择
					</button>
					<button
						type="button"
						className="settings-button secondary"
						data-dialog-cancel
						disabled={discovery.registering}
						onClick={returnToDetail}
					>
						返回服务详情
					</button>
				</div>
			</ConfirmDialog>
		);
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
				providerId={provider.id}
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
			onClose={requestClose}
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
					disabled={discovery.registering}
					onClick={requestClose}
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
					discovery={discovery}
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
					<dl className="provider-connection-list">
						<div>
							<dt>名称</dt>
							<dd>{provider.name}</dd>
						</div>
						<div>
							<dt>API 地址</dt>
							<dd>{provider.base_url}</dd>
						</div>
						<div>
							<dt>默认协议</dt>
							<dd>{protocolName(provider.protocol)}</dd>
						</div>
						<div>
							<dt>API Key</dt>
							<dd>{provider.has_api_key ? "已配置" : "未配置（可选）"}</dd>
						</div>
						<div>
							<dt>服务状态</dt>
							<dd>{provider.enabled ? "已启用" : "已停用"}</dd>
						</div>
					</dl>
					<div className="settings-actions">
						<button
							className="settings-button secondary"
							type="button"
							disabled={discovery.registering || toggle.isPending}
							onClick={() => setEditor({ kind: "provider" })}
						>
							编辑连接
						</button>
						<button
							className="settings-button secondary"
							type="button"
							disabled={discovery.registering || toggle.isPending}
							onClick={() => setEditor({ kind: "key" })}
						>
							更新 API Key
						</button>
						<button
							className="settings-button secondary"
							type="button"
							disabled={discovery.registering || toggle.isPending}
							onClick={() => toggle.mutate()}
						>
							{toggle.isPending
								? "更新中…"
								: provider.enabled
									? "停用服务"
									: "启用服务"}
						</button>
					</div>
					<InlineError error={toggle.error} />
					<div className="provider-danger-zone">
						<div>
							<strong>删除服务</strong>
							<p className="settings-hint">
								同时删除登记模型，引用它们的用途默认值将失效。历史验证记录会保留。
							</p>
						</div>
						<button
							className="settings-button danger"
							type="button"
							disabled={discovery.registering || toggle.isPending}
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
				<RunHistory providerId={provider.id} providers={[provider]} />
			)}
		</ConfirmDialog>
	);
}
