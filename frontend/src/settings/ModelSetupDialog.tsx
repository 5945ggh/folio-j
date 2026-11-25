import { useQuery } from "@tanstack/react-query";
import { ConfirmDialog, InlineError } from "../Shared";
import { getProviders, settingsKeys } from "./api";
import { ProviderSettings } from "./ProviderSettings";
import { SettingsDraftProvider } from "./SettingsForms";
import "./settings-refresh.css";
import "./model-setup.css";

const restoreFocusIds = ["explanation-model", "chat-question"];

/** Configure the existing service library without leaving the current discussion. */
export function ModelSetupDialog({ onClose }: { onClose: () => void }) {
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
		refetchInterval: (query) =>
			query.state.data?.some((provider) =>
				provider.models.some((model) =>
					[model.text_verification, model.stream_verification].some(
						(run) => run?.status === "queued" || run?.status === "running",
					),
				),
			)
				? 1500
				: false,
	});
	return (
		<div className="settings-page">
			<SettingsDraftProvider>
				<ConfirmDialog
					titleId="model-setup-title"
					className="settings-dialog model-setup-dialog"
					onClose={onClose}
					restoreFocusId={restoreFocusIds}
				>
					<div className="settings-dialog-heading">
						<h2 id="model-setup-title">配置模型服务</h2>
						<button
							type="button"
							className="settings-button secondary"
							aria-label="关闭模型服务配置"
							data-dialog-cancel
							onClick={onClose}
						>
							×
						</button>
					</div>
					<p className="settings-hint">
						在模型服务中添加或启用模型，再返回对话选择。
					</p>
					{providers.isPending && <p role="status">正在加载模型服务…</p>}
					{providers.isError && (
						<div className="settings-state">
							<InlineError error={providers.error} />
							<button
								type="button"
								className="settings-button secondary"
								onClick={() => void providers.refetch()}
							>
								重试
							</button>
						</div>
					)}
					{providers.data && <ProviderSettings providers={providers.data} />}
					<div className="settings-actions">
						<button
							type="button"
							className="settings-button secondary"
							onClick={onClose}
						>
							返回对话
						</button>
					</div>
				</ConfirmDialog>
			</SettingsDraftProvider>
		</div>
	);
}
