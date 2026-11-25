import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { InlineError } from "../Shared";
import { useSettingsDraft, useSettingsFields } from "../settings/SettingsForms";
import {
	type AnkiConnectionInput,
	ankiKeys,
	getAnkiConnection,
	probeAnkiConnection,
	saveAnkiConnection,
} from "./api";

type Fields = { url: string; key: string; clear: boolean };
function connectionPayload(fields: Fields): AnkiConnectionInput {
	const body: AnkiConnectionInput = { url: fields.url.trim() };
	if (fields.key) body.api_key = fields.key;
	else if (fields.clear) body.api_key = null;
	return body;
}

export function AnkiConnectionSettings() {
	const queryClient = useQueryClient();
	const connectionQuery = useQuery({
		queryKey: ankiKeys.connection,
		queryFn: ({ signal }) => getAnkiConnection(signal),
	});
	const initial = useMemo(
		() => ({
			url: connectionQuery.data?.url ?? "http://127.0.0.1:8765",
			key: "",
			clear: false,
		}),
		[connectionQuery.data?.url],
	);
	const form = useSettingsFields(initial);
	const { url: urlInput, key: apiKeyInput, clear: clearApiKey } = form.fields;
	const connectionDirty = form.dirty;
	const saveConnectionMutation = useMutation({
		mutationFn: (fields: Fields) =>
			saveAnkiConnection(connectionPayload(fields)),
		onSuccess: (saved, submitted) => {
			form.accept(submitted, { url: saved.url, key: "", clear: false });
			queryClient.setQueryData(ankiKeys.connection, saved);
			void queryClient.invalidateQueries({ queryKey: ankiKeys.catalog });
		},
	});
	const handleSaveConnection = async () => {
		try {
			await saveConnectionMutation.mutateAsync(form.fields);
			return true;
		} catch {
			return false;
		}
	};
	useSettingsDraft({
		id: "anki-connection",
		label: "Anki 连接设置",
		dirty: connectionDirty,
		pending: saveConnectionMutation.isPending,
		save: handleSaveConnection,
		discard: form.reset,
	});
	const [probeGeneration, setProbeGeneration] = useState(0);
	const probeMutation = useMutation({
		mutationFn: ({
			body,
		}: {
			body: AnkiConnectionInput | undefined;
			generation: number;
			revision: number | undefined;
		}) => probeAnkiConnection(body),
	});
	const handleProbe = () =>
		probeMutation.mutate({
			body: connectionDirty ? connectionPayload(form.fields) : undefined,
			generation: probeGeneration,
			revision: connectionQuery.data?.revision,
		});
	const currentProbe =
		probeMutation.variables?.generation === probeGeneration &&
		probeMutation.variables?.revision === connectionQuery.data?.revision;
	const probeState =
		currentProbe && probeMutation.isSuccess
			? { status: "connected" as const, info: probeMutation.data }
			: currentProbe && probeMutation.isError
				? { status: "error" as const, message: probeMutation.error.message }
				: {
						status:
							currentProbe && probeMutation.isPending
								? ("checking" as const)
								: ("idle" as const),
					};
	const connectionNotice = form.saved ? "连接设置已保存。" : null;
	function change(patch: Partial<Fields>) {
		form.change({ ...form.fields, ...patch });
		setProbeGeneration((n) => n + 1);
	}
	const probeLabel =
		probeState.status === "checking"
			? "连接中…"
			: probeState.status === "connected"
				? `已连接 · ${probeState.info.profile}`
				: probeState.status === "error"
					? "未连接"
					: "未检查";

	return (
		<>
			{connectionQuery.isError && (
				<section className="settings-state">
					<InlineError error={connectionQuery.error} />
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => void connectionQuery.refetch()}
					>
						重试读取连接设置
					</button>
				</section>
			)}

			<section className="settings-section">
				<div className="settings-section-heading">
					<h3>连接</h3>
					<span className="anki-settings-status" role="status">
						<span
							className="anki-status-dot"
							data-state={probeState.status}
							aria-hidden="true"
						/>
						{probeLabel}
					</span>
				</div>

				<div className="anki-card">
					<div className="anki-card-row">
						<div className="anki-row-meta">
							<label className="anki-row-title" htmlFor="anki-connect-url">
								AnkiConnect 地址
							</label>
							<p className="anki-row-desc">
								连接本机运行的 Anki Desktop 与 AnkiConnect 插件（默认
								http://127.0.0.1:8765）。
							</p>
						</div>
						<div className="anki-row-control">
							<input
								id="anki-connect-url"
								type="url"
								value={urlInput}
								placeholder="http://127.0.0.1:8765"
								onChange={(event) => {
									change({ url: event.target.value });
								}}
							/>
							<button
								type="button"
								className="settings-button secondary"
								disabled={probeMutation.isPending}
								onClick={handleProbe}
							>
								{probeMutation.isPending ? "测试中…" : "测试连接"}
							</button>
						</div>
					</div>

					<div className="anki-card-row">
						<div className="anki-row-meta">
							<label className="anki-row-title" htmlFor="anki-connect-key">
								API 密钥
								<span className="anki-badge" data-tone="muted">
									可选
								</span>
							</label>
							<p className="anki-row-desc">
								{connectionQuery.data?.has_api_key && !clearApiKey
									? "已保存密钥。更改服务地址时旧密钥不会自动带往新地址。"
									: "如果 AnkiConnect 配置了访问密钥，请在此填写。"}
							</p>
						</div>
						<div className="anki-row-control">
							<input
								id="anki-connect-key"
								type="password"
								autoComplete="off"
								value={apiKeyInput}
								placeholder={
									connectionQuery.data?.has_api_key && !clearApiKey
										? "已配置（留空保持不变）"
										: "未设置"
								}
								onChange={(event) => {
									change({ key: event.target.value, clear: false });
								}}
							/>
							{connectionQuery.data?.has_api_key && !clearApiKey && (
								<button
									type="button"
									className="anki-text-action"
									data-tone="danger"
									onClick={() => {
										change({ key: "", clear: true });
									}}
								>
									清除
								</button>
							)}
						</div>
					</div>

					<div className="anki-connection-footer">
						<p
							className="anki-connection-note"
							role="status"
							data-tone={
								probeState.status === "error"
									? "error"
									: probeState.status === "connected" || connectionNotice
										? "success"
										: undefined
							}
						>
							{probeState.status === "error"
								? probeState.message
								: probeState.status === "connected"
									? `已连通 ${probeState.info.endpoint}（用户配置：${probeState.info.profile}，协议 ${probeState.info.protocol}）。`
									: connectionNotice
										? connectionNotice
										: connectionDirty
											? "有未保存的连接更改。可先测试连接，或直接保存。"
											: "所有材料共用这套连接设置。"}
						</p>
						<button
							type="button"
							className="settings-button primary"
							disabled={!connectionDirty || saveConnectionMutation.isPending}
							onClick={() => void handleSaveConnection()}
						>
							{saveConnectionMutation.isPending ? "保存中…" : "保存连接"}
						</button>
					</div>
				</div>
				{saveConnectionMutation.isError && (
					<div style={{ marginTop: 10 }}>
						<InlineError error={saveConnectionMutation.error} />
					</div>
				)}
			</section>
		</>
	);
}
