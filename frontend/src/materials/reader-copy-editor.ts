import type {
	ContextCopySettings,
	ContextCopySettingsUpdate,
} from "../settings/context-copy-api.ts";
import { newestContextCopySettings } from "../settings/context-copy-cache.ts";
import {
	type ContextCopyDraft,
	type ContextCopyFields,
	completeCopyDraft,
	conflictCopyDraft,
	copyDraftDirty,
	copyDraftRequest,
	copyFields,
	createCopyDraft,
	editCopyDraft,
	parseCopyFields,
	receiveCopySettings,
	reloadCopyDraft,
} from "../settings/context-copy-draft.ts";
import { DEFAULT_CONTEXT_COPY } from "./context-copy.ts";

type EditorState = {
	draft: ContextCopyDraft | null;
	operation: "save" | "reload" | null;
	notice: string;
	noticeError: boolean;
};

type EditorDependencies = {
	save: (request: ContextCopySettingsUpdate) => Promise<ContextCopySettings>;
	commit: (saved: ContextCopySettings) => Promise<ContextCopySettings>;
	reload: () => Promise<ContextCopySettings>;
};

/** The Reader owns one editor even while its settings panel is hidden. */
export function createReaderCopyEditor(
	dependencies: EditorDependencies,
	initial?: ContextCopySettings,
) {
	let state: EditorState = {
		draft: initial ? createCopyDraft(initial) : null,
		operation: null,
		notice: "",
		noticeError: false,
	};
	let active = false;
	let activation = 0;
	let saving: Promise<boolean> | null = null;
	let reloading: Promise<boolean> | null = null;
	const listeners = new Set<() => void>();
	const publish = (patch: Partial<EditorState>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const notice = (message: string, error: boolean, started: number) => {
		if (active && started === activation)
			publish({ notice: message, noticeError: error });
	};
	const change = (fields: ContextCopyFields) => {
		if (!active || state.operation || !state.draft) return;
		publish({
			draft: editCopyDraft(state.draft, { ...fields }),
			notice: "",
			noticeError: false,
		});
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setActive(value: boolean) {
			if (active === value) return;
			active = value;
			activation += 1;
			if (!active) publish({ notice: "", noticeError: false });
		},
		receive(settings: ContextCopySettings) {
			const draft = state.draft
				? receiveCopySettings(state.draft, settings)
				: createCopyDraft(settings);
			if (draft !== state.draft) publish({ draft });
		},
		change,
		resetDefaults: () => change(copyFields(DEFAULT_CONTEXT_COPY)),
		discard() {
			if (!active || state.operation || !state.draft) return;
			publish({
				draft: createCopyDraft(state.draft.latest),
				notice: "已使用服务器保存的复制设置。",
				noticeError: false,
			});
		},
		save(): Promise<boolean> {
			// Return the original promise so a route transition waits for this write.
			if (saving) return saving;
			if (!active || reloading || !state.draft) return Promise.resolve(false);
			const draft = state.draft;
			const request = copyDraftRequest(draft);
			if (!request) return Promise.resolve(false);
			if (!copyDraftDirty(draft)) return Promise.resolve(true);
			const started = activation;
			publish({ operation: "save", notice: "", noticeError: false });
			saving = Promise.resolve().then(async () => {
				try {
					const saved = await dependencies.save(request);
					const persisted = await dependencies.commit(saved);
					const current = state.draft ?? draft;
					const latest = newestContextCopySettings(current.latest, persisted);
					const completed = completeCopyDraft(current, saved, latest);
					publish({ draft: completed });
					const accepted = !copyDraftDirty(completed) && !completed.conflict;
					if (accepted) notice("复制设置已保存。", false, started);
					return accepted;
				} catch (error) {
					if (
						error &&
						typeof error === "object" &&
						"status" in error &&
						error.status === 409
					) {
						publish({ draft: conflictCopyDraft(state.draft ?? draft) });
					} else notice("保存失败，修改已保留。", true, started);
					return false;
				} finally {
					saving = null;
					publish({ operation: null });
				}
			});
			return saving;
		},
		reload(keepChanges: boolean): Promise<boolean> {
			if (reloading) return reloading;
			if (!active || saving) return Promise.resolve(false);
			const started = activation;
			publish({ operation: "reload", notice: "", noticeError: false });
			reloading = Promise.resolve().then(async () => {
				try {
					const latest = await dependencies.reload();
					publish({
						draft: state.draft
							? reloadCopyDraft(state.draft, latest, keepChanges)
							: createCopyDraft(latest),
					});
					notice(
						keepChanges
							? "已读取最新配置并保留修改；再次保存会提交整组配置。"
							: "已使用服务器保存的复制设置。",
						false,
						started,
					);
					return true;
				} catch {
					notice("读取复制设置失败，修改已保留。", true, started);
					return false;
				} finally {
					reloading = null;
					publish({ operation: null });
				}
			});
			return reloading;
		},
	};
}

export function readerCopyEditorStatus(state: EditorState) {
	const draft = state.draft;
	return {
		fields: draft?.fields ?? null,
		dirty: draft ? copyDraftDirty(draft) : false,
		pending: state.operation !== null,
		saving: state.operation === "save",
		valid: draft ? parseCopyFields(draft.fields) !== null : false,
		needsReload: draft
			? draft.conflict || draft.latest.revision > draft.baseline.revision
			: false,
		notice: state.notice,
		noticeError: state.noticeError,
	};
}
