import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api/client";
import { requireData } from "../content";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	type DefaultsInput,
	type Model,
	type ProfileInput,
	type Provider,
	type Settings,
	type Style,
	type StyleInput,
	settingsKeys,
} from "./api";

export function LearningSettings({
	settings,
	providers,
}: {
	settings: Settings;
	providers: Provider[];
}) {
	const [profileSaved, setProfileSaved] = useState(false);
	const [defaultsSaved, setDefaultsSaved] = useState(false);
	return (
		<>
			<ProfileEditor
				key={JSON.stringify(settings.profile)}
				initial={settings.profile}
				saved={profileSaved}
				onSaved={setProfileSaved}
			/>
			<StyleEditor
				styles={settings.styles}
				defaultId={settings.defaults.style_id}
			/>
			<DefaultsEditor
				key={JSON.stringify(settings.defaults)}
				initial={settings.defaults}
				styles={settings.styles}
				providers={providers}
				saved={defaultsSaved}
				onSaved={setDefaultsSaved}
			/>
		</>
	);
}

function ProfileEditor({
	initial,
	saved,
	onSaved,
}: {
	initial: Settings["profile"];
	saved: boolean;
	onSaved: (value: boolean) => void;
}) {
	const client = useQueryClient();
	const [fields, setFields] = useState<ProfileInput>({
		native_language: initial.native_language,
		explain_language: initial.explain_language,
		level_note: initial.level_note,
	});
	const save = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await api.PUT("/api/settings/profile", {
				body: fields,
			});
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			onSaved(true);
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	return (
		<section className="settings-section" aria-labelledby="profile-heading">
			<div className="section-heading">
				<h2 id="profile-heading">学习背景</h2>
			</div>
			<form
				className="editor-card"
				onSubmit={(event) => {
					event.preventDefault();
					onSaved(false);
					save.mutate();
				}}
			>
				<div className="form-grid">
					<label className="field">
						<span>母语</span>
						<input
							required
							value={fields.native_language}
							onChange={(event) =>
								setFields({ ...fields, native_language: event.target.value })
							}
						/>
					</label>
					<label className="field">
						<span>讲解语言</span>
						<input
							required
							value={fields.explain_language}
							onChange={(event) =>
								setFields({ ...fields, explain_language: event.target.value })
							}
						/>
					</label>
					<label className="field full">
						<span>学习水平与背景</span>
						<textarea
							rows={4}
							value={fields.level_note}
							onChange={(event) =>
								setFields({ ...fields, level_note: event.target.value })
							}
							placeholder="写下当前水平、目标或希望讲解时考虑的背景"
						/>
					</label>
				</div>
				<InlineError error={save.error} />
				<div className="actions">
					<button
						className="button primary"
						type="submit"
						disabled={save.isPending}
					>
						保存学习背景
					</button>
					{saved && (
						<span className="save-note" role="status">
							已保存
						</span>
					)}
				</div>
			</form>
		</section>
	);
}

function StyleEditor({
	styles,
	defaultId,
}: {
	styles: Style[];
	defaultId: string | null;
}) {
	const client = useQueryClient();
	const [editing, setEditing] = useState<Style | "new" | null>(null);
	const [deleting, setDeleting] = useState<Style | null>(null);
	const [fields, setFields] = useState<StyleInput>({ name: "", body_md: "" });
	const save = useMutation({
		mutationFn: async () => {
			const result =
				editing === "new"
					? await api.POST("/api/settings/styles", { body: fields })
					: await api.PUT("/api/settings/styles/{style_id}", {
							params: { path: { style_id: (editing as Style).id } },
							body: fields,
						});
			return requireData(result.data, result.error, result.response.status);
		},
		onSuccess: () => {
			setEditing(null);
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
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
		<section className="settings-section" aria-labelledby="styles-heading">
			<div className="section-heading">
				<h2 id="styles-heading">讲解预设</h2>
				<button
					className="button secondary"
					type="button"
					onClick={() => {
						save.reset();
						setFields({ name: "", body_md: "" });
						setEditing("new");
					}}
				>
					新建预设
				</button>
			</div>
			<p className="settings-hint">
				按需要为讲解要求命名；新建线程会使用选中的默认预设。
			</p>
			<div className="settings-list">
				{styles.map((style) => (
					<div className="settings-row" key={style.id}>
						<div>
							<strong>{style.name}</strong>
							{style.id === defaultId && (
								<span className="status-tag">默认</span>
							)}
							<p className="settings-preview">{style.body_md}</p>
						</div>
						<div className="actions">
							<button
								className="button secondary"
								type="button"
								onClick={() => {
									save.reset();
									setFields({ name: style.name, body_md: style.body_md });
									setEditing(style);
								}}
							>
								编辑
							</button>
							<button
								className="text-danger"
								type="button"
								disabled={style.id === defaultId || remove.isPending}
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
			{deleting && (
				<ConfirmDialog
					titleId="delete-style-title"
					onClose={() => {
						if (!remove.isPending) setDeleting(null);
					}}
				>
					<p className="eyebrow">删除确认</p>
					<h2 id="delete-style-title">删除「{deleting.name}」？</h2>
					<p>此操作会删除该讲解预设。当前默认预设不能删除。</p>
					<InlineError error={remove.error} />
					<div className="actions">
						<button
							className="button danger"
							type="button"
							disabled={remove.isPending}
							onClick={() => remove.mutate(deleting.id)}
						>
							{remove.isPending ? "删除中…" : "确认删除"}
						</button>
						<button
							className="button secondary"
							type="button"
							disabled={remove.isPending}
							onClick={() => setDeleting(null)}
						>
							取消
						</button>
					</div>
				</ConfirmDialog>
			)}
			{editing && (
				<form
					className="editor-card settings-editor"
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						save.mutate();
					}}
				>
					<h3>{editing === "new" ? "新建讲解预设" : "编辑讲解预设"}</h3>
					<div className="form-grid">
						<label className="field full">
							<span>名称</span>
							<input
								required
								value={fields.name}
								onChange={(event) =>
									setFields({ ...fields, name: event.target.value })
								}
							/>
						</label>
						<label className="field full">
							<span>讲解要求</span>
							<textarea
								rows={8}
								required
								value={fields.body_md}
								onChange={(event) =>
									setFields({ ...fields, body_md: event.target.value })
								}
							/>
						</label>
					</div>
					<InlineError error={save.error} />
					<div className="actions">
						<button
							className="button primary"
							type="submit"
							disabled={save.isPending}
						>
							保存预设
						</button>
						<button
							className="button secondary"
							type="button"
							onClick={() => setEditing(null)}
						>
							取消
						</button>
					</div>
				</form>
			)}
		</section>
	);
}

function DefaultsEditor({
	initial,
	styles,
	providers,
	saved,
	onSaved,
}: {
	initial: Settings["defaults"];
	styles: Style[];
	providers: Provider[];
	saved: boolean;
	onSaved: (value: boolean) => void;
}) {
	const client = useQueryClient();
	const [fields, setFields] = useState<DefaultsInput>({
		analysis_model_id: initial.analysis_model_id,
		chat_model_id: initial.chat_model_id,
		extraction_model_id: initial.extraction_model_id,
		style_id: initial.style_id,
		permission_mode: initial.permission_mode,
	});
	const save = useMutation({
		mutationFn: async () => {
			const { data, error, response } = await api.PUT(
				"/api/settings/defaults",
				{ body: fields },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: () => {
			onSaved(true);
			void client.invalidateQueries({ queryKey: settingsKeys.settings });
		},
	});
	const choices: { model: Model; provider: Provider }[] = providers.flatMap(
		(provider) => provider.models.map((model) => ({ model, provider })),
	);
	function modelSelect(
		label: string,
		key: "analysis_model_id" | "chat_model_id" | "extraction_model_id",
	) {
		const selected = choices.find(({ model }) => model.id === fields[key]);
		return (
			<label className="field">
				<span>{label}</span>
				<select
					value={fields[key] ?? ""}
					onChange={(event) =>
						setFields({ ...fields, [key]: event.target.value || null })
					}
				>
					<option value="">未选择</option>
					{choices
						.filter(
							({ model, provider }) =>
								(provider.enabled && model.enabled) || model.id === fields[key],
						)
						.map(({ model, provider }) => (
							<option key={model.id} value={model.id}>
								{provider.name} / {model.model_id}
								{!provider.enabled || !model.enabled ? "（已停用）" : ""}
							</option>
						))}
				</select>
				{selected &&
					(!selected.provider.enabled || !selected.model.enabled) && (
						<small className="field-warning">
							当前默认模型已停用，请重新选择。
						</small>
					)}
				{fields[key] && !selected && (
					<small className="field-warning">
						当前默认模型不可用，请重新选择。
					</small>
				)}
			</label>
		);
	}
	return (
		<section className="settings-section" aria-labelledby="defaults-heading">
			<div className="section-heading">
				<h2 id="defaults-heading">新任务默认值</h2>
			</div>
			<form
				className="editor-card"
				onSubmit={(event) => {
					event.preventDefault();
					onSaved(false);
					save.mutate();
				}}
			>
				<div className="form-grid">
					{modelSelect("讲解模型", "analysis_model_id")}
					{modelSelect("讨论模型", "chat_model_id")}
					{modelSelect("条目整理模型", "extraction_model_id")}
					<label className="field">
						<span>默认讲解预设</span>
						<select
							value={fields.style_id ?? ""}
							onChange={(event) =>
								setFields({ ...fields, style_id: event.target.value || null })
							}
						>
							<option value="">未选择</option>
							{styles.map((style) => (
								<option key={style.id} value={style.id}>
									{style.name}
								</option>
							))}
						</select>
					</label>
					<label className="field full">
						<span>新线程默认权限</span>
						<select
							value={fields.permission_mode}
							onChange={(event) =>
								setFields({
									...fields,
									permission_mode: event.target
										.value as DefaultsInput["permission_mode"],
								})
							}
						>
							<option value="review">审核模式</option>
							<option value="full_access">Full access</option>
						</select>
						<small>只影响此后创建的新线程；已有线程保留自己的权限。</small>
					</label>
				</div>
				<InlineError error={save.error} />
				<div className="actions">
					<button
						className="button primary"
						type="submit"
						disabled={save.isPending}
					>
						保存默认值
					</button>
					{saved && (
						<span className="save-note" role="status">
							已保存
						</span>
					)}
				</div>
			</form>
		</section>
	);
}
