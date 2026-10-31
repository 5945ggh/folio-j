import { InlineError } from "../../Shared";
import type { Provider } from "../api";
import type { ProviderDiscovery } from "./ProviderDiscovery";

export function DiscoveredModelList({
	provider,
	discovery,
}: {
	provider: Provider;
	discovery: ProviderDiscovery;
}) {
	const ids = [...new Set(provider.discovered_models)];
	const { refresh, selected, registering } = discovery;
	return (
		<div className="provider-discovery">
			<div className="provider-section-heading">
				<p className="settings-hint">
					{ids.length
						? `共 ${ids.length} 个模型，${discovery.available.length} 个可登记`
						: "从服务获取可登记的模型 ID。"}
					{provider.last_discovered_at && (
						<small className="provider-fetch-date">
							最近获取{" "}
							<time dateTime={provider.last_discovered_at}>
								{new Date(provider.last_discovered_at).toLocaleString("zh-CN", {
									dateStyle: "medium",
									timeStyle: "short",
								})}
							</time>
						</small>
					)}
				</p>
				<button
					type="button"
					className="settings-button secondary"
					disabled={refresh.isPending || registering}
					onClick={() => refresh.mutate()}
				>
					{refresh.isPending
						? "获取中…"
						: ids.length
							? "刷新列表"
							: "获取模型列表"}
				</button>
			</div>
			{provider.discovery_status === "failed" && (
				<p className="provider-warning" role="status">
					{ids.length
						? "获取失败，当前显示上次的列表。"
						: "暂时无法获取列表，可以重试或手动填写模型 ID。"}{" "}
					{provider.discovery_error}
				</p>
			)}
			<InlineError error={refresh.error} />
			{ids.length > 0 && (
				<div className="provider-discovery-list">
					{ids.map((id) => {
						const registered = provider.models.some(
							(model) => model.model_id === id,
						);
						return (
							<label key={id} className="provider-discovery-item">
								<input
									type="checkbox"
									disabled={registered || registering || refresh.isPending}
									checked={registered || selected.includes(id)}
									onChange={(event) =>
										discovery.select(id, event.target.checked)
									}
								/>
								<span>{id}</span>
								{registered && <small>已登记</small>}
							</label>
						);
					})}
				</div>
			)}
			{provider.discovery_status === "succeeded" && !ids.length && (
				<p className="settings-hint">
					服务返回了空列表。知道模型 ID 时，可以切换到手动填写。
				</p>
			)}
			{discovery.registrationError && (
				<p className="provider-warning" role="alert">
					{discovery.registrationError}
				</p>
			)}
		</div>
	);
}
