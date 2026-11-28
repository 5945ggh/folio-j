import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trimTrailingPunctuation } from "../content";
import { NativeSelect } from "../NativeSelect";
import { InlineError } from "../Shared";
import { useSettingsDraft } from "../settings/SettingsForms";
import {
	AnkiMappingField,
	FIELD_SOURCE_LABELS,
	FIELD_TYPE_LABELS,
	PRESENTATION_LABELS,
} from "./AnkiMappingField";
import {
	type AnkiBuiltins,
	type AnkiCatalog,
	type AnkiConfigurationInput,
	type AnkiConfigurationResponse,
	type AnkiDeckTarget,
	type AnkiExportPreset,
	type AnkiFieldDefinition,
	type AnkiNoteTypeTarget,
	ankiKeys,
	ankiTypeFieldsOptions,
	createAnkiConfiguration,
	updateAnkiConfiguration,
} from "./api";
import {
	createCustomFieldId,
	findBuiltinNoteType,
	latestBuiltinNoteTypes,
	resolveDeckInCatalog,
	resolveExternalNoteTypeInCatalog,
	validateFieldMappings,
} from "./draft";

type EditorDraftState = {
	name: string;
	deck: AnkiDeckTarget | null;
	noteType: AnkiNoteTypeTarget | null;
	fields: AnkiFieldDefinition[];
};

function defaultNewFields(): AnkiFieldDefinition[] {
	return [
		{
			id: "selection",
			label: "词条",
			type: "text",
			source: "selection",
			target_field: null,
			required: false,
			presentation: "common",
			multiline: false,
		},
		{
			id: "meaning",
			label: "词汇释义",
			type: "text",
			source: "manual",
			target_field: null,
			required: false,
			presentation: "common",
			multiline: true,
		},
		{
			id: "sentence",
			label: "原句",
			type: "text",
			source: "sentence",
			target_field: null,
			required: false,
			presentation: "common",
			multiline: true,
		},
		{
			id: "source",
			label: "出处",
			type: "text",
			source: "sourceMetadata",
			target_field: null,
			required: false,
			presentation: "summary",
			multiline: false,
		},
	];
}

function noteTypeSelectValue(target: AnkiNoteTypeTarget | null): string {
	if (!target) return "";
	if (target.kind === "builtin") {
		return `builtin:${target.id}@${target.version}`;
	}
	return `external:${target.id ?? target.name}`;
}

function retainTargetFields(
	fields: AnkiFieldDefinition[],
	names: string[],
): AnkiFieldDefinition[] {
	return fields.map((field) =>
		field.target_field && !names.includes(field.target_field)
			? { ...field, target_field: null }
			: field,
	);
}

function serializeDraft(state: EditorDraftState): string {
	return JSON.stringify(state);
}

export function AnkiPresetViewer({
	preset,
	builtins,
	onBack,
	onCreatePersonal,
}: {
	preset: AnkiExportPreset;
	builtins: AnkiBuiltins;
	onBack: () => void;
	onCreatePersonal: () => void;
}) {
	const noteType = builtins.note_types.find(
		(item) =>
			item.id === preset.note_type_ref.id &&
			item.version === preset.note_type_ref.version,
	);
	return (
		<div>
			<button
				type="button"
				className="settings-back-link anki-text-action"
				onClick={onBack}
			>
				← 返回 Anki 设置
			</button>
			<div className="anki-editor-head">
				<div className="anki-editor-title-group">
					<div className="anki-row-title">
						<h2 style={{ margin: 0, fontSize: 21, fontWeight: 500 }}>
							{preset.name}
						</h2>
						<span className="anki-badge">系统预设</span>
					</div>
					<p className="anki-row-desc" style={{ margin: 0 }}>
						系统预设不可直接修改。你可以以此新建导出配置，设置默认卡组并按需调整字段映射。
					</p>
				</div>
				<button
					type="button"
					className="settings-button primary"
					onClick={onCreatePersonal}
				>
					以此新建配置
				</button>
			</div>

			<section className="settings-section">
				<div className="settings-section-heading">
					<h3>目标设置</h3>
				</div>
				<div className="anki-card">
					<div className="anki-card-row">
						<div className="anki-row-meta">
							<div className="anki-row-title">默认卡组</div>
							<p className="anki-row-desc">
								未设置默认卡组，制卡时从当前 Anki 用户选择
							</p>
						</div>
					</div>
					<div className="anki-card-row">
						<div className="anki-row-meta">
							<div className="anki-row-title">笔记类型</div>
							<p className="anki-row-desc">
								{noteType?.name ?? "内置笔记类型"}（内置 ·{" "}
								{noteType?.card_templates.length ?? 1} 个卡片模板 ·{" "}
								{noteType?.fields.length ?? preset.fields.length} 个字段）
							</p>
						</div>
					</div>
				</div>
			</section>

			<section className="settings-section">
				<div className="settings-section-heading">
					<h3>字段映射</h3>
				</div>
				<div className="anki-card">
					{preset.fields.map((field) => (
						<div className="anki-mapping-item" key={field.id}>
							<div className="anki-mapping-row">
								<div>
									<div className="anki-mapping-label">
										<span>{field.label}</span>
										<span className="anki-badge" data-tone="muted">
											{FIELD_TYPE_LABELS[field.type]}
										</span>
									</div>
									<div className="anki-mapping-meta">
										<span>{PRESENTATION_LABELS[field.presentation]}</span>
										<span>· {FIELD_SOURCE_LABELS[field.source]}</span>
										{field.required && (
											<span className="anki-mapping-required">· 必填</span>
										)}
									</div>
								</div>
								<span className="anki-mapping-arrow" aria-hidden="true">
									→
								</span>
								<div className="anki-row-title">
									{field.target_field || "未映射"}
								</div>
								<span />
							</div>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}

export function AnkiConfigurationEditor({
	mode,
	existing,
	seedPreset,
	seedConfig,
	builtins,
	catalog,
	catalogLoading,
	catalogError,
	onRefreshCatalog,
	onBack,
	onSaved,
	onSaveAsCopy,
}: {
	mode: "create" | "edit";
	existing?: AnkiConfigurationResponse;
	seedPreset?: AnkiExportPreset;
	seedConfig?: AnkiConfigurationResponse;
	builtins: AnkiBuiltins | undefined;
	catalog: AnkiCatalog | undefined;
	catalogLoading: boolean;
	catalogError: Error | null;
	onRefreshCatalog: () => void;
	onBack: () => void;
	onSaved: (saved: AnkiConfigurationResponse) => void;
	onSaveAsCopy?: (draft: EditorDraftState) => void;
}) {
	const queryClient = useQueryClient();

	const initialState = useMemo<EditorDraftState>(() => {
		if (mode === "edit" && existing) {
			return {
				name: existing.name,
				deck: existing.deck ?? null,
				noteType: existing.note_type ?? null,
				fields: existing.fields.map((item) => ({ ...item })),
			};
		}
		if (seedConfig) {
			return {
				name: `${seedConfig.name}（副本）`,
				deck: seedConfig.deck ?? null,
				noteType: seedConfig.note_type ?? null,
				fields: seedConfig.fields.map((item) => ({ ...item })),
			};
		}
		if (seedPreset) {
			return {
				name: `${seedPreset.name}（个人）`,
				deck: seedPreset.deck ?? null,
				noteType: {
					kind: "builtin",
					id: seedPreset.note_type_ref.id,
					version: seedPreset.note_type_ref.version,
					scope: null,
				},
				fields: seedPreset.fields.map((item) => ({ ...item })),
			};
		}
		return {
			name: "",
			deck: null,
			noteType: null,
			fields: defaultNewFields(),
		};
	}, [mode, existing, seedPreset, seedConfig]);

	const [draft, setDraft] = useState<EditorDraftState>(initialState);
	const [baseline, setBaseline] = useState(() => serializeDraft(initialState));
	const [expandedFieldId, setExpandedFieldId] = useState<string | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);
	const [returnAfterSave, setReturnAfterSave] =
		useState<AnkiConfigurationResponse | null>(null);

	// Reset draft only when switching to a different configuration record.
	const editorKey = `${mode}:${existing?.id ?? seedPreset?.id ?? seedConfig?.id ?? "new"}`;
	const lastEditorKey = useRef(editorKey);
	useEffect(() => {
		if (lastEditorKey.current === editorKey) return;
		lastEditorKey.current = editorKey;
		setDraft(initialState);
		setBaseline(serializeDraft(initialState));
		setExpandedFieldId(null);
		setLocalError(null);
		setReturnAfterSave(null);
	}, [editorKey, initialState]);

	const dirty = serializeDraft(draft) !== baseline;

	const builtinNoteType = findBuiltinNoteType(builtins, draft.noteType);
	const matchedExternalNoteType = resolveExternalNoteTypeInCatalog(
		draft.noteType,
		catalog,
	);
	const externalFieldsQuery = useQuery(
		ankiTypeFieldsOptions(catalog, matchedExternalNoteType?.id),
	);

	const [changedType, setChangedType] = useState<AnkiNoteTypeTarget | null>(
		null,
	);
	const verifyingType =
		changedType !== null &&
		draft.noteType === changedType &&
		Boolean(matchedExternalNoteType) &&
		!externalFieldsQuery.isError &&
		!externalFieldsQuery.isPaused;
	useEffect(() => {
		if (
			!verifyingType ||
			externalFieldsQuery.isFetching ||
			!externalFieldsQuery.data
		)
			return;
		const names = externalFieldsQuery.data.fields;
		setDraft((current) =>
			current.noteType === changedType
				? { ...current, fields: retainTargetFields(current.fields, names) }
				: current,
		);
		setChangedType(null);
	}, [
		verifyingType,
		changedType,
		externalFieldsQuery.data,
		externalFieldsQuery.isFetching,
	]);
	const knownTargetFields = useMemo<string[] | null>(() => {
		if (builtinNoteType) return builtinNoteType.fields;
		if (externalFieldsQuery.data) return externalFieldsQuery.data.fields;
		return null;
	}, [builtinNoteType, externalFieldsQuery.data]);
	let unverifiedTargetLabel = "（尚未确认）";
	if (draft.noteType?.kind === "external") {
		if (catalogLoading || externalFieldsQuery.isFetching)
			unverifiedTargetLabel = "（正在加载）";
		else if (!catalog) unverifiedTargetLabel = "（未连接）";
	}

	const mappingIssues = useMemo(
		() => validateFieldMappings(draft.fields, knownTargetFields),
		[draft.fields, knownTargetFields],
	);
	const issueByFieldId = useMemo(() => {
		const map = new Map<string, string>();
		for (const issue of mappingIssues) {
			if (!map.has(issue.fieldId)) map.set(issue.fieldId, issue.message);
		}
		return map;
	}, [mappingIssues]);

	const saveMutation = useMutation({
		mutationFn: async (input: AnkiConfigurationInput) => {
			if (mode === "edit" && existing) {
				return updateAnkiConfiguration(existing.id, input);
			}
			return createAnkiConfiguration(input);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ankiKeys.configurations });
		},
	});

	const performSave = useCallback(
		async (returnToList = false): Promise<boolean> => {
			setLocalError(null);
			if (verifyingType) {
				setLocalError("正在核对目标类型的字段，请稍候。");
				return false;
			}
			const trimmedName = draft.name.trim();
			if (!trimmedName) {
				setLocalError("请填写配置名称。");
				return false;
			}
			if (!draft.fields.length) {
				setLocalError("至少保留一个字段。");
				return false;
			}
			const emptyLabel = draft.fields.find((field) => !field.label.trim());
			if (emptyLabel) {
				setLocalError("存在未命名的字段，请补全字段名称。");
				setExpandedFieldId(emptyLabel.id);
				return false;
			}
			const invalidMapping = mappingIssues.find(
				(item) => item.kind !== "unknown_target",
			);
			if (invalidMapping) {
				setLocalError(invalidMapping.message);
				setExpandedFieldId(invalidMapping.fieldId);
				return false;
			}
			const payload: AnkiConfigurationInput = {
				name: trimmedName,
				deck: draft.deck,
				note_type: draft.noteType,
				fields: draft.fields.map((field) => ({
					...field,
					label: field.label.trim(),
					target_field: field.target_field || null,
				})),
			};
			try {
				const saved = await saveMutation.mutateAsync(payload);
				setBaseline(serializeDraft(draft));
				if (returnToList) setReturnAfterSave(saved);
				return true;
			} catch {
				return false;
			}
		},
		[draft, mappingIssues, saveMutation, verifyingType],
	);

	useSettingsDraft({
		id: `anki-config-${editorKey}`,
		label: draft.name.trim() || "Anki 导出配置",
		dirty,
		pending: saveMutation.isPending,
		save: performSave,
		discard: () => {
			setDraft(initialState);
			setLocalError(null);
		},
	});

	useEffect(() => {
		if (!returnAfterSave || saveMutation.isPending) return;
		setReturnAfterSave(null);
		if (!dirty) onSaved(returnAfterSave);
	}, [returnAfterSave, saveMutation.isPending, dirty, onSaved]);

	const matchedDeck = resolveDeckInCatalog(draft.deck, catalog);
	const unmatchedTargetLabel = catalogLoading
		? "（正在加载）"
		: catalog
			? "（当前 Anki 中未找到）"
			: "（未连接）";
	const connectionError =
		catalogError && trimTrailingPunctuation(catalogError.message);
	const currentDeckValue = matchedDeck
		? matchedDeck.id
		: draft.deck
			? `__saved__:${draft.deck.name}`
			: "";

	const currentNoteTypeValue = noteTypeSelectValue(draft.noteType);
	const latestBuiltinTypes = latestBuiltinNoteTypes(builtins);
	const originalBuiltinType = findBuiltinNoteType(
		builtins,
		initialState.noteType,
	);
	const legacyBuiltinType =
		originalBuiltinType && !latestBuiltinTypes.includes(originalBuiltinType)
			? originalBuiltinType
			: null;

	const handleDeckChange = (value: string) => {
		if (!value) {
			setDraft((prev) => ({ ...prev, deck: null }));
			return;
		}
		if (value.startsWith("__saved__:")) return;
		if (!catalog) return;
		const found = catalog.decks.find((item) => item.id === value);
		if (!found) return;
		setDraft((prev) => ({
			...prev,
			deck: {
				id: found.id,
				name: found.name,
				scope: { url: catalog.endpoint, profile: catalog.profile },
			},
		}));
	};

	const handleNoteTypeChange = (value: string) => {
		if (!value) {
			setDraft((prev) => ({ ...prev, noteType: null }));
			return;
		}
		if (value.startsWith("builtin:")) {
			const [id, rawVersion] = value.slice("builtin:".length).split("@");
			const version = Number(rawVersion || 1);
			const found = builtins?.note_types.find(
				(item) => item.id === id && item.version === version,
			);

			setDraft((prev) => ({
				...prev,
				noteType: {
					kind: "builtin",
					id: id ?? "",
					version,
					scope: null,
				},
				fields: found
					? retainTargetFields(prev.fields, found.fields)
					: prev.fields,
			}));
			return;
		}
		if (value.startsWith("external:") && catalog) {
			const targetId = value.slice("external:".length);
			const found = catalog.note_types.find((item) => item.id === targetId);
			if (!found) return;
			const nextTarget: AnkiNoteTypeTarget = {
				kind: "external",
				id: found.id,
				name: found.name,
				scope: { url: catalog.endpoint, profile: catalog.profile },
			};
			setDraft((prev) => ({ ...prev, noteType: nextTarget }));
			setChangedType(nextTarget);
		}
	};

	const updateField = (
		id: string,
		patch: Partial<AnkiFieldDefinition>,
	): void => {
		setDraft((prev) => ({
			...prev,
			fields: prev.fields.map((field) =>
				field.id === id ? { ...field, ...patch } : field,
			),
		}));
	};

	const moveField = (index: number, delta: -1 | 1): void => {
		const target = index + delta;
		setDraft((prev) => {
			if (target < 0 || target >= prev.fields.length) return prev;
			const next = [...prev.fields];
			const current = next[index];
			const other = next[target];
			if (!current || !other) return prev;
			next[index] = other;
			next[target] = current;
			return { ...prev, fields: next };
		});
	};

	const removeField = (id: string): void => {
		setDraft((prev) => ({
			...prev,
			fields: prev.fields.filter((field) => field.id !== id),
		}));
		if (expandedFieldId === id) setExpandedFieldId(null);
	};

	const addField = (): void => {
		const id = createCustomFieldId();
		const nextField: AnkiFieldDefinition = {
			id,
			label: "补充说明",
			type: "text",
			source: "manual",
			target_field: null,
			required: false,
			presentation: "more",
			multiline: true,
		};
		setDraft((prev) => ({ ...prev, fields: [...prev.fields, nextField] }));
		setExpandedFieldId(id);
	};

	return (
		<div inert={saveMutation.isPending} aria-busy={saveMutation.isPending}>
			<button
				type="button"
				className="settings-back-link anki-text-action"
				onClick={onBack}
			>
				← 返回 Anki 设置
			</button>

			<div className="anki-editor-head">
				<div className="anki-editor-title-group">
					<div className="anki-row-title">
						<input
							type="text"
							className="anki-name-input"
							aria-label="配置名称"
							placeholder="例如：日语阅读词汇"
							value={draft.name}
							onChange={(event) =>
								setDraft((prev) => ({ ...prev, name: event.target.value }))
							}
						/>
						<span className="anki-badge" data-tone="muted">
							{mode === "edit" ? "个人配置" : "新建个人配置"}
						</span>
					</div>
					<p className="anki-row-desc" style={{ margin: 0 }}>
						设置制卡时使用的卡组、笔记类型与字段映射。
					</p>
				</div>
				{mode === "edit" && onSaveAsCopy && (
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => onSaveAsCopy(draft)}
					>
						另存为新配置
					</button>
				)}
			</div>

			{!catalog && (
				<div className="anki-offline-banner" role="status">
					<span>
						{catalogLoading
							? "正在加载 Anki 卡组与笔记类型…"
							: connectionError
								? `未连接 Anki（${connectionError}），可离线编辑并保存配置。`
								: "当前未连接 Anki，你仍可离线编辑并保存配置。"}
					</span>
					<button
						type="button"
						className="settings-button secondary"
						disabled={catalogLoading}
						onClick={onRefreshCatalog}
					>
						{catalogLoading ? "正在加载…" : "重新加载"}
					</button>
				</div>
			)}

			<section className="settings-section">
				<div className="settings-section-heading">
					<h3>目标设置</h3>
					{catalog && (
						<span className="anki-row-desc" style={{ margin: 0 }}>
							当前 Anki 用户：{catalog.profile}
						</span>
					)}
				</div>
				<div className="anki-target-grid">
					<div className="anki-field-group">
						<label htmlFor="anki-config-deck">卡组</label>
						<NativeSelect
							id="anki-config-deck"
							wrapperClassName="anki-select-wrap"
							value={currentDeckValue}
							onChange={(event) => handleDeckChange(event.target.value)}
						>
							<option value="">暂不设置默认卡组</option>
							{draft.deck && !matchedDeck && (
								<option value={`__saved__:${draft.deck.name}`}>
									{draft.deck.name}
									{unmatchedTargetLabel}
								</option>
							)}
							{catalog?.decks.map((deck) => (
								<option key={deck.id} value={deck.id}>
									{deck.name}
								</option>
							))}
						</NativeSelect>
					</div>

					<div className="anki-field-group">
						<label htmlFor="anki-config-note-type">笔记类型</label>
						<NativeSelect
							id="anki-config-note-type"
							wrapperClassName="anki-select-wrap"
							value={currentNoteTypeValue}
							onChange={(event) =>
								void handleNoteTypeChange(event.target.value)
							}
						>
							<option value="">暂不设置笔记类型</option>
							{draft.noteType?.kind === "external" &&
								!matchedExternalNoteType && (
									<option value={currentNoteTypeValue}>
										{draft.noteType.name}
										{unmatchedTargetLabel}
									</option>
								)}
							{latestBuiltinTypes.length > 0 && (
								<optgroup label="内置笔记类型">
									{latestBuiltinTypes.map((item) => (
										<option
											key={item.id}
											value={`builtin:${item.id}@${item.version}`}
										>
											{item.name}
										</option>
									))}
									{legacyBuiltinType && (
										<option
											value={`builtin:${legacyBuiltinType.id}@${legacyBuiltinType.version}`}
										>
											{legacyBuiltinType.name}（旧版）
										</option>
									)}
								</optgroup>
							)}
							{catalog?.note_types.length ? (
								<optgroup label={`Anki 已有类型（${catalog.profile}）`}>
									{catalog.note_types.map((item) => (
										<option key={item.id} value={`external:${item.id}`}>
											{item.name}
											{builtins?.note_types.some(
												(type) => type.name === item.name,
											) && "（使用 Anki 已有模板）"}
										</option>
									))}
								</optgroup>
							) : null}
						</NativeSelect>
					</div>
				</div>
				<p className="anki-row-desc" style={{ marginTop: 8 }}>
					默认卡组可留空，制卡时再选择；笔记类型需在此设置后才能发送。
				</p>
			</section>

			<section className="settings-section">
				<div className="settings-section-heading">
					<h3>字段映射</h3>
					<button
						type="button"
						className="settings-button secondary"
						onClick={addField}
					>
						+ 新增字段
					</button>
				</div>
				<p className="anki-row-desc" style={{ margin: "0 0 12px" }}>
					将 Folio-J 字段对应到所选笔记类型的 Anki
					字段。列表顺序即制卡浮窗中的显示顺序。
				</p>

				<div className="anki-mapping-head" aria-hidden="true">
					<span>Folio-J 字段 / 类型</span>
					<span />
					<span>Anki 字段</span>
					<span>操作</span>
				</div>

				<div className="anki-card">
					{draft.fields.map((field, index) => (
						<AnkiMappingField
							key={field.id}
							field={field}
							first={index === 0}
							last={index === draft.fields.length - 1}
							issue={issueByFieldId.get(field.id)}
							expanded={expandedFieldId === field.id}
							knownTargetFields={knownTargetFields}
							unverifiedTargetLabel={unverifiedTargetLabel}
							onChange={(patch) => updateField(field.id, patch)}
							onRemove={() => removeField(field.id)}
							onMove={(direction) => moveField(index, direction)}
							onToggle={() =>
								setExpandedFieldId((prev) =>
									prev === field.id ? null : field.id,
								)
							}
						/>
					))}
				</div>
				<p className="anki-row-desc" style={{ marginTop: 10 }}>
					标记为必填的字段在发送前不能为空；未映射的字段不会发送到 Anki。
				</p>
			</section>

			{localError && (
				<p className="anki-mapping-issue" role="alert">
					{localError}
				</p>
			)}
			{saveMutation.isError && <InlineError error={saveMutation.error} />}

			<div className="anki-editor-footer">
				<button
					type="button"
					className="settings-button secondary"
					disabled={saveMutation.isPending}
					onClick={onBack}
				>
					取消
				</button>
				<button
					type="button"
					className="settings-button primary"
					disabled={saveMutation.isPending || verifyingType}
					onClick={() => void performSave(true)}
				>
					{saveMutation.isPending ? "保存中…" : "保存配置"}
				</button>
			</div>
		</div>
	);
}
