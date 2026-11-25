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
			setCopyStatus(`已复制${label}路径`);
		} catch {
			setCopyStatus("复制失败，请选择上方路径后手动复制。");
		} finally {
			setCopying(false);
		}
	}
	return (
		<section aria-labelledby="data-location-heading">
			<div className="settings-page-head">
				<h2 id="data-location-heading">数据目录</h2>
				<p>查看当前应用存放本地数据的路径。</p>
			</div>
			<p className="settings-hint settings-section-note">
				书籍、学习记录和离线词典均保存在此处，升级应用不会移动这些文件。
			</p>
			{location.isPending && (
				<p className="settings-loading" role="status">
					正在加载数据目录…
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
						重试
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
									aria-label={`复制${label}路径`}
									disabled={copying}
									onClick={() => void copyPath(path, label)}
								>
									复制路径
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
