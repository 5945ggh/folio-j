import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { RequestError } from "../content";
import {
	type ContextCopySettings,
	saveContextCopySettings,
} from "../settings/context-copy-api";
import { commitContextCopyResponse } from "../settings/context-copy-cache";
import {
	type BudgetField,
	type ContextCopyFields,
	completeCopyDraft,
	conflictCopyDraft,
	copyDraftDirty,
	copyDraftRequest,
	copyFields,
	createCopyDraft,
	editCopyDraft,
	parseCopyFields,
	receiveCopySettings,
	reloadCopyDraft,
} from "../settings/context-copy-draft";
import {
	useContextCopySettings,
	useReloadContextCopySettings,
} from "../settings/context-copy-query";
import type { Chapter } from "./api";
import { buildContextCopy, DEFAULT_CONTEXT_COPY } from "./context-copy";
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
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
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
				/>
			</label>
			{!valid && <small id={hintId}>请输入 0–100000 的整数。</small>}
		</div>
	);
}

export function ReaderCopySettings() {
	const settings = useContextCopySettings();
	return (
		<fieldset className="reader-copy-settings">
			<legend>
				带上下文复制
				<span className="reader-scope">个人默认值 · 跨书／浏览器</span>
			</legend>
			<p>
				配置保存在数据库，对所有书籍生效。修改后保存，复制时使用已保存的配置；关闭面板会放弃未保存的修改。
			</p>
			{settings.isPending && <p role="status">正在读取复制设置…</p>}
			{settings.isError && (
				<div role="alert">
					<p>读取复制设置失败，原文可继续阅读。</p>
					<button type="button" onClick={() => void settings.refetch()}>
						重新读取复制设置
					</button>
				</div>
			)}
			{settings.data && <CopySettingsForm settings={settings.data} />}
		</fieldset>
	);
}

function CopySettingsForm({ settings }: { settings: ContextCopySettings }) {
	const client = useQueryClient();
	const reloadSettings = useReloadContextCopySettings();
	const [draft, setDraft] = useState(() => createCopyDraft(settings));
	const [notice, setNotice] = useState("");
	const [pending, setPending] = useState(false);
	const save = useMutation({
		mutationFn: saveContextCopySettings,
		retry: false,
	});
	useEffect(() => {
		setDraft((current) => receiveCopySettings(current, settings));
	}, [settings]);
	const dirty = copyDraftDirty(draft);
	const needsReload =
		draft.conflict || draft.latest.revision > draft.baseline.revision;
	const preview = parseCopyFields(draft.fields);
	const change = (fields: ContextCopyFields) => {
		setDraft((current) => editCopyDraft(current, fields));
		setNotice("");
		save.reset();
	};
	const field = (key: BudgetField, label: string) => (
		<BudgetInput
			label={label}
			value={draft.fields[key]}
			onChange={(value) => change({ ...draft.fields, [key]: value })}
		/>
	);
	async function persist() {
		const request = copyDraftRequest(draft);
		if (!request || pending) return;
		setPending(true);
		setNotice("");
		try {
			const result = await save.mutateAsync(request);
			const persisted = await commitContextCopyResponse(client, result);
			if (persisted) {
				setDraft((current) => completeCopyDraft(current, result, persisted));
				if (persisted.revision === result.revision)
					setNotice("复制设置已保存。");
			}
		} catch (error) {
			if (error instanceof RequestError && error.status === 409) {
				setDraft((current) => conflictCopyDraft(current));
			} else {
				setNotice("保存失败，修改已保留。");
			}
		} finally {
			setPending(false);
		}
	}
	async function reload(keepChanges: boolean) {
		if (pending) return;
		setPending(true);
		setNotice("");
		try {
			const latest = await reloadSettings();
			setDraft((current) => reloadCopyDraft(current, latest, keepChanges));
			save.reset();
			setNotice(
				keepChanges
					? "已读取最新配置并保留修改；再次保存会提交整组配置。"
					: "已使用服务器保存的复制设置。",
			);
		} catch {
			setNotice("读取复制设置失败，修改已保留。");
		} finally {
			setPending(false);
		}
	}
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void persist();
			}}
		>
			<fieldset disabled={pending}>
				{field("before_sentences", "前文句数")}
				{field("after_sentences", "后文句数")}
				<p>句数设为 0 时，不附带该侧上下文。</p>
				<label>
					<span>附带出处</span>
					<input
						type="checkbox"
						checked={draft.fields.include_source}
						onChange={(event) =>
							change({ ...draft.fields, include_source: event.target.checked })
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
					<p>使用固定样例，随当前草稿更新。</p>
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
				</details>
				<div className="reader-copy-actions">
					<button type="submit" disabled={!dirty || !preview || needsReload}>
						{pending ? "正在保存…" : "保存复制设置"}
					</button>
					<button
						type="button"
						onClick={() => change(copyFields(DEFAULT_CONTEXT_COPY))}
					>
						恢复复制默认值
					</button>
				</div>
			</fieldset>
			<p>恢复默认值只修改当前草稿，保存后生效。</p>
			{needsReload && (
				<div role="alert">
					<p>复制设置已在其他页面更新，修改已保留。重新读取后再保存。</p>
					<div className="reader-copy-actions">
						<button
							type="button"
							disabled={pending}
							onClick={() => void reload(true)}
						>
							重新读取并保留修改
						</button>
						<button
							type="button"
							disabled={pending}
							onClick={() => void reload(false)}
						>
							重新读取并使用服务器设置
						</button>
					</div>
				</div>
			)}
			{notice && <p role={save.isError ? "alert" : "status"}>{notice}</p>}
		</form>
	);
}
