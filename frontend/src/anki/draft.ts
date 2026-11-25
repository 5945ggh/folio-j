import type {
	AnkiBuiltins,
	AnkiCatalog,
	AnkiConfigurationResponse,
	AnkiDeckTarget,
	AnkiExportField,
	AnkiExportPreset,
	AnkiFieldDefinition,
	AnkiNoteTypeTarget,
	BuiltinNoteType,
} from "./api.ts";
import type { AnkiMaterialContext, AnkiSentenceFocus } from "./context.ts";

type AnkiDraftField = AnkiFieldDefinition & { draftScope?: string };

export type AnkiConfigOption = {
	id: string;
	name: string;
	isBuiltin: boolean;
	deck: AnkiDeckTarget | null;
	noteType: AnkiNoteTypeTarget | null;
	fields: AnkiDraftField[];
};

export type AnkiMediaDraft = {
	file: File;
	name: string;
	previewUrl: string | null;
};

export type AnkiDraftValues = {
	/** Keyed by field identity and type so switching configs retains compatible edits. */
	text: Record<string, string>;
	media: Record<string, AnkiMediaDraft>;
	/** A null value explicitly clears the source focus for this field. */
	sentenceFocus: Record<string, AnkiSentenceFocus | null>;
	/** The source focus and automatic part of speech belong to the initial headword. */
	headwordChanged: boolean;
	headwordEntryId?: string;
};

export type AnkiFieldMappingIssue = {
	fieldId: string;
	kind: "missing_required_target" | "duplicate_target" | "unknown_target";
	message: string;
};

export function fieldValueKey(
	field: Pick<AnkiDraftField, "id" | "type" | "draftScope">,
): string {
	const key = `${field.id}:${field.type}`;
	return field.draftScope ? `${field.draftScope}:${key}` : key;
}

export function buildConfigOptions(
	builtins: AnkiBuiltins | undefined,
	configurations: readonly AnkiConfigurationResponse[] | undefined,
): AnkiConfigOption[] {
	const personal: AnkiConfigOption[] = (configurations ?? []).map((item) => ({
		id: item.id,
		name: item.name,
		isBuiltin: false,
		deck: item.deck ?? null,
		noteType: item.note_type ?? null,
		// Older editors allocated these IDs independently in every configuration.
		fields: item.fields.map((field) =>
			/^custom_[1-9]\d*$/u.test(field.id)
				? { ...field, draftScope: item.id }
				: field,
		),
	}));
	const presets: AnkiConfigOption[] = (builtins?.export_presets ?? []).map(
		(preset: AnkiExportPreset) => ({
			id: preset.id,
			name: preset.name,
			isBuiltin: true,
			deck: preset.deck ?? null,
			noteType: { kind: "builtin", ...preset.note_type_ref },
			fields: preset.fields,
		}),
	);
	return [...personal, ...presets];
}

export function resolveInitialConfigId(
	options: readonly AnkiConfigOption[],
	lastConfigurationId: string | null,
	origin: AnkiMaterialContext["origin"],
): string | null {
	if (!options.length) return null;
	if (
		lastConfigurationId &&
		options.some((item) => item.id === lastConfigurationId)
	) {
		return lastConfigurationId;
	}
	if (origin === "translation") {
		const sentence = options.find((item) => item.id === "export.sentence");
		if (sentence) return sentence.id;
	}
	return options[0]?.id ?? null;
}

export function initialFieldText(
	field: AnkiFieldDefinition,
	context: AnkiMaterialContext,
): string {
	if (field.type !== "text") return "";
	if (field.source === "selection") {
		if (context.origin === "dictionary" && context.dictionarySeed?.term) {
			return context.dictionarySeed.term;
		}
		return context.selection;
	}
	if (field.source === "sentence") return context.sentence;
	if (field.source === "sourceMetadata") return context.sourceMetadata;
	if (field.source === "manual" && context.origin === "dictionary") {
		if (field.id === "partOfSpeech") {
			return context.dictionarySeed?.partOfSpeech ?? "";
		}
		if (field.id === "reading" || field.target_field === "Reading") {
			return context.dictionarySeed?.reading ?? "";
		}
	}
	return "";
}

export function createInitialDraft(): AnkiDraftValues {
	return { text: {}, media: {}, sentenceFocus: {}, headwordChanged: false };
}

export function getFieldText(
	draft: AnkiDraftValues,
	field: AnkiFieldDefinition,
	context: AnkiMaterialContext,
): string {
	const key = fieldValueKey(field);
	if (key in draft.text) return draft.text[key] ?? "";
	if (field.id === "partOfSpeech" && draft.headwordChanged) return "";
	return initialFieldText(field, context);
}

export function updateDraftFieldText(
	draft: AnkiDraftValues,
	field: AnkiFieldDefinition,
	context: AnkiMaterialContext,
	value: string,
	headwordEntryId?: string,
): AnkiDraftValues {
	const valueChanged = value !== getFieldText(draft, field, context);
	const target = field.target_field;
	const isHeadword =
		target === "Word" ||
		(field.source === "selection" && target !== "Sentence");
	const previousEntryId =
		draft.headwordEntryId ??
		(draft.headwordChanged
			? undefined
			: context.dictionarySeed?.entries[0]?.id);
	const headwordChanged =
		isHeadword &&
		(valueChanged ||
			Boolean(
				headwordEntryId &&
					previousEntryId &&
					headwordEntryId !== previousEntryId,
			));
	if (!valueChanged && !headwordChanged) {
		return headwordEntryId && headwordEntryId !== previousEntryId
			? { ...draft, headwordEntryId }
			: draft;
	}
	const key = fieldValueKey(field);
	let sentenceFocus = draft.sentenceFocus;
	if (headwordChanged) {
		sentenceFocus = {};
	} else if (
		field.source === "sentence" ||
		target === "Sentence" ||
		key in sentenceFocus
	) {
		sentenceFocus = { ...sentenceFocus, [key]: null };
	}
	return {
		...draft,
		text: { ...draft.text, [key]: value },
		sentenceFocus,
		headwordChanged: draft.headwordChanged || headwordChanged,
		headwordEntryId: headwordChanged ? headwordEntryId : draft.headwordEntryId,
	};
}

export function validateFieldMappings(
	fields: readonly AnkiFieldDefinition[],
	knownTargetFields: readonly string[] | null,
): AnkiFieldMappingIssue[] {
	const issues: AnkiFieldMappingIssue[] = [];
	const seenTargets = new Map<string, string>();
	const allowed = knownTargetFields ? new Set(knownTargetFields) : null;

	for (const field of fields) {
		const target = field.target_field;
		if (!target) {
			if (field.required) {
				issues.push({
					fieldId: field.id,
					kind: "missing_required_target",
					message: `必填字段「${field.label}」尚未映射 Anki 字段。`,
				});
			}
			continue;
		}
		if (seenTargets.has(target)) {
			issues.push({
				fieldId: field.id,
				kind: "duplicate_target",
				message: `Anki 字段「${target}」已被其他行映射。`,
			});
		} else {
			seenTargets.set(target, field.id);
		}
		if (allowed && !allowed.has(target)) {
			issues.push({
				fieldId: field.id,
				kind: "unknown_target",
				message: `当前笔记类型不包含「${target}」字段。`,
			});
		}
	}
	return issues;
}

export function findBuiltinNoteType(
	builtins: AnkiBuiltins | undefined,
	target: AnkiNoteTypeTarget | null,
): BuiltinNoteType | null {
	if (!builtins || !target || target.kind !== "builtin") return null;
	return (
		builtins.note_types.find(
			(item) => item.id === target.id && item.version === target.version,
		) ?? null
	);
}

export function latestBuiltinNoteTypes(
	builtins: AnkiBuiltins | undefined,
): BuiltinNoteType[] {
	const latest = new Map<string, BuiltinNoteType>();
	for (const noteType of builtins?.note_types ?? []) {
		const previous = latest.get(noteType.id);
		if (!previous || previous.version < noteType.version) {
			latest.set(noteType.id, noteType);
		}
	}
	return [...latest.values()];
}

export function scopeMatchesCatalog(
	scope: { url: string; profile: string } | null | undefined,
	catalog: AnkiCatalog | null | undefined,
): boolean {
	if (!scope || !catalog) return false;
	return (
		scope.url.trim().replace(/\/+$/u, "") ===
			catalog.endpoint.trim().replace(/\/+$/u, "") &&
		scope.profile === catalog.profile
	);
}

export function resolveDeckInCatalog(
	deck: AnkiDeckTarget | null,
	catalog: AnkiCatalog | null | undefined,
): { id: string; name: string } | null {
	if (!deck || !catalog || !scopeMatchesCatalog(deck.scope, catalog)) {
		return null;
	}
	if (deck.id) {
		const byId = catalog.decks.find((item) => item.id === deck.id);
		return byId ?? null;
	}
	const byName = catalog.decks.find((item) => item.name === deck.name);
	return byName ?? null;
}

export function resolveExternalNoteTypeInCatalog(
	target: AnkiNoteTypeTarget | null,
	catalog: AnkiCatalog | null | undefined,
): { id: string; name: string } | null {
	if (
		target?.kind !== "external" ||
		!catalog ||
		!scopeMatchesCatalog(target.scope, catalog)
	) {
		return null;
	}
	if (target.id) {
		const byId = catalog.note_types.find((item) => item.id === target.id);
		return byId ?? null;
	}
	const byName = catalog.note_types.find((item) => item.name === target.name);
	return byName ?? null;
}

export function missingRequiredFieldIds(
	config: AnkiConfigOption,
	draft: AnkiDraftValues,
	context: AnkiMaterialContext,
): string[] {
	const missing: string[] = [];
	for (const field of config.fields) {
		if (!field.required || !field.target_field) continue;
		const key = fieldValueKey(field);
		if (field.type === "text") {
			if (!getFieldText(draft, field, context).trim()) missing.push(field.id);
		} else if (!draft.media[key]) {
			missing.push(field.id);
		}
	}
	return missing;
}

/** Escape user text for safe HTML interpolation inside local card previews. */
export function escapeHtml(raw: string): string {
	return raw
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * Render a builtin Anki Mustache template locally with escaped text values
 * and safe media placeholders. Only used for builtin read-only templates.
 */
export function renderBuiltinTemplate(
	template: string,
	valuesByTargetField: Readonly<Record<string, string>>,
): string {
	// Resolve conditional blocks inside-out (handles single-level & simple nested blocks).
	let output = template.replace(/<!--[\s\S]*?-->/g, "");
	const blockPattern = /\{\{([#^])([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
	for (let pass = 0; pass < 4; pass++) {
		const next = output.replace(
			blockPattern,
			(_match, sign: string, name: string, body: string) => {
				const present = Boolean(valuesByTargetField[name]?.trim());
				const keep = sign === "#" ? present : !present;
				return keep ? body : "";
			},
		);
		if (next === output) break;
		output = next;
	}
	return output.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, name: string) => {
		return valuesByTargetField[name] ?? "";
	});
}

/** Ruby belongs to the source sentence's code-point offsets, including in personal mappings to a builtin type. */
export function usesSourceSentence(
	config: AnkiConfigOption,
	field: AnkiFieldDefinition,
	value: string,
	context: AnkiMaterialContext,
): boolean {
	return (
		config.noteType?.kind === "builtin" &&
		field.type === "text" &&
		field.target_field === "Sentence" &&
		!!value &&
		value === context.sentence
	);
}

export function supportsSentenceFocus(
	config: AnkiConfigOption,
	field: AnkiFieldDefinition,
): boolean {
	const noteType = config.noteType;
	return (
		field.type === "text" &&
		field.target_field === "Sentence" &&
		noteType?.kind === "builtin" &&
		((noteType.id === "folio-j.vocabulary-recall" && noteType.version === 2) ||
			(noteType.id === "folio-j.sentence-reading" && noteType.version === 1))
	);
}

function matchesSentenceFocus(
	value: string,
	focus: AnkiSentenceFocus,
): boolean {
	const points = Array.from(value);
	return (
		Number.isInteger(focus.start) &&
		Number.isInteger(focus.end) &&
		focus.start >= 0 &&
		focus.end > focus.start &&
		focus.end <= points.length &&
		Boolean(focus.text.trim()) &&
		points.slice(focus.start, focus.end).join("") === focus.text
	);
}

export function sentenceFocusFromSelection(
	value: string,
	selectionStart: number,
	selectionEnd: number,
): AnkiSentenceFocus | null {
	if (selectionStart >= selectionEnd) return null;
	const focus = {
		start: Array.from(value.slice(0, selectionStart)).length,
		end: Array.from(value.slice(0, selectionEnd)).length,
		text: value.slice(selectionStart, selectionEnd),
	};
	return matchesSentenceFocus(value, focus) ? focus : null;
}

export function getSentenceFocus(
	draft: AnkiDraftValues,
	config: AnkiConfigOption,
	field: AnkiFieldDefinition,
	value: string,
	context: AnkiMaterialContext,
): AnkiSentenceFocus | null {
	if (!supportsSentenceFocus(config, field)) return null;
	const key = fieldValueKey(field);
	const focus =
		key in draft.sentenceFocus
			? draft.sentenceFocus[key]
			: !draft.headwordChanged && value === context.sentence
				? context.sentenceFocus
				: null;
	return focus && matchesSentenceFocus(value, focus) ? focus : null;
}

function textForExport(
	config: AnkiConfigOption,
	draft: AnkiDraftValues,
	context: AnkiMaterialContext,
	field: AnkiFieldDefinition,
): { value: string } & Pick<
	AnkiExportField,
	"sentence_ruby" | "sentence_focus"
> {
	const value = getFieldText(draft, field, context);
	const ruby = context.sentenceRuby;
	const focus = getSentenceFocus(draft, config, field, value, context);
	return {
		value,
		...(ruby?.length && usesSourceSentence(config, field, value, context)
			? { sentence_ruby: [...ruby] }
			: {}),
		...(focus ? { sentence_focus: focus } : {}),
	};
}

function previewText(
	value: string,
	ruby: AnkiExportField["sentence_ruby"],
	focus: AnkiExportField["sentence_focus"],
): string {
	const plain = (text: string) =>
		escapeHtml(text).replace(/\r\n?|\n/g, "<br />");
	if (!ruby?.length && !focus) return plain(value);
	const points = Array.from(value);
	const slice = (start: number, end: number) => {
		const text = points.slice(start, end).join("");
		// Keep a CRLF crossing a markup boundary as one visual line break.
		return plain(points[end] === "\n" ? text.replace(/\r$/u, "") : text);
	};
	const mark = (html: string) => `<span class="sentence-focus">${html}</span>`;
	function base(start: number, end: number) {
		if (!focus) return slice(start, end);
		const from = Math.max(start, focus.start);
		const to = Math.min(end, focus.end);
		if (from >= to) return slice(start, end);
		return slice(start, from) + mark(slice(from, to)) + slice(to, end);
	}

	let cursor = 0;
	const parts: string[] = [];
	for (const { start, end, reading } of ruby ?? []) {
		parts.push(base(cursor, start));
		const whole = focus && focus.start <= start && end <= focus.end;
		const text = whole ? slice(start, end) : base(start, end);
		const annotation = `<ruby>${text}<rt>${escapeHtml(reading)}</rt></ruby>`;
		parts.push(whole ? mark(annotation) : annotation);
		cursor = end;
	}
	parts.push(base(cursor, points.length));
	return parts.join("");
}

export function buildPreviewFieldMap(
	config: AnkiConfigOption,
	draft: AnkiDraftValues,
	context: AnkiMaterialContext,
	side: "front" | "back",
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const field of config.fields) {
		const target = field.target_field;
		if (!target) continue;
		if (field.type === "text") {
			const { value, sentence_ruby, sentence_focus } = textForExport(
				config,
				draft,
				context,
				field,
			);
			if (value.trim()) {
				map[target] = previewText(
					value,
					side === "back" ? sentence_ruby : undefined,
					side === "back" ? sentence_focus : undefined,
				);
			}
			continue;
		}
		const media = draft.media[fieldValueKey(field)];
		if (!media) continue;
		if (field.type === "image" && media.previewUrl) {
			map[target] =
				`<img src="${escapeHtml(media.previewUrl)}" alt="${escapeHtml(media.name)}" />`;
		} else if (field.type === "audio") {
			map[target] =
				`<span class="fj-media-chip">♪ ${escapeHtml(media.name)}</span>`;
		} else if (field.type === "video") {
			map[target] =
				`<span class="fj-media-chip">▶ ${escapeHtml(media.name)}</span>`;
		} else {
			map[target] =
				`<span class="fj-media-chip">${escapeHtml(media.name)}</span>`;
		}
	}
	return map;
}

export const mediaExtensions = {
	audio: [".mp3"],
	image: [".png", ".jpg", ".jpeg"],
	video: [".mp4"],
} as const;

export function mediaFileIssue(
	type: keyof typeof mediaExtensions,
	file: Pick<File, "name" | "size">,
): string | null {
	const allowed = mediaExtensions[type];
	if (
		!allowed.some(
			(ext) =>
				file.name.toLowerCase().endsWith(ext) && file.name.length > ext.length,
		)
	) {
		return `请选择 ${allowed.map((ext) => ext.slice(1).toUpperCase()).join("、")} 格式的文件。`;
	}
	if (!file.size) return "所选文件为空，请重新选择。";
	if (file.size > 11 * 1024 * 1024) return "单个附件不能超过 11 MB。";
	return null;
}

export async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const chunks: string[] = [];
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + step)));
	}
	return btoa(chunks.join(""));
}

export async function buildExportFields(
	config: AnkiConfigOption,
	draft: AnkiDraftValues,
	context: AnkiMaterialContext,
): Promise<AnkiExportField[]> {
	const fields: AnkiExportField[] = [];
	let totalBytes = 0;
	for (const field of config.fields) {
		if (field.type === "text" || !field.target_field) continue;
		const file = draft.media[fieldValueKey(field)]?.file;
		if (!file) continue;
		const issue = mediaFileIssue(field.type, file);
		if (issue) throw new Error(issue);
		totalBytes += file.size;
	}
	if (totalBytes > 24 * 1024 * 1024)
		throw new Error("单次发送的附件总大小不能超过 24 MB。");
	for (const field of config.fields) {
		const target = field.target_field;
		if (!target) continue;
		const key = fieldValueKey(field);
		if (field.type === "text") {
			fields.push({
				id: field.id,
				type: "text",
				target_field: target,
				required: field.required,
				...textForExport(config, draft, context, field),
			});
		} else {
			const media = draft.media[key];
			fields.push({
				id: field.id,
				type: field.type,
				target_field: target,
				required: field.required,
				value: media
					? {
							name: media.name,
							data_base64: await fileToBase64(media.file),
						}
					: null,
			});
		}
	}
	return fields;
}

export function createCustomFieldId(): string {
	return `custom_${crypto.randomUUID()}`;
}
