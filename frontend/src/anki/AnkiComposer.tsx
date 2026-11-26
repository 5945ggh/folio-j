import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type RefObject,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Link } from "react-router";
import { trimTrailingPunctuation } from "../content";
import { dictionaryKey, getDictionary } from "../dictionary/dictionary-api";
import type { ChapterTranslation } from "../materials/chapter-translations-query";
import type { ScreenAnchor } from "../materials/reader-study";
import type { ChapterSegment } from "../materials/study-api";
import { NativeSelect } from "../NativeSelect";
import { useViewActivity } from "../navigation/view-activity";
import { ConfirmDialog } from "../Shared";
import { AnkiCardPreviewModal } from "./AnkiCardPreviewModal";
import { MediaFieldControl } from "./AnkiMediaField";
import { AnkiReferencePane } from "./AnkiReferencePane";
import {
	type AnkiCollectionInfo,
	type AnkiDeckTarget,
	type AnkiFieldDefinition,
	ankiKeys,
	ankiTypeFieldsOptions,
	getAnkiBuiltins,
	getAnkiCatalog,
	listAnkiConfigurations,
	probeAnkiConnection,
} from "./api";
import {
	type AnkiMaterialContext,
	type AnkiSentenceFocus,
	intersectingRecords,
} from "./context";
import {
	type AnkiDraftValues,
	buildConfigOptions,
	createInitialDraft,
	fieldValueKey,
	findBuiltinNoteType,
	getFieldText,
	getSentenceFocus,
	mediaFileIssue,
	missingRequiredFieldIds,
	resolveDeckInCatalog,
	resolveExternalNoteTypeInCatalog,
	resolveInitialConfigId,
	scopeMatchesCatalog,
	sentenceFocusFromSelection,
	supportsSentenceFocus,
	updateDraftFieldText,
	usesSourceSentence,
	validateFieldMappings,
} from "./draft";
import {
	getRememberedDeck,
	loadAnkiPreferences,
	rememberLastConfigurationId,
	rememberRecentDeck,
} from "./preferences";
import { type ExportSnapshot, useAnkiExport } from "./use-anki-export";
import { useAnkiPosition } from "./use-anki-position";
import "./anki-composer.css";
import "../materials/reader-popover.css";

type ExportNotice = {
	tone: "error" | "warn" | "info";
	text: string;
	allowDuplicate?: boolean;
} | null;

function withMediaWarning(message: string, mediaMayRemain: boolean): string {
	return mediaMayRemain
		? `${trimTrailingPunctuation(message)}（部分媒体文件可能已上传）。`
		: message;
}

type PaneFocus = "reference" | "toggle" | { fieldId: string };

export function AnkiComposer({
	context,
	cardRef,
	night = false,
	recordsStatus,
	materialId,
	anchor,
	chapterSegments,
	chapterTranslations,
	settingsState,
	onConnectionStatus,
	onClose,
	onExported,
}: {
	context: AnkiMaterialContext;
	cardRef: RefObject<HTMLElement | null>;
	night?: boolean;
	recordsStatus: "ready" | "error" | "loading";
	materialId: string;
	anchor: ScreenAnchor;
	chapterSegments: readonly ChapterSegment[];
	chapterTranslations: readonly ChapterTranslation[];
	settingsState: unknown;
	onConnectionStatus?: (
		status:
			| { state: "connected"; info: AnkiCollectionInfo }
			| { state: "error"; message: string },
	) => void;
	onClose: () => void;
	onExported: (message: string) => void;
}) {
	const queryClient = useQueryClient();
	const activity = useViewActivity();

	const matchedRecords = useMemo(
		() =>
			intersectingRecords(
				context.reference,
				chapterSegments,
				chapterTranslations,
			),
		[context.reference, chapterSegments, chapterTranslations],
	);

	const dictionaryStatusQuery = useQuery({
		queryKey: dictionaryKey,
		queryFn: ({ signal }) => getDictionary(signal),
		staleTime: 60_000,
		retry: false,
	});
	const hasDictionary =
		Boolean(context.dictionarySeed) ||
		dictionaryStatusQuery.data?.ready === true;

	const referenceCount =
		matchedRecords.segments.length + matchedRecords.translations.length;
	const hasAnyReference =
		hasDictionary ||
		referenceCount > 0 ||
		!!context.initialTranslation ||
		recordsStatus !== "ready";

	const [showReference, setShowReference] = useState(
		() => context.origin !== "selection",
	);
	const [hasOpenedReference, setHasOpenedReference] = useState(showReference);
	const referencePaneId = useId();
	const referencePaneRef = useRef<HTMLDivElement>(null);
	const draftPaneRef = useRef<HTMLDivElement>(null);
	const referenceToggleRef = useRef<HTMLButtonElement>(null);
	const referenceOpenerField = useRef<string | null>(null);
	const nextPaneFocus = useRef<PaneFocus | null>(null);

	// Data queries
	const builtinsQuery = useQuery({
		queryKey: ankiKeys.builtins,
		queryFn: ({ signal }) => getAnkiBuiltins(signal),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const configsQuery = useQuery({
		queryKey: ankiKeys.configurations,
		queryFn: ({ signal }) => listAnkiConfigurations(signal),
	});
	const catalogQuery = useQuery({
		queryKey: ankiKeys.catalog,
		queryFn: ({ signal }) => getAnkiCatalog(signal),
		retry: false,
	});

	// Re-verify catalog & configurations when returning from settings in the same tab.
	const lastActivation = useRef(activity.activation);
	useEffect(() => {
		if (!activity.active) return;
		if (lastActivation.current === activity.activation) return;
		lastActivation.current = activity.activation;
		void queryClient.invalidateQueries({ queryKey: ankiKeys.configurations });
		void catalogQuery.refetch();
	}, [activity.active, activity.activation, queryClient, catalogQuery]);

	const configOptions = useMemo(
		() => buildConfigOptions(builtinsQuery.data, configsQuery.data),
		[builtinsQuery.data, configsQuery.data],
	);

	const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
	const resolvedConfigId = useMemo(() => {
		if (
			selectedConfigId &&
			configOptions.some((item) => item.id === selectedConfigId)
		) {
			return selectedConfigId;
		}
		if (builtinsQuery.isPending || configsQuery.isPending) return null;
		const prefs = loadAnkiPreferences();
		return resolveInitialConfigId(
			configOptions,
			prefs.lastConfigurationId,
			context.origin,
		);
	}, [
		selectedConfigId,
		configOptions,
		context.origin,
		builtinsQuery.isPending,
		configsQuery.isPending,
	]);
	if (resolvedConfigId && resolvedConfigId !== selectedConfigId) {
		setSelectedConfigId(resolvedConfigId);
	}

	const activeConfig = useMemo(
		() => configOptions.find((item) => item.id === resolvedConfigId) ?? null,
		[configOptions, resolvedConfigId],
	);

	// Draft state preserved across config switches
	const [draft, setDraft] = useState<AnkiDraftValues>(createInitialDraft);
	const mediaUrlsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const urls = mediaUrlsRef.current;
		return () => {
			for (const url of urls) URL.revokeObjectURL(url);
		};
	}, []);

	// Deck override for this export
	const [deckOverride, setDeckOverride] = useState<
		AnkiDeckTarget | "choose" | null
	>(null);
	const catalog = catalogQuery.isError ? undefined : catalogQuery.data;
	const connectionError = catalogQuery.isError
		? trimTrailingPunctuation(catalogQuery.error.message)
		: "";
	const scope = catalog && JSON.stringify([catalog.endpoint, catalog.profile]);
	const previousScope = useRef(scope);
	const targetChanged = Boolean(
		scope && previousScope.current && scope !== previousScope.current,
	);
	useEffect(() => {
		if (!scope) return;
		if (previousScope.current && previousScope.current !== scope)
			setDeckOverride("choose");
		previousScope.current = scope;
	}, [scope]);
	const selectedDeck =
		targetChanged || deckOverride === "choose"
			? null
			: (deckOverride ?? activeConfig?.deck);
	const effectiveDeck = useMemo(() => {
		if (targetChanged || deckOverride === "choose") return null;
		if (selectedDeck)
			return catalog
				? resolveDeckInCatalog(selectedDeck, catalog)
				: selectedDeck;
		if (!catalog) return null;
		const remembered = getRememberedDeck(catalog.endpoint, catalog.profile);
		return (
			remembered &&
			resolveDeckInCatalog(
				{
					...remembered,
					scope: { url: catalog.endpoint, profile: catalog.profile },
				},
				catalog,
			)
		);
	}, [catalog, deckOverride, selectedDeck, targetChanged]);

	const builtinNoteType = findBuiltinNoteType(
		builtinsQuery.data,
		activeConfig?.noteType ?? null,
	);
	const resolvedExternalNoteType = resolveExternalNoteTypeInCatalog(
		activeConfig?.noteType ?? null,
		catalog,
	);

	const targetType = activeConfig?.noteType;
	const noteTypeName =
		targetType?.kind === "builtin"
			? targetType.scope && !scopeMatchesCatalog(targetType.scope, catalog)
				? null
				: (targetType.name ?? builtinNoteType?.name)
			: resolvedExternalNoteType?.name;
	const externalFieldsQuery = useQuery(
		ankiTypeFieldsOptions(catalog, resolvedExternalNoteType?.id),
	);

	const knownTargetFields = useMemo<string[] | null>(() => {
		if (builtinNoteType) return builtinNoteType.fields;
		if (externalFieldsQuery.data) return externalFieldsQuery.data.fields;
		return null;
	}, [builtinNoteType, externalFieldsQuery.data]);

	const mappingIssues = useMemo(
		() =>
			activeConfig
				? validateFieldMappings(activeConfig.fields, knownTargetFields)
				: [],
		[activeConfig, knownTargetFields],
	);

	const needsTargetAttention =
		Boolean(catalog) &&
		(!effectiveDeck ||
			!activeConfig?.noteType ||
			!noteTypeName ||
			mappingIssues.length > 0);

	const [manualExpansion, setTargetExpanded] = useState<boolean | null>(null);
	const targetExpanded = manualExpansion ?? needsTargetAttention;
	const [inlineEditing, setInlineEditing] = useState<Record<string, boolean>>(
		{},
	);
	const [sentenceSelection, setSentenceSelection] = useState<{
		key: string;
		value: string;
		focus: AnkiSentenceFocus;
	} | null>(null);
	const [errorFieldId, setErrorFieldId] = useState<string | null>(null);
	const [localNotice, setNotice] = useState<ExportNotice>(null);
	const [previewOpen, setPreviewOpen] = useState(false);

	const [confirmDiscard, setConfirmDiscard] = useState(false);

	// Track which text field is currently targeted by the reference pane
	const textFields = useMemo(
		() => (activeConfig?.fields ?? []).filter((item) => item.type === "text"),
		[activeConfig],
	);
	const defaultFocusField = useMemo(
		() =>
			textFields.find((item) => item.source === "manual" && item.required) ??
			textFields.find((item) => item.source === "manual") ??
			textFields[0],
		[textFields],
	);
	const [activeRefFieldId, setActiveRefFieldId] = useState<string>(
		defaultFocusField?.id ?? "",
	);
	useEffect(() => {
		if (
			defaultFocusField &&
			!textFields.some((item) => item.id === activeRefFieldId)
		) {
			setActiveRefFieldId(defaultFocusField.id);
		}
	}, [defaultFocusField, textFields, activeRefFieldId]);

	const fieldRefs = useRef<
		Record<
			string,
			HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | null
		>
	>({});
	const awaitingReadings =
		context.sentenceRubyPending &&
		activeConfig?.fields.some((field) =>
			usesSourceSentence(
				activeConfig,
				field,
				getFieldText(draft, field, context),
				context,
			),
		);
	const snapshot = useMemo<ExportSnapshot | null>(() => {
		const type = activeConfig?.noteType;
		if (
			awaitingReadings ||
			!activeConfig ||
			!type ||
			!catalog ||
			!effectiveDeck ||
			!noteTypeName
		)
			return null;
		return {
			config: activeConfig,
			draft,
			context,
			target: {
				endpoint: catalog.endpoint,
				profile: catalog.profile,
				deck: effectiveDeck.name,
				deck_id: effectiveDeck.id,
				note_type: noteTypeName,
				note_type_id: resolvedExternalNoteType?.id ?? null,
				builtin_type:
					type.kind === "builtin"
						? { id: type.id, version: type.version }
						: null,
			},
		};
	}, [
		activeConfig,
		awaitingReadings,
		catalog,
		effectiveDeck,
		draft,
		context,
		noteTypeName,
		resolvedExternalNoteType,
	]);
	const submission = useAnkiExport(
		snapshot,
		(response, submitted, sameSnapshot) => {
			if (response.status === "created") {
				const { target, config } = submitted;
				rememberLastConfigurationId(config.id);
				rememberRecentDeck(target.endpoint, target.profile, {
					id: target.deck_id ?? null,
					name: target.deck,
				});
				const count = response.card_ids?.length;
				const suffix = count ? `（生成 ${count} 张卡片）` : "";
				const message = `已发送到「${target.deck}」${suffix}`;
				if (sameSnapshot) onExported(message);
				else setNotice({ tone: "info", text: message });
			} else if (response.status === "target_changed") {
				setDeckOverride("choose");
				setTargetExpanded(true);
				setNotice({
					tone: "error",
					text: withMediaWarning(
						response.message || "目标已变化，请重新选择卡组。",
						response.media_may_remain,
					),
				});
				void catalogQuery.refetch();
			} else if (response.status === "incompatible_type") {
				setTargetExpanded(true);
			} else if (response.status === "invalid" && response.field_id) {
				const id = response.field_id;
				setErrorFieldId(id);
				setInlineEditing((prev) => ({ ...prev, [id]: true }));
				requestAnimationFrame(() => fieldRefs.current[id]?.focus());
			}
		},
	);
	const response = submission.response;
	const previewModal =
		response?.status === "installation_required"
			? "install"
			: previewOpen
				? "preview"
				: null;
	const fallbackNotice =
		response?.status === "duplicate"
			? "Anki 中存在相同首字段的笔记"
			: response?.status === "unknown"
				? "结果未确认，请先在 Anki 中查看。"
				: "发送未完成，请检查目标和字段。";
	const responseMessage = response?.message?.trim() ?? "";
	const baseNoticeText = trimTrailingPunctuation(responseMessage)
		? responseMessage
		: fallbackNotice;
	const notice: ExportNotice =
		localNotice ??
		(response && !["installation_required", "created"].includes(response.status)
			? {
					tone:
						response.status === "duplicate" || response.status === "unknown"
							? "warn"
							: "error",
					allowDuplicate: response.status === "duplicate",
					text: withMediaWarning(baseNoticeText, response.media_may_remain),
				}
			: null);
	const { drag, narrow, singlePane, dualPane, positionStyle } = useAnkiPosition(
		cardRef,
		anchor,
		showReference,
	);
	const draftVisible = !singlePane || !showReference;
	const initialFocused = useRef(false);

	useLayoutEffect(() => {
		const requested = nextPaneFocus.current;
		nextPaneFocus.current = null;
		const active = document.activeElement;
		if (
			showReference &&
			(requested === "reference" ||
				(!draftVisible &&
					(!initialFocused.current || draftPaneRef.current?.contains(active))))
		) {
			referencePaneRef.current
				?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
				?.focus({ preventScroll: true });
			initialFocused.current = true;
		} else if (!showReference && requested) {
			const field =
				typeof requested === "object"
					? fieldRefs.current[requested.fieldId]
					: undefined;
			if (field) field.focus();
			else referenceToggleRef.current?.focus({ preventScroll: true });
			initialFocused.current = true;
		}
	}, [draftVisible, showReference]);

	useEffect(() => {
		if (
			!activity.active ||
			initialFocused.current ||
			!draftVisible ||
			!defaultFocusField
		)
			return;
		const el = fieldRefs.current[defaultFocusField.id];
		if (el) {
			initialFocused.current = true;
			el.focus({ preventScroll: true });
		}
	}, [activity.active, defaultFocusField, draftVisible]);

	function openReference(fieldId?: string) {
		referenceOpenerField.current = fieldId ?? null;
		if (fieldId) setActiveRefFieldId(fieldId);
		if (singlePane || fieldId) nextPaneFocus.current = "reference";
		setHasOpenedReference(true);
		setShowReference(true);
	}

	function closeReference(focus: PaneFocus = "toggle") {
		nextPaneFocus.current = focus;
		setShowReference(false);
	}

	const hasUnsavedEdits = useMemo(() => {
		if (Object.keys(draft.media).length > 0) return true;
		return (
			Object.keys(draft.text).length > 0 ||
			Object.keys(draft.sentenceFocus).length > 0
		);
	}, [draft]);

	const requestClose = useCallback(() => {
		if (submission.busy) return;
		if (hasUnsavedEdits) {
			setConfirmDiscard(true);
			return;
		}
		onClose();
	}, [hasUnsavedEdits, onClose, submission.busy]);

	const setFieldText = useCallback(
		(field: AnkiFieldDefinition, value: string, headwordEntryId?: string) => {
			setDraft((prev) =>
				updateDraftFieldText(prev, field, context, value, headwordEntryId),
			);
			setSentenceSelection(null);
			setErrorFieldId((prev) => (prev === field.id ? null : prev));
			setNotice(null);
		},
		[context],
	);

	function setSentenceFocus(
		field: AnkiFieldDefinition,
		value: string,
		focus: AnkiSentenceFocus | null,
	) {
		if (!activeConfig) return;
		const key = fieldValueKey(field);
		setDraft((prev) => {
			if (getFieldText(prev, field, context) !== value) return prev;
			const current = getSentenceFocus(
				prev,
				activeConfig,
				field,
				value,
				context,
			);
			if (current?.start === focus?.start && current?.end === focus?.end)
				return prev;
			return {
				...prev,
				sentenceFocus: { ...prev.sentenceFocus, [key]: focus },
			};
		});
		setNotice(null);
	}

	const setFieldMedia = useCallback(
		(field: AnkiFieldDefinition, file: File) => {
			if (field.type === "text") return;
			const issue = mediaFileIssue(field.type, file);
			if (issue) {
				setNotice({ tone: "error", text: issue });
				return;
			}
			const key = fieldValueKey(field);
			const previewUrl =
				field.type === "image" || field.type === "audio"
					? URL.createObjectURL(file)
					: null;
			if (previewUrl) mediaUrlsRef.current.add(previewUrl);
			setDraft((prev) => {
				const old = prev.media[key];
				if (old?.previewUrl) {
					URL.revokeObjectURL(old.previewUrl);
					mediaUrlsRef.current.delete(old.previewUrl);
				}
				return {
					...prev,
					media: {
						...prev.media,
						[key]: { file, name: file.name, previewUrl },
					},
				};
			});
			setErrorFieldId((prev) => (prev === field.id ? null : prev));
			setNotice(null);
		},
		[],
	);

	const removeFieldMedia = useCallback((field: AnkiFieldDefinition) => {
		const key = fieldValueKey(field);
		setDraft((prev) => {
			const old = prev.media[key];
			if (old?.previewUrl) {
				URL.revokeObjectURL(old.previewUrl);
				mediaUrlsRef.current.delete(old.previewUrl);
			}
			const nextMedia = { ...prev.media };
			delete nextMedia[key];
			return { ...prev, media: nextMedia };
		});
	}, []);

	const retryConnectionMutation = useMutation({
		mutationFn: () => probeAnkiConnection(),
	});
	function retryConnection() {
		retryConnectionMutation.mutate(undefined, {
			onSuccess: (info) => {
				onConnectionStatus?.({ state: "connected", info });
				void catalogQuery.refetch();
			},
			onError: (error) =>
				onConnectionStatus?.({ state: "error", message: error.message }),
		});
	}

	const submitExport = () => {
		if (submission.busy || !activeConfig || !catalog || catalogQuery.isFetching)
			return;
		setNotice(null);
		submission.clear();
		if (!effectiveDeck) {
			setTargetExpanded(true);
			setNotice({ tone: "error", text: "请先选择目标卡组。" });
			return;
		}
		if (!activeConfig.noteType) {
			setTargetExpanded(true);
			setNotice({
				tone: "error",
				text: "当前配置尚未设置笔记类型，请先在设置中完善配置。",
			});
			return;
		}
		if (!noteTypeName) {
			setTargetExpanded(true);
			setNotice({
				tone: "error",
				text: "当前配置的笔记类型不适用于此 Anki 用户，请在设置中重新选择。",
			});
			return;
		}
		if (mappingIssues.length > 0) {
			setTargetExpanded(true);
			setNotice({
				tone: "error",
				text: mappingIssues[0]?.message ?? "字段映射存在冲突或失效。",
			});
			return;
		}

		const missing = missingRequiredFieldIds(activeConfig, draft, context);
		if (missing.length > 0) {
			const firstMissingId = missing[0] ?? null;
			setErrorFieldId(firstMissingId);
			const firstField = activeConfig.fields.find(
				(item) => item.id === firstMissingId,
			);
			setNotice({
				tone: "error",
				text: `请填写必填字段「${firstField?.label ?? ""}」。`,
			});
			if (firstMissingId) {
				setInlineEditing((prev) => ({ ...prev, [firstMissingId]: true }));
				setTimeout(() => fieldRefs.current[firstMissingId]?.focus(), 0);
			}
			return;
		}

		void submission.send();
	};

	function focusAppliedField(fieldId: string) {
		if (singlePane) closeReference({ fieldId });
		else fieldRefs.current[fieldId]?.focus();
	}

	const handleReferenceApply = (
		fieldId: string,
		text: string,
		mode: "replace" | "append",
	) => {
		const field = activeConfig?.fields.find((item) => item.id === fieldId);
		if (field?.type !== "text") return;
		const existing = getFieldText(draft, field, context);
		const adopted = field.multiline
			? text.trim()
			: text.trim().replace(/[ \t]*[\r\n]+[ \t]*/gu, " ");
		const separator = field.multiline ? "\n" : " ";
		const next =
			mode === "append" && existing.trim()
				? `${existing.trimEnd()}${separator}${adopted}`
				: adopted;
		setFieldText(field, next);
		focusAppliedField(fieldId);
	};

	const termField = activeConfig?.fields.find(
		(item) => item.type === "text" && item.source === "selection",
	);
	const readingField = activeConfig?.fields.find(
		(item) =>
			item.type === "text" &&
			(item.id === "reading" || item.target_field === "Reading"),
	);

	const activeRefField = textFields.find(
		(item) => item.id === activeRefFieldId,
	);
	const activeRefFieldHasValue = Boolean(
		activeRefField && getFieldText(draft, activeRefField, context).trim(),
	);

	// Keep the configured order within each section, with the reading next to its headword.
	const fields = activeConfig?.fields ?? [];
	const orderedFields = [
		...fields.filter((field) => field.presentation !== "more"),
		...fields.filter((field) => field.presentation === "more"),
	];
	if (termField && readingField && termField !== readingField) {
		orderedFields.splice(orderedFields.indexOf(readingField), 1);
		orderedFields.splice(orderedFields.indexOf(termField) + 1, 0, readingField);
	}

	const editConfigUrl = activeConfig
		? activeConfig.isBuiltin
			? `/settings?section=anki&viewPreset=${encodeURIComponent(activeConfig.id)}`
			: `/settings?section=anki&config=${encodeURIComponent(activeConfig.id)}`
		: "/settings?section=anki";

	const noteTypeDisplayName =
		noteTypeName ?? targetType?.name ?? builtinNoteType?.name ?? "未选笔记类型";

	const renderField = (field: AnkiFieldDefinition) => {
		const value =
			field.type === "text" ? getFieldText(draft, field, context) : "";
		const isError = errorFieldId === field.id;
		const key = fieldValueKey(field);

		if (field.type !== "text") {
			return (
				<div
					className="anki-field"
					key={field.id}
					data-error={isError || undefined}
				>
					<div className="anki-field-head">
						<span className="anki-field-label">
							{field.label}
							{field.required && <span className="anki-field-req">*</span>}
						</span>
					</div>
					<MediaFieldControl
						field={field}
						media={draft.media[key]}
						onSelect={(file) => setFieldMedia(field, file)}
						onRemove={() => removeFieldMedia(field)}
					/>
				</div>
			);
		}

		// Headword inline input for selection field (click directly to edit to dictionary form)
		if (field.source === "selection" && !field.multiline) {
			return (
				<div
					className="anki-field"
					key={field.id}
					data-error={isError || undefined}
				>
					<div className="anki-field-head">
						<label className="anki-field-label" htmlFor={`anki-f-${field.id}`}>
							{field.label}
							{field.required && <span className="anki-field-req">*</span>}
						</label>
					</div>
					<input
						id={`anki-f-${field.id}`}
						ref={(el) => {
							fieldRefs.current[field.id] = el;
						}}
						type="text"
						lang="ja"
						className="anki-headword-input"
						value={value}
						placeholder="输入词条或词典形"
						onFocus={() => setActiveRefFieldId(field.id)}
						onChange={(event) => setFieldText(field, event.target.value)}
					/>
				</div>
			);
		}

		const isSentence = field.source === "sentence";
		const displaysInline = isSentence || field.presentation === "summary";
		const canSetFocus =
			activeConfig && supportsSentenceFocus(activeConfig, field);
		const focus =
			activeConfig &&
			getSentenceFocus(draft, activeConfig, field, value, context);
		const clearFocus = () => {
			fieldRefs.current[field.id]?.focus();
			setSentenceFocus(field, value, null);
		};
		const clearFocusButton = focus && (
			<button
				type="button"
				className="anki-link-btn"
				onMouseDown={(event) => event.preventDefault()}
				onClick={clearFocus}
			>
				清除重点
			</button>
		);
		if (displaysInline && !inlineEditing[field.id]) {
			const points = focus ? Array.from(value) : [];
			return (
				<div
					className="anki-field"
					key={field.id}
					data-error={isError || undefined}
				>
					<div className="anki-field-head">
						<span className="anki-field-label">
							{field.label}
							{field.required && <span className="anki-field-req">*</span>}
						</span>
						{clearFocusButton}
					</div>
					<button
						type="button"
						className={isSentence ? "anki-quote-inline" : "anki-summary-inline"}
						lang={isSentence ? "ja" : undefined}
						title={isSentence ? "点击编辑原句" : value || "点击编辑"}
						ref={(el) => {
							fieldRefs.current[field.id] = el;
						}}
						onClick={() => {
							setSentenceSelection(null);
							setInlineEditing((prev) => ({ ...prev, [field.id]: true }));
							setActiveRefFieldId(field.id);
							setTimeout(() => fieldRefs.current[field.id]?.focus(), 0);
						}}
					>
						{focus ? (
							<>
								{points.slice(0, focus.start).join("")}
								<mark className="anki-sentence-focus-text">{focus.text}</mark>
								{points.slice(focus.end).join("")}
							</>
						) : (
							value || (isSentence ? "点击填写原句" : "点击填写")
						)}
					</button>
				</div>
			);
		}

		const selectedFocus =
			sentenceSelection?.key === key && sentenceSelection.value === value
				? sentenceSelection.focus
				: null;
		const selectSentenceText = canSetFocus
			? (event: SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) => {
					const input = event.currentTarget;
					const selected = sentenceFocusFromSelection(
						input.value,
						input.selectionStart ?? 0,
						input.selectionEnd ?? 0,
					);
					setSentenceSelection(
						selected ? { key, value: input.value, focus: selected } : null,
					);
				}
			: undefined;
		const placeholder =
			!field.required && field.id === "sentenceMeaning"
				? "选填，可简写"
				: `填写${field.label}…`;
		const FieldContainer = canSetFocus || displaysInline ? "fieldset" : "div";

		return (
			<FieldContainer
				className="anki-field"
				key={field.id}
				data-error={isError || undefined}
				aria-label={canSetFocus ? field.label : undefined}
				onBlur={
					canSetFocus || displaysInline
						? (event) => {
								if (event.currentTarget.contains(event.relatedTarget)) return;
								if (canSetFocus) setSentenceSelection(null);
								if (displaysInline) {
									setInlineEditing((prev) => ({ ...prev, [field.id]: false }));
								}
							}
						: undefined
				}
			>
				<div className="anki-field-head">
					<label className="anki-field-label" htmlFor={`anki-f-${field.id}`}>
						{field.label}
						{field.required && <span className="anki-field-req">*</span>}
					</label>
					{field.source === "manual" && hasAnyReference && !showReference && (
						<button
							type="button"
							className="anki-link-btn"
							onClick={() => openReference(field.id)}
						>
							参考词典与记录
							{referenceCount > 0 ? ` · ${referenceCount}` : ""}
						</button>
					)}
				</div>
				{field.multiline ? (
					<textarea
						id={`anki-f-${field.id}`}
						ref={(el) => {
							fieldRefs.current[field.id] = el;
						}}
						className="anki-textarea"
						lang={field.source === "sentence" ? "ja" : undefined}
						value={value}
						placeholder={placeholder}
						onFocus={() => setActiveRefFieldId(field.id)}
						onSelect={selectSentenceText}
						onChange={(event) => setFieldText(field, event.target.value)}
					/>
				) : (
					<input
						id={`anki-f-${field.id}`}
						ref={(el) => {
							fieldRefs.current[field.id] = el;
						}}
						type="text"
						className="anki-text-input"
						value={value}
						placeholder={placeholder}
						onFocus={() => setActiveRefFieldId(field.id)}
						onSelect={selectSentenceText}
						onChange={(event) => setFieldText(field, event.target.value)}
					/>
				)}
				{canSetFocus && (
					<div className="anki-sentence-focus-actions">
						<span className="anki-sentence-focus-status" role="status">
							{focus && (
								<>
									重点{" "}
									<mark className="anki-sentence-focus-text" lang="ja">
										{focus.text}
									</mark>
								</>
							)}
						</span>
						<button
							type="button"
							className="anki-link-btn"
							title="在原句中选中文字后设置"
							disabled={!selectedFocus}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => setSentenceFocus(field, value, selectedFocus)}
						>
							设为重点
						</button>
						{clearFocusButton}
					</div>
				)}
			</FieldContainer>
		);
	};

	const deckStatus =
		selectedDeck && (!catalog || !effectiveDeck)
			? catalogQuery.isFetching
				? "（正在加载）"
				: catalog
					? "（当前 Anki 中未找到）"
					: "（未连接）"
			: "";
	const summaryText = activeConfig
		? `${activeConfig.name} · ${effectiveDeck?.name ?? selectedDeck?.name ?? "未选卡组"}${deckStatus}`
		: "正在加载配置…";

	return (
		<>
			<section
				ref={cardRef}
				tabIndex={-1}
				className="anki-composer reader-popover"
				role="dialog"
				aria-label="制作 Anki 笔记"
				data-reader-tool=""
				data-dual-pane={dualPane || undefined}
				data-single-pane={singlePane || undefined}
				data-reader-card-dragging={drag.dragging || undefined}
				style={positionStyle}
				onKeyDown={(event) => {
					if (
						event.key !== "Escape" ||
						event.defaultPrevented ||
						previewModal ||
						confirmDiscard
					)
						return;
					event.stopPropagation();
					if (
						event.nativeEvent.isComposing ||
						event.nativeEvent.keyCode === 229
					)
						return;
					event.preventDefault();
					requestClose();
				}}
			>
				<header
					className="anki-composer-head"
					tabIndex={0}
					data-reader-card-draggable={!narrow || undefined}
					data-reader-card-drag-handle={!narrow || undefined}
					title={narrow ? undefined : "拖动标题栏移动制卡浮窗"}
					{...drag.handlers}
				>
					<div className="reader-popover-title">
						<span className="reader-popover-seal" aria-hidden="true">
							卡
						</span>
						<span style={{ fontWeight: 500 }}>制卡</span>
					</div>
					<div className="anki-composer-head-actions">
						{hasAnyReference && (
							<button
								ref={referenceToggleRef}
								type="button"
								className="anki-ref-toggle"
								aria-controls={referencePaneId}
								aria-expanded={showReference}
								aria-label={showReference ? "收起参考资料" : "展开参考资料"}
								title={showReference ? "收起参考资料" : "展开参考资料"}
								disabled={submission.busy}
								onClick={() => {
									if (showReference) closeReference();
									else openReference();
								}}
							>
								<svg
									viewBox="0 0 24 24"
									width="17"
									height="17"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									<rect x="2.5" y="4" width="19" height="16" rx="2" />
									<path d="M9 4v16" />
									<path d={showReference ? "m16 9-3 3 3 3" : "m14 9 3 3-3 3"} />
								</svg>
							</button>
						)}
						<button
							type="button"
							className="anki-close-btn"
							aria-label="关闭制卡浮窗"
							disabled={submission.busy}
							onClick={requestClose}
						>
							×
						</button>
					</div>
				</header>

				<div className="anki-composer-body" inert={submission.busy}>
					<div
						ref={referencePaneRef}
						id={referencePaneId}
						className="anki-composer-reference-pane"
						inert={!showReference}
					>
						{hasOpenedReference && (
							<AnkiReferencePane
								context={context}
								isOpen={showReference}
								materialId={materialId}
								segments={matchedRecords.segments}
								translations={matchedRecords.translations}
								textFields={textFields}
								activeFieldId={activeRefFieldId}
								activeFieldHasValue={activeRefFieldHasValue}
								recordsStatus={recordsStatus}
								compactMode={singlePane}
								onBackToDraft={() => {
									const fieldId = referenceOpenerField.current;
									closeReference(fieldId ? { fieldId } : "toggle");
								}}
								onActiveFieldChange={setActiveRefFieldId}
								onApplyText={handleReferenceApply}
								termFieldLabel={termField?.label}
								readingFieldLabel={readingField?.label}
								onApplyTerm={(entry) => {
									if (!termField) return;
									setFieldText(termField, entry.term, entry.id);
									focusAppliedField(termField.id);
								}}
								onApplyReading={(reading) => {
									if (!readingField) return;
									setFieldText(readingField, reading);
									focusAppliedField(readingField.id);
								}}
							/>
						)}
					</div>

					<div
						ref={draftPaneRef}
						className="anki-composer-form-pane"
						inert={!draftVisible}
					>
						<div className="anki-composer-scroll">
							{catalogQuery.isError && !catalogQuery.isFetching && (
								<div className="anki-banner" data-tone="error" role="status">
									<span>
										未连接 Anki{connectionError ? `（${connectionError}）` : ""}
										，可先编辑草稿。
									</span>
									<span className="anki-banner-actions">
										<button
											type="button"
											className="anki-link-btn"
											disabled={retryConnectionMutation.isPending}
											onClick={retryConnection}
										>
											{retryConnectionMutation.isPending ? "重试中…" : "重试"}
										</button>
										<Link
											to="/settings?section=anki"
											state={settingsState}
											className="anki-link-btn"
										>
											Anki 设置
										</Link>
									</span>
								</div>
							)}

							<div className="anki-target-box">
								<button
									type="button"
									className="anki-target-summary"
									aria-expanded={targetExpanded}
									onClick={() => setTargetExpanded(!targetExpanded)}
								>
									<span className="anki-target-summary-text">
										{summaryText}
									</span>
									<span className="anki-target-summary-action">
										{targetExpanded ? "收起" : "更改"}
									</span>
								</button>

								{targetExpanded && (
									<div className="anki-target-panel">
										<div className="anki-target-row">
											<label htmlFor="anki-composer-config">导出配置</label>
											<NativeSelect
												id="anki-composer-config"
												className="anki-reader-select"
												value={resolvedConfigId ?? ""}
												onChange={(event) => {
													const nextId = event.target.value;
													setSelectedConfigId(nextId);
													setDeckOverride(null);
													setNotice(null);
													if (nextId) rememberLastConfigurationId(nextId);
												}}
											>
												{configOptions.map((item) => (
													<option key={item.id} value={item.id}>
														{item.name}
														{item.isBuiltin ? "（系统预设）" : ""}
													</option>
												))}
											</NativeSelect>
										</div>

										<div className="anki-target-row">
											<label htmlFor="anki-composer-deck">目标卡组</label>
											<NativeSelect
												id="anki-composer-deck"
												className="anki-reader-select"
												disabled={!catalog}
												value={effectiveDeck?.id ?? ""}
												onChange={(event) => {
													const found = catalog?.decks.find(
														(item) => item.id === event.target.value,
													);
													if (found && catalog) {
														setDeckOverride({
															scope: {
																url: catalog.endpoint,
																profile: catalog.profile,
															},
															id: found.id,
															name: found.name,
														});
														rememberRecentDeck(
															catalog.endpoint,
															catalog.profile,
															{ id: found.id, name: found.name },
														);
														setNotice(null);
													}
												}}
											>
												<option value="">
													{catalog
														? "请选择卡组…"
														: catalogQuery.isFetching
															? "正在加载卡组…"
															: "连接 Anki 后可选"}
												</option>
												{catalog?.decks.map((item) => (
													<option key={item.id} value={item.id}>
														{item.name}
													</option>
												))}
											</NativeSelect>
										</div>

										<div
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: 8,
												fontSize: 12,
												color: "var(--reader-muted)",
											}}
										>
											<span>笔记类型：{noteTypeDisplayName}</span>
											<Link
												to={editConfigUrl}
												state={settingsState}
												className="anki-link-btn"
											>
												{activeConfig?.isBuiltin
													? "查看/另存配置 →"
													: "编辑配置 →"}
											</Link>
										</div>
									</div>
								)}
							</div>

							{(builtinsQuery.isPending || configsQuery.isPending) && (
								<p className="anki-ref-meta" role="status">
									正在加载配置…
								</p>
							)}

							{orderedFields.map(renderField)}

							{notice && (
								<div
									className="anki-banner"
									data-tone={notice.tone}
									role="alert"
								>
									<span>{notice.text}</span>
									{notice.allowDuplicate && (
										<span className="anki-banner-actions">
											<button
												type="button"
												className="anki-btn-primary"
												style={{ padding: "4px 10px", fontSize: 12 }}
												disabled={submission.busy}
												onClick={() => void submission.send("duplicate")}
											>
												仍然发送
											</button>
										</span>
									)}
								</div>
							)}
						</div>

						<footer className="anki-composer-foot">
							<button
								type="button"
								className="anki-btn-secondary"
								disabled={!activeConfig}
								onClick={() => setPreviewOpen(true)}
							>
								预览
							</button>
							<button
								type="button"
								className="anki-btn-primary"
								disabled={
									!catalog ||
									catalogQuery.isFetching ||
									!activeConfig ||
									awaitingReadings ||
									submission.busy
								}
								onClick={() => void submitExport()}
							>
								{submission.busy
									? "发送中…"
									: awaitingReadings
										? "正在加载注音…"
										: "发送到 Anki"}
							</button>
						</footer>
					</div>
				</div>
			</section>

			{previewModal && activeConfig && (
				<AnkiCardPreviewModal
					mode={previewModal}
					config={activeConfig}
					draft={draft}
					context={context}
					builtinNoteType={builtinNoteType}
					sharedCss={builtinsQuery.data?.shared_css ?? ""}
					night={night}
					deckName={effectiveDeck?.name ?? null}
					noteTypeName={noteTypeDisplayName}
					busy={submission.busy}
					onClose={() => {
						if (!submission.busy) {
							setPreviewOpen(false);
							submission.clear();
						}
					}}
					onConfirmInstall={
						previewModal === "install"
							? () => void submission.send("installation_required")
							: undefined
					}
				/>
			)}

			{confirmDiscard && (
				<ConfirmDialog
					titleId="anki-discard-title"
					onClose={() => setConfirmDiscard(false)}
				>
					<h2 id="anki-discard-title">放弃本次制卡草稿？</h2>
					<p>
						{response?.status === "unknown"
							? "发送结果尚未确认，请先在 Anki 中核对。关闭后将不保留本次草稿。"
							: "关闭后将不保留本次草稿。"}
					</p>
					<div className="confirm-actions">
						<button
							type="button"
							data-dialog-cancel=""
							onClick={() => setConfirmDiscard(false)}
						>
							继续编辑
						</button>
						<button
							type="button"
							className="danger"
							onClick={() => {
								setConfirmDiscard(false);
								onClose();
							}}
						>
							放弃修改
						</button>
					</div>
				</ConfirmDialog>
			)}
		</>
	);
}
