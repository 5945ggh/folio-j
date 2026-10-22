import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { RequestError } from "../content";
import { InlineError } from "../Shared";
import {
	SettingsSaveBar,
	useSettingsDraft,
	useSettingsFields,
} from "./SettingsForms";
import {
	getSegmentContextSettings,
	type SegmentContextSettings,
	type SegmentContextSettingsUpdate,
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
			className="settings-section"
			aria-labelledby="segment-context-heading"
		>
			<div className="settings-section-heading">
				<h3 id="segment-context-heading">学习片段语境</h3>
			</div>
			<p className="settings-hint settings-section-note">
				从阅读选区新建片段时，自动准备可编辑的相邻前后文。只影响之后的预装，
				已有资料和当前草稿保留原值；本次草稿仍可临时调整。
			</p>
			<InlineError error={settings.error} />
			{settings.isPending && <p className="settings-hint">正在读取语境设置…</p>}
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

const budgets = [
	["before_sentences", "前文句数"],
	["after_sentences", "后文句数"],
	["before_characters", "前文字符上限"],
	["after_characters", "后文字符上限"],
] as const;

function ContextForm({ settings }: { settings: SegmentContextSettings }) {
	const client = useQueryClient();
	const draft = useSettingsFields(settings);
	const form = useRef<HTMLFormElement>(null);
	const [notice, setNotice] = useState("");
	const [persisting, setPersisting] = useState(false);
	const save = useMutation({ mutationFn: saveSegmentContextSettings });
	const pending = persisting || save.isPending;
	async function persist() {
		if (!form.current?.reportValidity()) return false;
		const submitted = draft.fields;
		const { revision, ...budget } = submitted;
		const request: SegmentContextSettingsUpdate = {
			...budget,
			expected_revision: revision,
		};
		setPersisting(true);
		setNotice("");
		try {
			const result = await save.mutateAsync(request);
			await commitSegmentContextResponse(client, result, (persisted) =>
				draft.accept(submitted, persisted),
			);
			return true;
		} catch (error) {
			if (error instanceof RequestError && error.status === 409) {
				try {
					await client.cancelQueries({ queryKey: segmentContextKey });
					const latest = await client.fetchQuery({
						queryKey: segmentContextKey,
						queryFn: ({ signal }) => getSegmentContextSettings(signal),
						staleTime: 0,
					});
					draft.change({ ...submitted, revision: latest.revision });
					setNotice(
						"已读取最新配置，保留了你的输入。再次保存可提交这组修改，或放弃修改以使用最新配置。",
					);
				} catch {
					setNotice("读取最新配置失败，输入已保留。请重试保存。");
				}
			}
			return false;
		} finally {
			setPersisting(false);
		}
	}
	useSettingsDraft({
		id: "segment-context-settings",
		label: "学习片段语境",
		dirty: draft.dirty,
		pending,
		save: persist,
		discard: draft.reset,
	});
	return (
		<form
			id="segment-context-settings-form"
			ref={form}
			onSubmit={(event) => {
				event.preventDefault();
				void persist();
			}}
		>
			<fieldset disabled={pending}>
				<div className="settings-group">
					<label className="settings-preference-row">
						<span className="settings-row-copy">
							<strong>自动预装语境</strong>
							<small>在本地取文，不调用模型；关闭后仍可手动填写。</small>
						</span>
						<input
							type="checkbox"
							checked={draft.fields.enabled}
							onChange={(event) => {
								setNotice("");
								draft.change({
									...draft.fields,
									enabled: event.target.checked,
								});
							}}
						/>
					</label>
					{budgets.map(([key, label]) => (
						<label className="settings-preference-row" key={key}>
							<span className="settings-row-copy">
								<strong>{label}</strong>
							</span>
							<input
								className="settings-control"
								type="number"
								required
								min={0}
								max={100000}
								step={1}
								value={Number.isNaN(draft.fields[key]) ? "" : draft.fields[key]}
								onChange={(event) => {
									setNotice("");
									draft.change({
										...draft.fields,
										[key]: event.target.valueAsNumber,
									});
								}}
							/>
						</label>
					))}
				</div>
				<p className="settings-hint settings-section-note">
					两侧分别受句数和字符上限约束，任一项为 0 时该侧为空。字符按 Unicode
					码点计，包含空白与标点。各项可保存 0–100000
					的整数；字符上限与文本输入上限一致。
				</p>
			</fieldset>
			<InlineError error={notice ? null : save.error} />
			{notice && (
				<p className="inline-error" role="alert">
					{notice}
				</p>
			)}
			<SettingsSaveBar
				formId="segment-context-settings-form"
				dirty={draft.dirty}
				saved={draft.saved}
				pending={pending}
				onReset={() => {
					draft.reset();
					setNotice("");
					save.reset();
				}}
				saveLabel="保存语境设置"
			/>
		</form>
	);
}
