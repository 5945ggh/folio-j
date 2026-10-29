import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	type ContextCopySettings,
	saveContextCopySettings,
} from "../settings/context-copy-api";
import {
	commitContextCopyResponse,
	contextCopyKey,
} from "../settings/context-copy-cache";
import {
	useContextCopySettings,
	useReloadContextCopySettings,
} from "../settings/context-copy-query";
import {
	createReaderCopyEditor,
	readerCopyEditorStatus,
} from "./reader-copy-editor";

export function useReaderCopyEditor(active: boolean) {
	const client = useQueryClient();
	const query = useContextCopySettings(active);
	const reloadSettings = useReloadContextCopySettings();
	const [editor] = useState(() =>
		createReaderCopyEditor(
			{
				save: saveContextCopySettings,
				commit: async (saved) =>
					(await commitContextCopyResponse(client, saved)) ?? saved,
				reload: reloadSettings,
			},
			query.data,
		),
	);
	const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
	useEffect(() => {
		editor.setActive(active);
		return () => editor.setActive(false);
	}, [active, editor]);
	useEffect(() => {
		if (query.data) editor.receive(query.data);
	}, [query.data, editor]);
	const receiveCachedSettings = () => {
		const latest = client.getQueryData<ContextCopySettings>(contextCopyKey);
		if (latest) editor.receive(latest);
	};
	return {
		query,
		...readerCopyEditorStatus(state),
		change: editor.change,
		resetDefaults: editor.resetDefaults,
		discard: () => {
			receiveCachedSettings();
			editor.discard();
		},
		reload: editor.reload,
		save: () => {
			receiveCachedSettings();
			return editor.save();
		},
	};
}

export type ReaderCopyEditor = ReturnType<typeof useReaderCopyEditor>;
