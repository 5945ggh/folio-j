import { useEffect, useId, useState } from "react";
import type { Chapter } from "./api";
import { buildContextCopy, type ContextCopyPreferences } from "./context-copy";
import "./context-copy.css";

type BudgetField = Exclude<keyof ContextCopyPreferences, "include_source">;

const exampleBefore = "朝、窓を開けた。風が頬に触れた。庭の花が揺れていた。";
const exampleTarget = "今日はいい天気だ。";
const exampleAfter = "私は外へ出た。遠くで鳥が鳴いていた。";
const exampleText = exampleBefore + exampleTarget + exampleAfter;
const exampleHash = "a".repeat(64);
const exampleChapter: Chapter = {
	id: "example-chapter",
	material_id: "example-material",
	version_id: "example-version",
	title: "第一章",
	level: 0,
	resources: [
		{
			id: "example-resource",
			text: exampleText,
			text_sha256: exampleHash,
			href: "example.xhtml",
			css: "",
			html_attributes: {},
			body_attributes: {},
		},
	],
	parts: [
		{
			resource_id: "example-resource",
			spine_index: 0,
			start: 0,
			end: Array.from(exampleText).length,
			html: "",
			leaf_start: 0,
			leaf_end: 1,
		},
	],
};
const exampleReference: Parameters<typeof buildContextCopy>[1] = {
	contract_version: "1",
	material_id: exampleChapter.material_id,
	version_id: exampleChapter.version_id,
	ranges: [
		{
			resource_id: "example-resource",
			spine_index: 0,
			start: Array.from(exampleBefore).length,
			end: Array.from(exampleBefore + exampleTarget).length,
			exact: exampleTarget,
			text_sha256: exampleHash,
			prefix: "",
			suffix: "",
		},
	],
};

function BudgetInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	const hintId = useId();
	useEffect(() => setDraft(String(value)), [value]);
	const valid = /^\d+$/.test(draft) && Number(draft) <= 100000;
	const commit = () => {
		if (valid) onChange(Number(draft));
		setDraft(String(valid ? Number(draft) : value));
	};
	return (
		<div className="reader-copy-budget">
			<label>
				<span>{label}</span>
				<input
					type="number"
					min="0"
					max="100000"
					step="1"
					inputMode="numeric"
					value={draft}
					aria-invalid={!valid || undefined}
					aria-describedby={!valid ? hintId : undefined}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDownCapture={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						} else if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							setDraft(String(value));
						}
					}}
				/>
			</label>
			{!valid && (
				<small id={hintId}>请输入 0–100000 的整数；无效输入不会保存。</small>
			)}
		</div>
	);
}

export function ReaderCopySettings({
	preferences,
	onChange,
}: {
	preferences: ContextCopyPreferences;
	onChange: (value: ContextCopyPreferences) => void;
}) {
	const field = (key: BudgetField, label: string) => (
		<BudgetInput
			label={label}
			value={preferences[key]}
			onChange={(value) => onChange({ ...preferences, [key]: value })}
		/>
	);
	return (
		<fieldset className="reader-copy-settings">
			<legend>
				带上下文复制<span className="reader-scope">当前浏览器 · 跨书</span>
			</legend>
			<p>
				设置自动保存在当前浏览器，对所有书籍生效。数字按 Enter
				或离开输入框后生效。
			</p>
			{field("before_sentences", "前文句数")}
			{field("after_sentences", "后文句数")}
			<p>句数设为 0 时，不附带该侧上下文。</p>
			<label>
				<span>附带出处</span>
				<input
					type="checkbox"
					checked={preferences.include_source}
					onChange={(event) =>
						onChange({ ...preferences, include_source: event.target.checked })
					}
				/>
			</label>
			<details className="reader-copy-advanced">
				<summary>高级：上下文字符上限</summary>
				{field("before_characters", "前文字符上限")}
				{field("after_characters", "后文字符上限")}
				<p>
					每侧同时受句数与字符上限约束；字符上限为 0
					时不附带该侧。选区原文始终完整保留。
				</p>
			</details>
			<details className="reader-copy-preview">
				<summary>格式示例</summary>
				<p>使用固定样例，随上述设置更新。</p>
				<pre>
					{
						buildContextCopy(
							exampleChapter,
							exampleReference,
							preferences,
							"示例书籍",
						).text
					}
				</pre>
			</details>
		</fieldset>
	);
}
