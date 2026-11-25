import { summarizeEpubImportWarnings } from "./epub-import-warnings";

export function BookImportWarnings({
	warnings,
	className,
}: {
	warnings: readonly string[];
	className?: string;
}) {
	if (warnings.length === 0) return null;
	const uniqueWarnings = [...new Set(warnings)];
	const notices = summarizeEpubImportWarnings(uniqueWarnings);
	return (
		<details className={className}>
			<summary>导入提示</summary>
			<ul>
				{notices.map((notice) => (
					<li key={notice}>{notice}</li>
				))}
			</ul>
			<details>
				<summary>技术信息</summary>
				<ul>
					{uniqueWarnings.map((warning) => (
						<li key={warning}>{warning}</li>
					))}
				</ul>
			</details>
		</details>
	);
}
