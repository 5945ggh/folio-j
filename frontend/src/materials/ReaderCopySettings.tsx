import { useId } from "react";
import {
	type BudgetField,
	parseCopyFields,
} from "../settings/context-copy-draft";
import type { Chapter } from "./api";
import { buildContextCopy } from "./context-copy";
import { ReaderSettingsReset } from "./ReaderSettingsReset";
import {
	contextCopySummary,
	type ReaderSettingsExpanded,
} from "./reader-settings";
import type { ReaderCopyEditor } from "./use-reader-copy-editor";
import "./context-copy.css";

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
	onBlur,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	onBlur: () => void;
}) {
	const hintId = useId();
	const valid = /^\d+$/.test(value) && Number(value) <= 100000;
	return (
		<div className="reader-copy-budget">
			<label>
				<span>{label}</span>
				<input
					type="number"
					required
					min="0"
					max="100000"
					step="1"
					inputMode="numeric"
					value={value}
					aria-invalid={!valid || undefined}
					aria-describedby={!valid ? hintId : undefined}
					onChange={(event) => onChange(event.target.value)}
					onBlur={onBlur}
				/>
			</label>
			{!valid && <small id={hintId}>请输入 0–100000 的整数。</small>}
		</div>
	);
}

export function ReaderCopySettings({
	editor,
	expanded,
	onExpandedChange,
}: {
	editor: ReaderCopyEditor;
	expanded: ReaderSettingsExpanded;
	onExpandedChange: (next: ReaderSettingsExpanded) => void;
}) {
	const fields = editor.fields;
	const preview = fields ? parseCopyFields(fields) : null;
	const setExpanded = (key: "copy" | "copyPreview", open: boolean) =>
		onExpandedChange({ ...expanded, [key]: open });
	const field = (key: BudgetField, label: string) =>
		fields && (
			<BudgetInput
				label={label}
				value={fields[key]}
				onChange={(value) => editor.change({ ...fields, [key]: value })}
				onBlur={() => {
					if (editor.dirty || editor.pending) void editor.save();
				}}
			/>
		);
	return (
		<section
			className="reader-settings-group reader-copy-settings"
			data-reader-settings-group="copy"
			aria-label="带上下文复制"
		>
			<ReaderSettingsReset
				label="复制设置"
				description="恢复复制默认值并自动保存。"
				disabled={!fields}
				onReset={() => editor.resetDefaults()}
			/>
			<details
				className="reader-settings-disclosure reader-copy-disclosure"
				open={expanded.copy}
				onToggle={(event) => {
					if (event.currentTarget.open !== expanded.copy)
						setExpanded("copy", event.currentTarget.open);
				}}
			>
				<summary>
					<span className="reader-settings-field-label">
						<span className="reader-settings-disclosure-label">
							带上下文复制
						</span>
						<span
							className="reader-settings-scope"
							data-tooltip="保存后用于资料库中的所有书籍；连接同一资料库的浏览器共用。"
						>
							所有书籍 · 资料库
						</span>
					</span>
					<span className="reader-settings-summary">
						{editor.query.data
							? `已保存 · ${contextCopySummary(editor.query.data)}`
							: "个人默认值"}
					</span>
				</summary>
				<div className="reader-settings-more">
					<p>
						有效设置自动保存，连接同一资料库的浏览器共用。复制使用最后成功保存的配置。
					</p>
					{fields && (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void editor.save();
							}}
						>
							<fieldset>
								<div className="reader-copy-budget-grid">
									{field("before_sentences", "前文句数")}
									{field("after_sentences", "后文句数")}
									{field("before_characters", "前文字符上限")}
									{field("after_characters", "后文字符上限")}
								</div>
								<p>
									每侧同时受句数与字符上限约束；任一设为 0
									时不附带该侧。选区原文始终完整保留。
								</p>
								<label className="reader-settings-toggle">
									<span>附带出处</span>
									<input
										type="checkbox"
										checked={fields.include_source}
										onChange={(event) =>
											editor.change(
												{
													...fields,
													include_source: event.target.checked,
												},
												true,
											)
										}
									/>
								</label>
								<details
									className="reader-settings-disclosure reader-copy-preview"
									open={expanded.copyPreview}
									onToggle={(event) => {
										if (event.currentTarget.open !== expanded.copyPreview)
											setExpanded("copyPreview", event.currentTarget.open);
									}}
								>
									<summary>格式示例</summary>
									<div className="reader-settings-more">
										<p>固定样例 · 使用当前输入</p>
										{preview ? (
											<pre>
												{
													buildContextCopy(
														exampleChapter,
														exampleReference,
														preview,
														"示例书籍",
													).text
												}
											</pre>
										) : (
											<p>填写有效预算后显示格式示例。</p>
										)}
									</div>
								</details>
							</fieldset>
						</form>
					)}
				</div>
			</details>
			<div className="reader-copy-settings-feedback">
				{fields && !editor.valid && (
					<p className="reader-settings-error" role="alert">
						复制预算需为 0–100000 的整数，修改已保留。
					</p>
				)}
				{editor.pending ? (
					<p className="reader-settings-status" role="status">
						正在保存复制设置…
					</p>
				) : (
					editor.dirty && (
						<p className="reader-settings-status" role="status">
							编辑结束后自动保存
						</p>
					)
				)}
				{editor.query.isPending && !fields && (
					<p role="status">正在读取复制设置…</p>
				)}
				{editor.query.isError && (
					<div className="reader-settings-error" role="alert">
						<p>读取复制设置失败，原文可继续阅读。</p>
						<button
							type="button"
							disabled={editor.pending}
							onClick={() => void editor.query.refetch()}
						>
							重新读取复制设置
						</button>
					</div>
				)}
				{editor.noticeError && (
					<button
						type="button"
						disabled={editor.pending || !editor.valid}
						onClick={() => void editor.save()}
					>
						重试保存复制设置
					</button>
				)}
				{editor.notice && (
					<p
						className={
							editor.noticeError
								? "reader-settings-error"
								: "reader-settings-status"
						}
						role={editor.noticeError ? "alert" : "status"}
					>
						{editor.notice}
					</p>
				)}
			</div>
		</section>
	);
}
