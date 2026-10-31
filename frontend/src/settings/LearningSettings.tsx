import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "../api/client";
import { requireData } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import { useAutosavingFields } from "./AutosavingSettings";
import {
	type ProfileInput,
	patchSettings,
	type Settings,
	type Style,
	type StyleInput,
	settingsKeys,
} from "./api";
import { SegmentContextSettingsGroup } from "./SegmentContextSettings";
import { SettingsEditorDialog, useSettingsFields } from "./SettingsForms";
import { commitSettingsResponse } from "./settings-cache";

type LearningFields = { profile: ProfileInput; style_id: string | null };
const learningFields = (settings: Settings): LearningFields => ({
	profile: {
		native_language: settings.profile.native_language,
		explain_language: settings.profile.explain_language,
		level_note: settings.profile.level_note,
	},
	style_id: settings.defaults.style_id,
});

export function LearningSettings({ settings }: { settings: Settings }) {
	const client = useQueryClient();
	const draft = useAutosavingFields(
		"learning-preferences",
		"AI 讲解偏好",
		learningFields(settings),
		async (fields, accept) => {
			const result = await patchSettings({
				profile: fields.profile,
				defaults: { style_id: fields.style_id },
			});
			await commitSettingsResponse(client, result, () =>
				accept(learningFields(result)),
			);
		},
		"请填完母语和讲解语言，以便自动保存。",
	);
	const { profile } = draft.fields;
	return (
		<div className="settings-page-form">
			<section
				className="learning-group"
				aria-labelledby="learning-preferences-heading"
			>
				<h2 className="learning-group-title" id="learning-preferences-heading">
					AI 讲解偏好
				</h2>
				<details className="learning-disclosure learning-help">
					<summary>这些信息会用在哪里？</summary>
					<p className="settings-hint">
						创建 AI 讲解或在学习片段里提问时，AI
						会参考你的学习背景和默认讲解预设。
						在片段中选择「复制讲解提示词」时，复制的文字也会包含学习背景和默认预设，方便粘贴给外部
						AI。
					</p>
				</details>
				<form
					id="learning-settings-form"
					ref={draft.form}
					onBlur={(event) => {
						if (event.target.matches("input, textarea")) draft.finishEditing();
					}}
					onSubmit={(event) => {
						event.preventDefault();
						draft.finishEditing();
					}}
				>
					<fieldset>
						<section
							className="settings-section"
							aria-labelledby="learning-background-heading"
						>
							<div className="settings-section-heading">
								<h3 id="learning-background-heading">学习背景</h3>
							</div>
							<div className="settings-group">
								<label className="settings-preference-row">
									<span className="settings-row-copy">
										<strong>母语</strong>
										<small>用于理解语言差异与表达习惯。</small>
									</span>
									<input
										className="settings-control"
										required
										value={profile.native_language}
										onChange={(event) =>
											draft.change({
												...draft.fields,
												profile: {
													...profile,
													native_language: event.target.value,
												},
											})
										}
									/>
								</label>
								<label className="settings-preference-row">
									<span className="settings-row-copy">
										<strong>讲解语言</strong>
										<small>讲解时优先使用的语言。</small>
									</span>
									<input
										className="settings-control"
										required
										value={profile.explain_language}
										onChange={(event) =>
											draft.change({
												...draft.fields,
												profile: {
													...profile,
													explain_language: event.target.value,
												},
											})
										}
									/>
								</label>
								<div className="settings-preference-row background">
									<div className="settings-row-copy">
										<label htmlFor="learning-level-note">
											<strong>学习情况（选填）</strong>
										</label>
										<small id="learning-level-note-hint">
											可以写日语水平、熟悉的内容或阅读时遇到的困难。
										</small>
									</div>
									<textarea
										id="learning-level-note"
										aria-describedby="learning-level-note-hint"
										className="settings-control"
										rows={4}
										value={profile.level_note}
										placeholder="写下你希望 AI 了解的学习情况"
										onChange={(event) =>
											draft.change({
												...draft.fields,
												profile: { ...profile, level_note: event.target.value },
											})
										}
									/>
								</div>
								<details className="learning-disclosure learning-example">
									<summary>查看学习情况填写示例</summary>
									<div className="learning-example-content settings-hint">
										<dl>
											<dt>考试与阅读水平</dt>
											<dd>我通过了 JLPT N3，正在尝试阅读日语小说。</dd>
											<dt>词汇量与表达</dt>
											<dd>
												我估计自己的词汇量在 4000
												左右，日常词汇较熟悉，但常看不懂口语缩略和拟声拟态词。
											</dd>
											<dt>语法</dt>
											<dd>
												我会用基本的动词活用和助词，但长句里的修饰关系、主语省略和句尾语气常让我困惑。
											</dd>
											<dt>文化背景与目标</dt>
											<dd>
												我不太了解日本职场文化，希望读懂人物之间的关系和说话语气。
											</dd>
										</dl>
										<p aria-hidden="true">……</p>
									</div>
								</details>
							</div>
						</section>
					</fieldset>
				</form>
				<fieldset>
					<StyleList
						settings={settings}
						selected={draft.fields.style_id}
						onSelect={(id) => draft.select({ ...draft.fields, style_id: id })}
					/>
				</fieldset>
				{draft.feedback}
			</section>
			<SegmentContextSettingsGroup />
		</div>
	);
}

function StyleList({
	settings,
	selected,
	onSelect,
}: {
	settings: Settings;
	selected: string | null;
	onSelect: (id: string | null) => void;
}) {
	const client = useQueryClient();
	const [editing, setEditing] = useState<Style | "new" | null>(null);
	const [deleting, setDeleting] = useState<Style | null>(null);
	const remove = useMutation({
		mutationFn: async (id: string) => {
			const { error, response } = await api.DELETE(
				"/api/settings/styles/{style_id}",
				{ params: { path: { style_id: id } } },
			);
			if (!response.ok)
				throw new Error(
					typeof error === "object" &&
						error &&
						"detail" in error &&
						typeof error.detail === "string"
						? error.detail
						: "删除失败",
				);
		},
		onSuccess: () => {
			setDeleting(null);
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	return (
		<section
			className="settings-section"
			aria-labelledby="learning-styles-heading"
		>
			<div className="settings-section-heading">
				<h3 id="learning-styles-heading">讲解方式</h3>
				<button
					className="settings-button secondary"
					type="button"
					onClick={() => setEditing("new")}
				>
					＋ 新建预设
				</button>
			</div>
			<p className="settings-hint settings-section-note">
				把常用的讲解要求存成预设，选一份作为默认。
			</p>
			<div className="settings-group">
				<label className="settings-preset">
					<input
						type="radio"
						name="default-style"
						checked={selected === null}
						onChange={() => onSelect(null)}
					/>
					<span className="settings-row-copy">
						<strong>不使用预设</strong>
						<small>保留学习背景，不附加预设里的讲解要求。</small>
					</span>
				</label>
				{settings.styles.map((style) => (
					<div className="settings-preset" key={style.id}>
						<label className="settings-preset-choice">
							<input
								type="radio"
								name="default-style"
								checked={selected === style.id}
								onChange={() => onSelect(style.id)}
							/>
							<span className="settings-row-copy">
								<strong>{style.name}</strong>
								{style.id === settings.defaults.style_id && (
									<span className="settings-badge">默认</span>
								)}
								<small className="settings-style-preview">
									{style.body_md}
								</small>
							</span>
						</label>
						<div className="settings-actions">
							<button
								className="settings-button secondary"
								type="button"
								onClick={() => setEditing(style)}
							>
								编辑
							</button>
							<button
								className="settings-button danger"
								type="button"
								disabled={
									style.id === settings.defaults.style_id ||
									style.id === selected ||
									remove.isPending
								}
								onClick={() => {
									remove.reset();
									setDeleting(style);
								}}
							>
								删除
							</button>
						</div>
					</div>
				))}
			</div>
			<InlineError error={remove.error} />
			{editing && (
				<StyleEditor
					key={editing === "new" ? "new" : editing.id}
					style={editing}
					onClose={() => setEditing(null)}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					className="settings-dialog"
					titleId="delete-style-title"
					onClose={() => {
						if (!remove.isPending) setDeleting(null);
					}}
				>
					<h2 id="delete-style-title">删除「{deleting.name}」？</h2>
					<p>此操作会删除该讲解预设，当前默认预设不能删除。</p>
					<InlineError error={remove.error} />
					<div className="settings-actions">
						<button
							className="settings-button danger"
							type="button"
							disabled={remove.isPending}
							onClick={() => remove.mutate(deleting.id)}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							className="settings-button secondary"
							type="button"
							disabled={remove.isPending}
							data-dialog-cancel
							onClick={() => setDeleting(null)}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
		</section>
	);
}

function StyleEditor({
	style,
	onClose,
}: {
	style: Style | "new";
	onClose: () => void;
}) {
	const client = useQueryClient();
	const initial: StyleInput =
		style === "new"
			? { name: "", body_md: "" }
			: { name: style.name, body_md: style.body_md };
	const draft = useSettingsFields(initial);
	const form = useRef<HTMLFormElement>(null);
	const save = useMutation({
		mutationFn: async (fields: StyleInput) => {
			const result =
				style === "new"
					? await api.POST("/api/settings/styles", { body: fields })
					: await api.PUT("/api/settings/styles/{style_id}", {
							params: { path: { style_id: style.id } },
							body: fields,
						});
			return requireData(result.data, result.error, result.response.status);
		},
	});
	async function persist() {
		if (!form.current?.reportValidity()) return false;
		try {
			await save.mutateAsync(draft.fields);
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
			onClose();
			return true;
		} catch {
			return false;
		}
	}
	return (
		<SettingsEditorDialog
			id="style-editor"
			title={style === "new" ? "新建讲解预设" : "编辑讲解预设"}
			dirty={draft.dirty}
			pending={save.isPending}
			save={persist}
			onClose={onClose}
		>
			{(requestClose) => (
				<form
					ref={form}
					className="settings-editor-form"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void persist();
					}}
				>
					<fieldset disabled={save.isPending}>
						<div className="settings-form-grid">
							<label className="settings-field full">
								<span>名称</span>
								<input
									required
									value={draft.fields.name}
									onChange={(event) =>
										draft.change({ ...draft.fields, name: event.target.value })
									}
								/>
							</label>
							<label className="settings-field full">
								<span>讲解要求</span>
								<textarea
									required
									rows={8}
									value={draft.fields.body_md}
									onChange={(event) =>
										draft.change({
											...draft.fields,
											body_md: event.target.value,
										})
									}
								/>
							</label>
						</div>
					</fieldset>
					<InlineError error={save.error} />
					<div className="settings-actions">
						<button
							className="settings-button secondary"
							type="button"
							disabled={save.isPending}
							onClick={requestClose}
						>
							取消
						</button>
						<button
							className="settings-button primary"
							type="submit"
							disabled={save.isPending}
						>
							{save.isPending ? "保存中…" : "保存预设"}
						</button>
					</div>
				</form>
			)}
		</SettingsEditorDialog>
	);
}
