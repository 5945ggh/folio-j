import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { settingsReturnState } from "../navigation";
import { ConfirmDialog, InlineError } from "../Shared";
import {
	AnkiConfigurationEditor,
	AnkiPresetViewer,
} from "./AnkiConfigurationEditor";
import { AnkiConnectionSettings } from "./AnkiConnectionSettings";
import {
	type AnkiConfigurationResponse,
	ankiKeys,
	deleteAnkiConfiguration,
	getAnkiBuiltins,
	getAnkiCatalog,
	listAnkiConfigurations,
} from "./api";
import { findBuiltinNoteType } from "./draft";
import "./anki-settings.css";

type EditorView =
	| { kind: "list" }
	| {
			kind: "create";
			presetId?: string;
			copyConfig?: AnkiConfigurationResponse;
	  }
	| { kind: "edit"; configId: string }
	| { kind: "view-preset"; presetId: string };

export function AnkiSettings() {
	const queryClient = useQueryClient();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();

	const builtinsQuery = useQuery({
		queryKey: ankiKeys.builtins,
		queryFn: ({ signal }) => getAnkiBuiltins(signal),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const configsQuery = useQuery({
		queryKey: ankiKeys.configurations,
		queryFn: ({ signal }) => listAnkiConfigurations(signal),
	});

	const [deleting, setDeleting] = useState<AnkiConfigurationResponse | null>(
		null,
	);
	const [listNotice, setListNotice] = useState<string | null>(null);

	// Determine sub-view from query params so deep links from reader open the right editor.
	const configParam = searchParams.get("config");
	const presetParam = searchParams.get("preset");
	const copyParam = searchParams.get("copy");
	const viewPresetParam = searchParams.get("viewPreset");

	const [copySource, setCopySource] =
		useState<AnkiConfigurationResponse | null>(null);
	const copyConfig =
		copySource?.id === copyParam
			? copySource
			: configsQuery.data?.find((item) => item.id === copyParam);

	const view: EditorView =
		configParam === "new"
			? {
					kind: "create",
					presetId: presetParam ?? undefined,
					copyConfig: presetParam ? undefined : copyConfig,
				}
			: configParam
				? { kind: "edit", configId: configParam }
				: viewPresetParam
					? { kind: "view-preset", presetId: viewPresetParam }
					: { kind: "list" };

	const inEditor = view.kind === "create" || view.kind === "edit";

	const catalogQuery = useQuery({
		queryKey: ankiKeys.catalog,
		queryFn: ({ signal }) => getAnkiCatalog(signal),
		enabled: inEditor,
		retry: false,
	});

	const updateViewParams = useCallback(
		(next: Record<string, string | null>) => {
			const params = new URLSearchParams(searchParams);
			params.set("section", "anki");
			params.delete("copy");
			for (const [key, value] of Object.entries(next)) {
				if (value === null) params.delete(key);
				else params.set(key, value);
			}
			setSearchParams(params, { state: settingsReturnState(location) });
		},
		[searchParams, setSearchParams, location],
	);

	const openList = useCallback(() => {
		updateViewParams({ config: null, preset: null, viewPreset: null });
	}, [updateViewParams]);

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteAnkiConfiguration(id),
		onSuccess: (_data, id) => {
			void queryClient.invalidateQueries({ queryKey: ankiKeys.configurations });
			queryClient.removeQueries({ queryKey: ankiKeys.configuration(id) });
			setDeleting(null);
			setListNotice("已删除导出配置");
		},
	});

	if (view.kind === "view-preset") {
		const preset = builtinsQuery.data?.export_presets.find(
			(item) => item.id === view.presetId,
		);
		if (builtinsQuery.isPending) {
			return (
				<p className="settings-loading" role="status">
					正在加载系统预设…
				</p>
			);
		}
		if (!preset || !builtinsQuery.data) {
			return (
				<section className="settings-state">
					<p>未找到该系统预设。</p>
					<button
						type="button"
						className="settings-button secondary"
						onClick={openList}
					>
						返回 Anki 设置
					</button>
				</section>
			);
		}
		return (
			<AnkiPresetViewer
				preset={preset}
				builtins={builtinsQuery.data}
				onBack={openList}
				onCreatePersonal={() =>
					updateViewParams({
						config: "new",
						preset: preset.id,
						viewPreset: null,
					})
				}
			/>
		);
	}

	if (view.kind === "create" || view.kind === "edit") {
		const existing =
			view.kind === "edit"
				? configsQuery.data?.find((item) => item.id === view.configId)
				: undefined;
		const seedPreset =
			view.kind === "create" && view.presetId
				? builtinsQuery.data?.export_presets.find(
						(item) => item.id === view.presetId,
					)
				: undefined;

		if (
			(view.kind === "edit" && configsQuery.isPending) ||
			(view.kind === "create" &&
				((view.presetId && builtinsQuery.isPending) ||
					(copyParam && !view.copyConfig && configsQuery.isPending)))
		) {
			return (
				<p className="settings-loading" role="status">
					正在加载配置…
				</p>
			);
		}
		if (
			(view.kind === "edit" && !existing) ||
			(view.kind === "create" &&
				(view.presetId ? !seedPreset : copyParam && !view.copyConfig))
		) {
			const sourceError =
				view.kind === "create" && view.presetId
					? builtinsQuery.error
					: configsQuery.error;
			return (
				<section className="settings-state">
					{sourceError ? (
						<InlineError error={sourceError} />
					) : (
						<p>未找到该配置。</p>
					)}
					<button
						type="button"
						className="settings-button secondary"
						onClick={openList}
					>
						返回 Anki 设置
					</button>
				</section>
			);
		}

		return (
			<AnkiConfigurationEditor
				mode={view.kind}
				existing={existing}
				seedPreset={seedPreset}
				seedConfig={view.kind === "create" ? view.copyConfig : undefined}
				builtins={builtinsQuery.data}
				catalog={catalogQuery.isError ? undefined : catalogQuery.data}
				catalogLoading={catalogQuery.isFetching}
				catalogError={catalogQuery.isError ? catalogQuery.error : null}
				onRefreshCatalog={() => void catalogQuery.refetch()}
				onBack={openList}
				onSaved={(saved) => {
					setListNotice(`已保存配置「${saved.name}」`);
					openList();
				}}
				onSaveAsCopy={
					existing
						? (draftState) => {
								setCopySource({
									...existing,
									name: draftState.name || existing.name,
									deck: draftState.deck,
									note_type: draftState.noteType,
									fields: draftState.fields,
								});
								updateViewParams({
									config: "new",
									copy: existing.id,
									preset: null,
									viewPreset: null,
								});
							}
						: undefined
				}
			/>
		);
	}

	return (
		<div>
			<div className="settings-page-head">
				<h2>Anki</h2>
				<p>连接本机 AnkiConnect，管理跨素材复用的导出配置。</p>
			</div>

			<AnkiConnectionSettings />

			<section className="settings-section">
				<div className="settings-section-heading">
					<h3>导出配置</h3>
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => {
							setCopySource(null);
							updateViewParams({
								config: "new",
								preset: null,
								viewPreset: null,
							});
						}}
					>
						+ 新建配置
					</button>
				</div>

				{listNotice && (
					<p
						className="anki-connection-note"
						data-tone="success"
						role="status"
						style={{ marginBottom: 10 }}
					>
						{listNotice}
					</p>
				)}

				{(builtinsQuery.isPending || configsQuery.isPending) && (
					<p className="settings-loading" role="status">
						正在加载配置列表…
					</p>
				)}

				{configsQuery.isError && <InlineError error={configsQuery.error} />}
				{builtinsQuery.isError && <InlineError error={builtinsQuery.error} />}

				{(builtinsQuery.data || configsQuery.data) && (
					<div className="anki-card">
						{builtinsQuery.data?.export_presets.map((preset) => {
							const noteType = builtinsQuery.data?.note_types.find(
								(item) =>
									item.id === preset.note_type_ref.id &&
									item.version === preset.note_type_ref.version,
							);
							return (
								<div className="anki-card-row" key={preset.id}>
									<div className="anki-row-meta">
										<div className="anki-row-title">
											<span>{preset.name}</span>
											<span className="anki-badge">系统预设</span>
										</div>
										<p className="anki-row-desc">
											{noteType?.name ?? "内置笔记类型"} ·{" "}
											{preset.id === "export.vocabulary"
												? "通过选区、词典和原句回忆词义"
												: "以完整原句为中心整理理解与说明"}
										</p>
									</div>
									<div className="anki-row-actions">
										<button
											type="button"
											className="anki-text-action"
											onClick={() =>
												updateViewParams({
													config: null,
													preset: null,
													viewPreset: preset.id,
												})
											}
										>
											查看
										</button>
										<button
											type="button"
											className="anki-text-action"
											onClick={() => {
												setCopySource(null);
												updateViewParams({
													config: "new",
													preset: preset.id,
													viewPreset: null,
												});
											}}
										>
											以此创建配置
										</button>
									</div>
								</div>
							);
						})}

						{configsQuery.data?.map((config) => {
							const noteType = config.note_type ?? null;
							const builtinType = findBuiltinNoteType(
								builtinsQuery.data,
								noteType,
							);
							const summaryParts = [
								config.deck?.name || "未选默认卡组",
								noteType?.name ||
									builtinType?.name ||
									(noteType?.kind === "builtin"
										? "内置笔记类型"
										: "未选笔记类型"),
							];
							return (
								<div className="anki-card-row" key={config.id}>
									<div className="anki-row-meta">
										<div className="anki-row-title">
											<span>{config.name}</span>
											<span className="anki-badge" data-tone="muted">
												个人配置
											</span>
										</div>
										<p className="anki-row-desc">{summaryParts.join(" · ")}</p>
									</div>
									<div className="anki-row-actions">
										<button
											type="button"
											className="anki-text-action"
											onClick={() =>
												updateViewParams({
													config: config.id,
													preset: null,
													viewPreset: null,
												})
											}
										>
											编辑
										</button>
										<button
											type="button"
											className="anki-text-action"
											onClick={() => {
												setCopySource(config);
												updateViewParams({
													config: "new",
													copy: config.id,
													preset: null,
													viewPreset: null,
												});
											}}
										>
											另存为
										</button>
										<button
											type="button"
											className="anki-text-action"
											data-tone="danger"
											onClick={() => setDeleting(config)}
										>
											删除
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}

				<p className="anki-row-desc" style={{ marginTop: 10 }}>
					配置决定制卡浮窗显示的字段、目标卡组和笔记类型。
				</p>
			</section>

			{deleting && (
				<ConfirmDialog
					titleId="anki-delete-config-title"
					onClose={() => {
						if (!deleteMutation.isPending) setDeleting(null);
					}}
				>
					<h2 id="anki-delete-config-title">删除配置「{deleting.name}」？</h2>
					<p>
						删除后不会影响已经发送到 Anki 的笔记和卡片，仅移除这套导出配置。
					</p>
					{deleteMutation.isError && (
						<InlineError error={deleteMutation.error} />
					)}
					<div className="confirm-actions">
						<button
							type="button"
							data-dialog-cancel=""
							disabled={deleteMutation.isPending}
							onClick={() => setDeleting(null)}
						>
							取消
						</button>
						<button
							type="button"
							className="danger"
							disabled={deleteMutation.isPending}
							onClick={() => deleteMutation.mutate(deleting.id)}
						>
							{deleteMutation.isPending ? "删除中…" : "确认删除"}
						</button>
					</div>
				</ConfirmDialog>
			)}
		</div>
	);
}
