import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { RequestError } from "../content";
import { InlineError } from "../Shared";
import { useAutosavingFields } from "./AutosavingSettings";
import {
	getSegmentContextSettings,
	type SegmentContextSettings,
	saveSegmentContextSettings,
	segmentContextKey,
} from "./segment-context-api";
import { commitSegmentContextResponse } from "./segment-context-cache";

export function SegmentContextSettingsGroup() {
	const settings = useQuery({
		queryKey: segmentContextKey,
		queryFn: ({ signal }) => getSegmentContextSettings(signal),
	});
	return (
		<section
			className="learning-group"
			aria-labelledby="segment-context-heading"
		>
			<h2 className="learning-group-title" id="segment-context-heading">
				保存学习片段
			</h2>
			<p className="settings-hint settings-section-note">
				在书中选中文字并新建学习片段时，可以一起保存附近的原文。
			</p>
			<InlineError error={settings.error} />
			{settings.isPending && (
				<p className="settings-hint">正在读取前后文设置…</p>
			)}
			{settings.data ? (
				<ContextForm settings={settings.data} />
			) : settings.isError ? (
				<button
					type="button"
					className="settings-button secondary"
					onClick={() => void settings.refetch()}
				>
					重新读取
				</button>
			) : null}
		</section>
	);
}

const directions = [
	{
		title: "前文",
		sentences: "before_sentences",
		characters: "before_characters",
	},
	{
		title: "后文",
		sentences: "after_sentences",
		characters: "after_characters",
	},
] as const;

function ContextForm({ settings }: { settings: SegmentContextSettings }) {
	const client = useQueryClient();
	const acceptedRevision = useRef(settings.revision);
	const draft = useAutosavingFields(
		"segment-context-settings",
		"学习片段前后文",
		settings,
		async (fields, accept) => {
			const { revision, ...budget } = fields;
			try {
				const saved = await saveSegmentContextSettings({
					...budget,
					expected_revision: Math.max(revision, acceptedRevision.current),
				});
				await commitSegmentContextResponse(client, saved, (persisted) => {
					acceptedRevision.current = saved.revision;
					accept(persisted);
				});
			} catch (error) {
				if (!(error instanceof RequestError && error.status === 409))
					throw error;
				await client.cancelQueries({ queryKey: segmentContextKey });
				const latest = await client.fetchQuery({
					queryKey: segmentContextKey,
					queryFn: ({ signal }) => getSegmentContextSettings(signal),
					staleTime: 0,
				});
				acceptedRevision.current = latest.revision;
				throw new Error(
					"前后文设置已在其他页面更改。重试会保存这里的设置，放弃修改可使用最新配置。",
				);
			}
		},
		"请填写 0 到 100000 之间的整数。",
	);
	return (
		<form
			id="segment-context-settings-form"
			ref={draft.form}
			onSubmit={(event) => {
				event.preventDefault();
				draft.finishEditing();
			}}
		>
			<div className="settings-group">
				<label className="settings-preference-row learning-switch-row">
					<span className="settings-row-copy">
						<strong>自动带上前后文</strong>
						<small>保存片段前可以修改或清空前后文。</small>
					</span>
					<input
						className="learning-context-switch"
						type="checkbox"
						role="switch"
						aria-checked={draft.fields.enabled}
						checked={draft.fields.enabled}
						onChange={(event) =>
							draft.select({ ...draft.fields, enabled: event.target.checked })
						}
					/>
				</label>
			</div>
			<h3 className="learning-range-heading">前后文范围</h3>
			<div className="learning-context-ranges">
				{directions.map(({ title, sentences, characters }) => (
					<fieldset className="settings-group" key={title}>
						<legend>{title}</legend>
						{(
							[
								[sentences, "句数上限"],
								[characters, "字符上限"],
							] as const
						).map(([key, label]) => (
							<label className="settings-field" key={key}>
								{label}
								<input
									type="number"
									required
									min={0}
									max={100000}
									step={1}
									value={
										Number.isNaN(draft.fields[key]) ? "" : draft.fields[key]
									}
									onChange={(event) =>
										draft.change({
											...draft.fields,
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
			{draft.feedback}
		</form>
	);
}
