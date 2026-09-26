import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { InlineError, Loading, Shell } from "../Shared";
import { getProviders, getSettings, settingsKeys } from "./api";
import { LearningSettings } from "./LearningSettings";
import { ProviderSettings } from "./ProviderSettings";
import { RunHistory } from "./RunHistory";

export function SettingsPage() {
	const settings = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
	});
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
	});
	if (settings.isPending || providers.isPending) return <Loading />;
	return (
		<Shell>
			<nav className="breadcrumb" aria-label="位置">
				<Link to="/">来源目录</Link>
				<span aria-hidden="true">/</span>
				<span aria-current="page">设置</span>
			</nav>
			<div className="page-heading">
				<div>
					<p className="eyebrow">SETTINGS</p>
					<h1>学习与模型设置</h1>
					<p>保存学习背景、讲解习惯，以及本地模型接入。</p>
				</div>
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
			{settings.isSuccess && providers.isSuccess && (
				<>
					<LearningSettings
						settings={settings.data}
						providers={providers.data}
					/>
					<ProviderSettings providers={providers.data} />
				</>
			)}
			<RunHistory />
		</Shell>
	);
}
