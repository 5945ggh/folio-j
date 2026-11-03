import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createAutosaveQueue } from "../settings/autosave-queue";
import {
	type ContextCopySettings,
	type ContextCopySettingsUpdate,
	saveContextCopySettings,
} from "../settings/context-copy-api";
import { commitContextCopyResponse } from "../settings/context-copy-cache";
import {
	type ContextCopyFields,
	copyFields,
	parseCopyFields,
} from "../settings/context-copy-draft";
import { useContextCopySettings } from "../settings/context-copy-query";
import {
	completeDraft,
	createDraft,
	type Draft,
	draftDirty,
	editDraft,
	receiveDraft,
} from "../settings/draft";
import { DEFAULT_CONTEXT_COPY } from "./context-copy";

// One window keeps writes ordered even when a new book replaces the old Reader.
const enqueueCopySave = createAutosaveQueue<{
	client: QueryClient;
	body: ContextCopySettingsUpdate;
	accept: (saved: ContextCopySettings) => void;
}>(async ({ client, body, accept }) => {
	const saved = await saveContextCopySettings(body);
	const persisted = await commitContextCopyResponse(client, saved);
	accept(persisted ?? saved);
});

export function useReaderCopyEditor(active: boolean) {
	const client = useQueryClient();
	const query = useContextCopySettings(active);
	const [draft, setDraft] = useState<Draft<ContextCopyFields> | null>(() =>
		query.data ? createDraft(copyFields(query.data)) : null,
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState(false);
	useEffect(() => {
		if (!query.data) return;
		const fields = copyFields(query.data);
		setDraft((current) =>
			current ? receiveDraft(current, fields, pending) : createDraft(fields),
		);
	}, [query.data, pending]);
	async function save(value = draft?.value) {
		if (!active || !value) return false;
		const submitted = { ...value };
		const body = parseCopyFields(submitted);
		if (!body) return false;
		setPending(true);
		setError(false);
		try {
			await enqueueCopySave({
				client,
				body,
				accept: (saved) => {
					setDraft((current) =>
						current
							? completeDraft(current, submitted, copyFields(saved))
							: current,
					);
				},
			});
			return true;
		} catch {
			setError(true);
			return false;
		} finally {
			setPending(false);
		}
	}
	function change(value: ContextCopyFields, commit = false) {
		if (!active) return;
		setDraft((current) =>
			current ? editDraft(current, value, pending) : current,
		);
		setError(false);
		if (commit) void save(value);
	}
	const dirty = draft ? draftDirty(draft) : false;
	return {
		query,
		fields: draft?.value ?? null,
		dirty,
		valid: draft ? parseCopyFields(draft.value) !== null : false,
		pending,
		notice: error
			? "保存失败，修改已保留。"
			: draft?.saved && !dirty
				? "复制设置已自动保存。"
				: "",
		noticeError: error,
		change,
		save,
		resetDefaults: () => change(copyFields(DEFAULT_CONTEXT_COPY), true),
	};
}

export type ReaderCopyEditor = ReturnType<typeof useReaderCopyEditor>;
