import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { InlineError, Loading, Shell } from "../Shared";
import { getProviders, getSettings, settingsKeys } from "./api";
import { LearningSettings } from "./LearningSettings";
import { ProviderSettings } from "./ProviderSettings";
import { RunHistory } from "./RunHistory";

export function SettingsPage() {
	const [searchParams] = useSearchParams();
	const learning = searchParams.get("section") === "learning";
	const settings = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
	});
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
	if (settings.isPending || providers.isPending) return <Loading />;
	return (
		<Shell>
			<div className="page-heading settings-page-heading">
				<h1>设置</h1>
				<nav className="settings-nav" aria-label="设置分类">
					<Link
						to="/settings?section=learning"
						aria-current={learning ? "page" : undefined}
					>
						学习偏好
					</Link>
					<Link to="/settings" aria-current={!learning ? "page" : undefined}>
						模型接入
					</Link>
				</nav>
			</div>
			{settings.isError ? (
				<div className="state-card">
					<InlineError error={settings.error} />
					<button
						className="button secondary"
						type="button"
						onClick={() => void settings.refetch()}
					>
						重试设置
					</button>
				</div>
			) : null}
			{providers.isError ? (
				<div className="state-card">
					<InlineError error={providers.error} />
					<button
						className="button secondary"
						type="button"
						onClick={() => void providers.refetch()}
					>
						重试 Provider
					</button>
				</div>
			) : null}
			{learning && settings.isSuccess && providers.isSuccess && (
				<LearningSettings settings={settings.data} providers={providers.data} />
			)}
			{!learning && providers.isSuccess && (
				<ProviderSettings providers={providers.data} />
			)}
			{!learning && <RunHistory />}
		</Shell>
	);
}
