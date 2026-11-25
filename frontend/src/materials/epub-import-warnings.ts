const warningLabels: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/^(图片无法读取或格式不受支持|Removed unsupported image)/,
		"部分图片无法显示，已跳过",
	],
	[/^(固定版式的图片页|Fixed image page)/, "固定版式的图片页已按普通图片显示"],
	[
		/^(样式|Unsupported CSS import|Skipped CSS import|Unterminated CSS import|Skipped unavailable stylesheet)/,
		"部分样式无法使用，页面外观可能与原书不同",
	],
	[
		/^(目录|备用目录|EPUB (nav|NCX)|nav 目录|spine 重复资源|没有有效目录)/,
		"已根据可用的目录和正文调整章节划分",
	],
];

export function summarizeEpubImportWarnings(warnings: readonly string[]) {
	return [
		...new Set(
			warnings.map(
				(warning) =>
					warningLabels.find(([pattern]) => pattern.test(warning))?.[1] ??
					"部分 EPUB 内容已按兼容方式处理",
			),
		),
	];
}
