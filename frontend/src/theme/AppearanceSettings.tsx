import { useAppTheme } from "./browser";

export function AppearanceSettings() {
	const theme = useAppTheme();
	return (
		<section className="settings-section" aria-labelledby="appearance-heading">
			<div className="settings-section-heading">
				<h3 id="appearance-heading">应用外观</h3>
			</div>
			<div className="settings-group">
				<label className="settings-preference-row">
					<span className="settings-row-copy">
						<strong>颜色模式</strong>
						<small>仅保存在当前浏览器，选择后立即生效。</small>
					</span>
					<select
						className="settings-control"
						aria-label="应用颜色模式"
						value={theme.preference}
						onChange={(event) => {
							const value = event.target.value;
							if (value === "light" || value === "dark" || value === "system")
								theme.select(value);
						}}
					>
						<option value="light">浅色</option>
						<option value="dark">深色</option>
						<option value="system">跟随系统</option>
					</select>
				</label>
				<p className="settings-appearance-note settings-hint">
					阅读器的纸面颜色仍在阅读设置中单独选择。
				</p>
			</div>
			{theme.storageFailed && (
				<p className="settings-hint" role="status">
					当前选择已生效，但浏览器未能保存；关闭页面后可能恢复默认。
				</p>
			)}
		</section>
	);
}
