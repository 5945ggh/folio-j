import "./settings-refresh.css";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { InlineError, Shell } from "../Shared";
import { DeviceSpeechSettings } from "../speech";
import { AppearanceSettings } from "../theme/AppearanceSettings";
import { TranslationSettingsSection } from "../translation/TranslationSettings";
import { getProviders, getSettings, settingsKeys } from "./api";
import { DictionarySettings } from "./DictionarySettings";
import { LearningSettings } from "./LearningSettings";
import { ModelDefaults } from "./ModelDefaults";
import { PermissionSettings } from "./PermissionSettings";
import { ProviderSettings } from "./ProviderSettings";
import { RunHistory } from "./RunHistory";
import { SettingsDraftProvider } from "./SettingsForms";

export function SettingsPage() {
	const [searchParams] = useSearchParams();
	const section = searchParams.get("section");
	const learning = section === "learning";
	const permissions = section === "permissions";
	const history = section === "history";
	const translation = section === "translation";
	const speech = section === "speech";
	const appearance = section === "appearance";
	const dictionary = section === "dictionary";
	const models =
		!learning &&
		!permissions &&
		!translation &&
		!speech &&
		!appearance &&
		!dictionary;
	const services = section === "providers";
	const settings = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
		enabled: !appearance && !dictionary,
	});
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
		enabled: models,
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
		<Shell className="library-a1 settings-page">
			<SettingsDraftProvider>
				<header className="settings-topbar">
					<h1>设置</h1>
				</header>
				<nav className="settings-tabs" aria-label="设置分类">
					<Link
						to="/settings?section=learning"
						aria-current={learning ? "page" : undefined}
					>
						学习偏好
					</Link>
					<Link to="/settings" aria-current={models ? "page" : undefined}>
						模型与服务
					</Link>
					<Link
						to="/settings?section=appearance"
						aria-current={appearance ? "page" : undefined}
					>
						外观
					</Link>
					<Link
						to="/settings?section=permissions"
						aria-current={permissions ? "page" : undefined}
					>
						对话与权限
					</Link>
					<Link
						to="/settings?section=dictionary"
						aria-current={dictionary ? "page" : undefined}
					>
						词典
					</Link>
					<Link
						to="/settings?section=translation"
						aria-current={translation ? "page" : undefined}
					>
						翻译
					</Link>
					<Link
						to="/settings?section=speech"
						aria-current={speech ? "page" : undefined}
					>
						设备朗读
					</Link>
				</nav>
				<div className="settings-content">
					{dictionary ? (
						<DictionarySettings />
					) : history ? (
						<>
							<ModelSettingsNavigation services />
							<Link
								className="settings-back-link"
								to="/settings?section=providers"
							>
								← 返回服务管理
							</Link>
							<div className="settings-page-head">
								<h2>验证历史</h2>
								<p>查看模型连接验证的运行状态与结果。</p>
							</div>
							<RunHistory providers={providers.data} />
						</>
					) : (
						<>
							<div className="settings-page-head">
								<h2>
									{appearance
										? "外观"
										: translation
											? "翻译"
											: speech
												? "设备朗读"
												: learning
													? "学习偏好"
													: permissions
														? "对话与权限"
														: "模型与服务"}
								</h2>
								<p>
									{appearance
										? "选择适合当前环境的颜色模式。"
										: translation
											? "管理独立翻译方案与语境。"
											: speech
												? "选择当前浏览器提供的日语声音。"
												: learning
													? "让讲解适合你的学习背景和阅读习惯。"
													: permissions
														? "设置新对话使用工具时的默认权限。"
														: "选择任务默认模型，管理接入的模型服务。"}
								</p>
							</div>
							{models && <ModelSettingsNavigation services={services} />}
							{!appearance && !services && settings.isPending && (
								<p className="settings-loading" role="status">
									正在加载设置…
								</p>
							)}
							{!appearance && !services && settings.isError && (
								<section className="settings-state">
									<InlineError error={settings.error} />
									<button
										className="settings-button secondary"
										type="button"
										onClick={() => void settings.refetch()}
									>
										重试设置
									</button>
								</section>
							)}
							{appearance && <AppearanceSettings />}
							{translation && <TranslationSettingsSection />}
							{speech && <DeviceSpeechSettings />}
							{learning && settings.data && (
								<LearningSettings settings={settings.data} />
							)}
							{permissions && settings.data && (
								<PermissionSettings settings={settings.data} />
							)}
							{models && (
								<>
									{providers.isPending && (
										<p className="settings-loading" role="status">
											正在加载模型服务…
										</p>
									)}
									{providers.isError && (
										<section className="settings-state">
											<InlineError error={providers.error} />
											<button
												className="settings-button secondary"
												type="button"
												onClick={() => void providers.refetch()}
											>
												重试模型服务
											</button>
										</section>
									)}
									{providers.data &&
										(services ? (
											<>
												<ProviderSettings providers={providers.data} />
												<div className="settings-tools-footer">
													<span className="settings-hint">
														验证按实际调用记录保留。
													</span>
													<Link to="/settings?section=history">
														查看验证历史 →
													</Link>
												</div>
											</>
										) : (
											<ModelDefaults
												settings={settings.data}
												providers={providers.data}
											/>
										))}
								</>
							)}
						</>
					)}
				</div>
			</SettingsDraftProvider>
		</Shell>
	);
}

function ModelSettingsNavigation({ services }: { services: boolean }) {
	return (
		<nav className="settings-subnav" aria-label="模型与服务分类">
			<Link to="/settings" aria-current={!services ? "page" : undefined}>
				默认模型
			</Link>
			<Link
				to="/settings?section=providers"
				aria-current={services ? "page" : undefined}
			>
				服务管理
			</Link>
		</nav>
	);
}
