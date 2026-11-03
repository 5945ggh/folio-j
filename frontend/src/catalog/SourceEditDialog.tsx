import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { api } from "../api/client";
import {
	queries,
	requireData,
	type Source,
	type SourceFields,
} from "../content";
import { SourceForm } from "../Forms";
import { ConfirmDialog } from "../Shared";
import { catalogKeys } from "./api";
import { changedSourceFields } from "./source-edit";

export function SourceEditDialog({
	initial,
	onClose,
}: {
	initial: Source;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [base] = useState<SourceFields>(() => ({
		title: initial.title,
		description: initial.description,
		note: initial.note,
	}));
	const [fields, setFields] = useState(base);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const submitting = useRef(false);
	const completed = useRef(false);
	const blockerRef = useRef<ReturnType<typeof useBlocker> | null>(null);
	const changes = changedSourceFields(fields, base);
	const dirty = Object.keys(changes).length > 0;
	const save = useMutation({
		mutationFn: async (body: Partial<SourceFields>) => {
			const { data, error, response } = await api.PATCH(
				"/api/sources/{source_id}",
				{ params: { path: { source_id: initial.id } }, body },
			);
			return requireData(data, error, response.status);
		},
		onSuccess: async (source) => {
			await client.cancelQueries({
				queryKey: queries.source(initial.id),
				exact: true,
			});
			completed.current = true;
			client.setQueryData(queries.source(initial.id), source);
			void client.invalidateQueries({ queryKey: queries.sources });
			void client.invalidateQueries({ queryKey: catalogKeys.all });
			const navigation = blockerRef.current;
			if (navigation?.state === "blocked") navigation.proceed();
			onClose();
		},
		onSettled: () => {
			submitting.current = false;
		},
	});
	const blocker = useBlocker(
		() => !completed.current && (dirty || submitting.current || save.isPending),
	);
	blockerRef.current = blocker;
	useBeforeUnload(
		useCallback(
			(event) => {
				if (
					!completed.current &&
					(dirty || submitting.current || save.isPending)
				) {
					event.preventDefault();
					event.returnValue = "";
				}
			},
			[dirty, save.isPending],
		),
	);
	function requestClose() {
		if (submitting.current || save.isPending) return;
		if (dirty) setConfirmDiscard(true);
		else onClose();
	}
	function continueEditing() {
		if (submitting.current || save.isPending) return;
		if (blocker.state === "blocked") blocker.reset();
		setConfirmDiscard(false);
	}
	return (
		<ConfirmDialog
			titleId="edit-source-title"
			onClose={requestClose}
			restoreFocusId="source-menu-trigger"
		>
			<h2 id="edit-source-title">编辑来源</h2>
			<SourceForm
				value={fields}
				onChange={setFields}
				onSave={() => {
					if (submitting.current || save.isPending) return;
					if (!dirty) return onClose();
					submitting.current = true;
					save.mutate(changes);
				}}
				onCancel={requestClose}
				pending={save.isPending}
				error={save.error}
				submitLabel="保存更改"
			/>
			{(confirmDiscard || blocker.state === "blocked") && (
				<ConfirmDialog titleId="source-discard-title" onClose={continueEditing}>
					<h2 id="source-discard-title">放弃本次编辑？</h2>
					<p>{save.isPending ? "正在保存，请稍候。" : "来源信息尚未保存。"}</p>
					<div className="actions">
						<button
							type="button"
							disabled={save.isPending}
							data-dialog-cancel
							onClick={continueEditing}
						>
							继续编辑
						</button>
						<button
							type="button"
							disabled={save.isPending}
							onClick={() => {
								if (submitting.current || save.isPending) return;
								completed.current = true;
								if (blocker.state === "blocked") blocker.proceed();
								onClose();
							}}
						>
							放弃并离开
						</button>
					</div>
				</ConfirmDialog>
			)}
		</ConfirmDialog>
	);
}
