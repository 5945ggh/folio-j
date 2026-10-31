import "./translation-settings.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { RequestError } from "../content";
import { NativeSelect } from "../NativeSelect";
import { InlineError } from "../Shared";
import { useAutosavingFields } from "../settings/AutosavingSettings";
import { getProviders, getSettings, settingsKeys } from "../settings/api";
import {
	getTranslationSettings,
	saveTranslationSettings,
	type TranslationSettings,
	translationSettingsKey,
} from "./api";

const ranges = [
	{
		label: "前文",
		sentences: "before_sentences",
		characters: "before_characters",
	},
	{
		label: "后文",
		sentences: "after_sentences",
		characters: "after_characters",
	},
] as const;

function ConflictReview({
	message,
	fields,
	modelLabel,
	confirm,
	discard,
}: {
	message: string;
	fields: TranslationSettings;
	modelLabel: (id: string | null) => string;
	confirm: (fields: TranslationSettings) => void;
	discard: () => void;
}) {
	const client = useQueryClient();
	const read = useMutation({
		mutationFn: () =>
			client.fetchQuery({
				queryKey: translationSettingsKey,
				queryFn: getTranslationSettings,
				staleTime: 0,
				retry: false,
			}),
	});
	const latest = read.data;
	const differences = latest
		? [
				["译成", latest.target_language, fields.target_language],
				["翻译模型", modelLabel(latest.model_id), modelLabel(fields.model_id)],
				...ranges.flatMap(({ label, sentences, characters }) => [
					[
						`${label}句数`,
						String(latest[sentences]),
						String(fields[sentences]),
					],
					[
						`${label}字符上限`,
						String(latest[characters]),
						String(fields[characters]),
					],
				]),
			].filter(([, stored, local]) => stored !== local)
		: [];
	return (
		<section
			className="settings-state translation-conflict"
			aria-label="翻译设置冲突对照"
		>
			<p role="alert">{message}。你的修改仍保留在这里。</p>
			{latest ? (
				<>
					{differences.length ? (
						<table>
							<thead>
								<tr>
									<th>设置项</th>
									<th>已保存</th>
									<th>你的修改</th>
								</tr>
							</thead>
							<tbody>
								{differences.map(([label, stored, local]) => (
									<tr key={label}>
										<th scope="row">{label}</th>
										<td>{stored}</td>
										<td>{local}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<p>当前填写的设置与已保存的内容一致。</p>
					)}
					<div className="settings-actions">
						{differences.length > 0 && (
							<button
								type="button"
								className="settings-button primary"
								onClick={() =>
									confirm({
										...fields,
										revision: latest.revision,
										name: latest.name,
									})
								}
							>
								保存我的修改
							</button>
						)}
						<button
							type="button"
							className="settings-button secondary"
							onClick={discard}
						>
							采用已保存设置
						</button>
					</div>
				</>
			) : (
				<button
					type="button"
					className="settings-button secondary"
					onClick={() => read.mutate()}
					disabled={read.isPending}
				>
					{read.isPending ? "正在读取…" : "查看差异"}
				</button>
			)}
			<InlineError error={read.error} />
		</section>
	);
}

function SettingsForm({ initial }: { initial: TranslationSettings }) {
	const client = useQueryClient();
	const acceptedRevision = useRef(initial.revision);
	const [editingRange, setEditingRange] = useState(false);
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
	});
	const settings = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
	});
	const models = providers.data?.flatMap((p) =>
		p.models.map((m) => ({
			id: m.id,
			label: `${p.name} / ${m.model_id}`,
			enabled: p.enabled && m.enabled,
		})),
	);
	const modelLabel = (id: string | null) =>
		models?.find((model) => model.id === id)?.label ??
		(id ? `${id}（不可用）` : "未选择");
	const draft = useAutosavingFields(
		"translation",
		"翻译",
		initial,
		async (fields, accept) => {
			const result = await saveTranslationSettings({
				expected_revision: Math.max(acceptedRevision.current, fields.revision),
				name: fields.name,
				model_id: fields.model_id,
				target_language: fields.target_language,
				before_sentences: fields.before_sentences,
				after_sentences: fields.after_sentences,
				before_characters: fields.before_characters,
				after_characters: fields.after_characters,
			});
			acceptedRevision.current = result.revision;
			await client.cancelQueries({ queryKey: translationSettingsKey });
			accept(result);
			client.setQueryData<TranslationSettings>(
				translationSettingsKey,
				(current) =>
					current && current.revision > result.revision ? current : result,
			);
		},
		"请填写目标语言和有效的前后文范围。",
		{
			required: (error) =>
				error instanceof RequestError && error.status === 409,
			render: (error, fields, confirm, discard) => (
				<ConflictReview
					message={error.message}
					fields={fields}
					modelLabel={modelLabel}
					confirm={confirm}
					discard={discard}
				/>
			),
		},
	);
	const value = draft.fields;
	const chatModel = models?.find(
		(m) => m.enabled && m.id === settings.data?.defaults.chat_model_id,
	);
	return (
		<form
			className="translation-settings"
			ref={draft.form}
			onSubmit={(event) => {
				event.preventDefault();
				draft.finishEditing();
			}}
		>
			<section
				className="learning-group"
				aria-labelledby="translation-reading-heading"
				onChangeCapture={() => {
					if (!draft.needsReview) setEditingRange(false);
				}}
			>
				<h2 id="translation-reading-heading" className="learning-group-title">
					阅读翻译
				</h2>
				<p className="settings-hint settings-section-note">
					在书中选中文字并翻译时，使用这里的语言和模型。
				</p>
				<div className="settings-group">
					<label className="settings-preference-row">
						<span className="settings-row-copy">
							<strong>译成</strong>
						</span>
						<input
							className="settings-control"
							required
							pattern={".*\\S.*"}
							maxLength={100}
							value={value.target_language}
							onChange={(event) =>
								draft.change({ ...value, target_language: event.target.value })
							}
							onBlur={draft.finishEditing}
						/>
					</label>
					<div className="settings-preference-row">
						<label className="settings-row-copy" htmlFor="translation-model">
							<strong>翻译模型</strong>
						</label>
						<div className="translation-model-field">
							<NativeSelect
								id="translation-model"
								className="settings-control"
								disabled={
									!models || (!value.model_id && !models.some((m) => m.enabled))
								}
								value={value.model_id ?? ""}
								onChange={(event) =>
									draft.select({
										...value,
										model_id: event.target.value || null,
									})
								}
							>
								<option value="">未选择</option>
								{value.model_id &&
									!models?.some((m) => m.id === value.model_id) && (
										<option value={value.model_id}>
											{providers.isPending ? "正在读取模型…" : "已选模型不可用"}
										</option>
									)}
								{models?.map((m) => (
									<option key={m.id} value={m.id} disabled={!m.enabled}>
										{m.label}
										{m.enabled ? "" : "（已停用）"}
									</option>
								))}
							</NativeSelect>
							{chatModel && value.model_id !== chatModel.id && (
								<button
									className="translation-model-action"
									type="button"
									onClick={() => {
										if (!draft.needsReview) setEditingRange(false);
										draft.select({ ...value, model_id: chatModel.id });
									}}
								>
									选用当前讨论模型
								</button>
							)}
							{models && !models.some((m) => m.enabled) && (
								<Link
									className="translation-model-action"
									to="/settings?section=providers"
								>
									前往服务管理
								</Link>
							)}
							<InlineError error={providers.error ?? settings.error} />
						</div>
					</div>
				</div>
				{!editingRange && draft.feedback}
			</section>
			<section
				className="learning-group"
				aria-labelledby="translation-range-heading"
				onChangeCapture={() => {
					if (!draft.needsReview) setEditingRange(true);
				}}
			>
				<h2 id="translation-range-heading" className="learning-group-title">
					前后文范围
				</h2>
				<p className="settings-hint settings-section-note">
					附近的原文可以帮助判断省略的主语和词义。译文只包含选中的文字。
				</p>
				<div className="learning-context-ranges">
					{ranges.map(({ label, sentences, characters }) => (
						<fieldset key={label} className="settings-group">
							<legend>{label}</legend>
							{(
								[
									[sentences, "句数上限", 100],
									[characters, "字符上限", value.max_context_characters],
								] as const
							).map(([key, name, max]) => (
								<label className="settings-field" key={key}>
									{name}
									<input
										type="number"
										aria-label={label + name}
										required
										min={0}
										max={max}
										step={1}
										value={Number.isNaN(value[key]) ? "" : value[key]}
										onChange={(event) =>
											draft.change({
												...value,
												[key]: event.target.valueAsNumber,
											})
										}
										onBlur={draft.finishEditing}
									/>
								</label>
							))}
						</fieldset>
					))}
				</div>
				<p className="settings-hint">
					每侧达到任一上限就停止取文。填 0 会跳过该侧。字符数包含空白与标点。
				</p>
				{editingRange && draft.feedback}
			</section>
		</form>
	);
}

export function TranslationSettingsSection() {
	const settings = useQuery({
		queryKey: translationSettingsKey,
		queryFn: getTranslationSettings,
	});
	return (
		<>
			{settings.isPending && (
				<p className="settings-loading" role="status">
					正在加载翻译设置…
				</p>
			)}
			{settings.data ? (
				<SettingsForm initial={settings.data} />
			) : (
				settings.isError && (
					<div className="settings-state">
						<InlineError error={settings.error} />
						<button
							type="button"
							className="settings-button secondary"
							onClick={() => void settings.refetch()}
						>
							重试翻译设置
						</button>
					</div>
				)
			)}
		</>
	);
}
