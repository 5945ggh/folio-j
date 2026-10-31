import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { RequestError } from "../content";
import { NativeSelect } from "../NativeSelect";
import { InlineError } from "../Shared";
import { getProviders, getSettings, settingsKeys } from "../settings/api";
import { useSettingsDraft } from "../settings/SettingsForms";
import {
	getTranslationSettings,
	saveTranslationSettings,
	type TranslationSettings,
	type TranslationSettingsInput,
	translationSettingsKey,
} from "./api";

function SettingsForm({ initial }: { initial: TranslationSettings }) {
	const client = useQueryClient();
	const [baseline, setBaseline] = useState(initial);
	const [draft, setDraft] = useState<TranslationSettingsInput>({
		...initial,
		expected_revision: initial.revision,
	});
	const [saved, setSaved] = useState(false);
	const [latest, setLatest] = useState<TranslationSettings | null>(null);
	const providers = useQuery({
		queryKey: settingsKeys.providers,
		queryFn: getProviders,
	});
	const settings = useQuery({
		queryKey: settingsKeys.settings,
		queryFn: getSettings,
	});
	const fields = (value: Omit<TranslationSettingsInput, "expected_revision">) =>
		JSON.stringify([
			value.name,
			value.model_id,
			value.target_language,
			value.before_sentences,
			value.after_sentences,
			value.before_characters,
			value.after_characters,
		]);
	const dirty = fields(draft) !== fields(baseline);
	const update = (values: Partial<TranslationSettingsInput>) => {
		setDraft({ ...draft, ...values });
		setSaved(false);
	};
	const save = useMutation({
		mutationFn: saveTranslationSettings,
		onSuccess: (value) => {
			setLatest(null);
			setBaseline(value);
			setDraft({ ...value, expected_revision: value.revision });
			setSaved(true);
			client.setQueryData(translationSettingsKey, value);
		},
		onError: (error) => {
			if (error instanceof RequestError && error.status === 409)
				setLatest(null);
		},
	});
	const conflict =
		save.error instanceof RequestError && save.error.status === 409;
	const readLatest = useMutation({
		mutationFn: getTranslationSettings,
		onSuccess: setLatest,
	});
	const modelLabel = (id: string | null | undefined) => {
		const provider = providers.data?.find((p) =>
			p.models.some((m) => m.id === id),
		);
		const model = provider?.models.find((m) => m.id === id);
		return provider && model
			? `${provider.name} / ${model.model_id}`
			: id
				? `${id}（不可用）`
				: "未选择";
	};
	const chatModelId = settings.data?.defaults.chat_model_id;
	const availableChatModel = providers.data?.some(
		(p) => p.enabled && p.models.some((m) => m.id === chatModelId && m.enabled),
	);
	const submit = async (revision = baseline.revision, confirmed = false) => {
		if (conflict && !confirmed) return false;
		try {
			await save.mutateAsync({
				expected_revision: revision,
				name: confirmed ? (latest?.name ?? draft.name) : draft.name,
				model_id: draft.model_id,
				target_language: draft.target_language,
				before_sentences: draft.before_sentences,
				after_sentences: draft.after_sentences,
				before_characters: draft.before_characters,
				after_characters: draft.after_characters,
			});
			return true;
		} catch {
			return false;
		}
	};
	useSettingsDraft({
		id: "translation",
		label: "翻译",
		dirty,
		pending: save.isPending,
		save: () => submit(),
		discard: () =>
			setDraft({ ...baseline, expected_revision: baseline.revision }),
	});
	return (
		<section className="settings-section">
			<h3>默认翻译方案</h3>
			<p className="settings-hint">
				独立保存所选模型；之后更改讨论模型不会改变翻译方案。
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<fieldset
					disabled={save.isPending}
					style={{ border: 0, padding: 0, margin: 0 }}
				>
					<label className="settings-preference-row">
						<span>翻译模型</span>
						<NativeSelect
							className="settings-control"
							value={draft.model_id ?? ""}
							onChange={(event) =>
								update({ model_id: event.target.value || null })
							}
						>
							<option value="">未选择</option>
							{draft.model_id &&
								!providers.data?.some((p) =>
									p.models.some((m) => m.id === draft.model_id),
								) && <option value={draft.model_id}>已选模型不可用</option>}
							{providers.data?.map((p) => (
								<optgroup key={p.id} label={p.name}>
									{p.models.map((m) => (
										<option
											key={m.id}
											value={m.id}
											disabled={!p.enabled || !m.enabled}
										>
											{p.name} / {m.model_id}
											{!p.enabled || !m.enabled ? "（已停用）" : ""}
										</option>
									))}
								</optgroup>
							))}
						</NativeSelect>
					</label>
					{availableChatModel && (
						<button
							className="settings-button secondary"
							type="button"
							onClick={() => update({ model_id: chatModelId })}
						>
							使用讨论模型
						</button>
					)}
					<InlineError error={providers.error ?? settings.error} />
					<label className="settings-preference-row">
						<span>目标语言</span>
						<input
							className="settings-control"
							required
							maxLength={100}
							value={draft.target_language}
							onChange={(event) =>
								update({ target_language: event.target.value })
							}
						/>
					</label>
					<h4>翻译语境</h4>
					<p className="settings-hint">
						两项上限同时生效，任一为 0 时不摘录该侧。只影响之后的新翻译。
					</p>
					{(["before", "after"] as const).map((side) => (
						<div key={side} className="settings-preference-row">
							<span>{side === "before" ? "前文" : "后文"}</span>
							<label>
								句数{" "}
								<input
									aria-label={`${side === "before" ? "前文" : "后文"}句数`}
									className="settings-control"
									type="number"
									min={0}
									max={100}
									value={draft[`${side}_sentences`]}
									onChange={(event) =>
										update({
											[`${side}_sentences`]: event.target.valueAsNumber,
										})
									}
								/>
							</label>
							<label>
								字符上限{" "}
								<input
									aria-label={`${side === "before" ? "前文" : "后文"}字符上限`}
									className="settings-control"
									type="number"
									min={0}
									max={initial.max_context_characters}
									value={draft[`${side}_characters`]}
									onChange={(event) =>
										update({
											[`${side}_characters`]: event.target.valueAsNumber,
										})
									}
								/>
							</label>
						</div>
					))}
					<InlineError error={save.error} />
					{conflict && (
						<section aria-label="翻译设置冲突对照">
							<p>
								翻译设置已在其他页面更新。草稿仍保留，请读取并核对当前配置。
							</p>
							<button
								type="button"
								disabled={readLatest.isPending}
								onClick={() => readLatest.mutate()}
							>
								{readLatest.isPending
									? "正在读取当前设置…"
									: "读取当前设置（保留草稿）"}
							</button>
							<InlineError error={readLatest.error} />
							{latest && (
								<>
									<h4>当前已保存配置（版本 {latest.revision}）</h4>
									<dl>
										<dt>模型</dt>
										<dd>{modelLabel(latest.model_id)}</dd>
										<dt>目标语言</dt>
										<dd>{latest.target_language}</dd>
										<dt>前文</dt>
										<dd>
											{latest.before_sentences} 句，最多{" "}
											{latest.before_characters} 字符
										</dd>
										<dt>后文</dt>
										<dd>
											{latest.after_sentences} 句，最多{" "}
											{latest.after_characters} 字符
										</dd>
									</dl>
									<h4>待保存草稿</h4>
									<p>
										{modelLabel(draft.model_id)} · {draft.target_language}
									</p>
									<p>
										前文 {draft.before_sentences} 句 / {draft.before_characters}{" "}
										字符；后文 {draft.after_sentences} 句 /{" "}
										{draft.after_characters} 字符
									</p>
									<button
										className="settings-button primary"
										type="button"
										disabled={save.isPending || readLatest.isPending}
										onClick={() => void submit(latest.revision, true)}
									>
										按当前版本保存草稿
									</button>
								</>
							)}
						</section>
					)}
					<div className="settings-save-bar">
						<button
							className="settings-button primary"
							type="submit"
							disabled={save.isPending || !dirty || conflict}
						>
							{save.isPending ? "保存中…" : "保存翻译设置"}
						</button>
						{saved && <span role="status">已保存</span>}
					</div>
				</fieldset>
			</form>
		</section>
	);
}
export function TranslationSettingsSection() {
	const settings = useQuery({
		queryKey: translationSettingsKey,
		queryFn: getTranslationSettings,
	});
	return (
		<>
			{settings.isPending && <p role="status">正在加载翻译设置…</p>}
			<InlineError error={settings.error} />
			{settings.isError && (
				<button type="button" onClick={() => void settings.refetch()}>
					重试翻译设置
				</button>
			)}
			{settings.data && <SettingsForm initial={settings.data} />}
		</>
	);
}
