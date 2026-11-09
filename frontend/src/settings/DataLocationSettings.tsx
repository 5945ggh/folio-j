import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { InlineError } from "../Shared";
import { getDataLocation } from "./data-location-api";

export function DataLocationSettings() {
	const location = useQuery({
		queryKey: ["data-location"],
		queryFn: ({ signal }) => getDataLocation(signal),
	});
	const [copyStatus, setCopyStatus] = useState("");
	const [copying, setCopying] = useState(false);
	async function copyPath(path: string, label: string) {
		setCopyStatus("");
		setCopying(true);
		try {
			await navigator.clipboard.writeText(path);
			setCopyStatus(`已复制${label}。`);
		} catch {
			setCopyStatus("复制失败，请选择上方路径后手动复制。");
		} finally {
			setCopying(false);
		}
	}
	return (
		<section aria-labelledby="data-location-heading">
			<div className="settings-page-head">
				<h2 id="data-location-heading">数据位置</h2>
				<p>查看本次运行实际使用的数据位置。</p>
			</div>
			<p className="settings-hint settings-section-note">
				书籍、学习记录、词典等保存在这里。更新完整程序目录不会搬动这些数据。
			</p>
			{location.isPending && (
				<p className="settings-loading" role="status">
					正在读取数据位置…
				</p>
			)}
			{location.isError ? (
				<div className="settings-state">
					<InlineError error={location.error} />
					<button
						className="settings-button secondary"
						type="button"
						disabled={location.isFetching}
						onClick={() => void location.refetch()}
					>
						重试读取数据位置
					</button>
				</div>
			) : location.data ? (
				<dl className="settings-group data-location-paths">
					{(
						[
							["数据目录", location.data.data_directory],
							["数据库文件", location.data.database_path],
						] as const
					).map(([label, path]) => (
						<div className="data-location-row" key={label}>
							<dt>{label}</dt>
							<dd>
								<code className="data-location-path" dir="ltr">
									{path}
								</code>
								<button
									className="settings-button secondary"
									type="button"
									disabled={copying}
									onClick={() => void copyPath(path, label)}
								>
									复制{label}路径
								</button>
							</dd>
						</div>
					))}
				</dl>
			) : null}
			<p className="settings-hint" role="status" aria-live="polite">
				{copyStatus}
			</p>
		</section>
	);
}
