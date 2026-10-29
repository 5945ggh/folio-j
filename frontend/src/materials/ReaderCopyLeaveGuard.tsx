import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../Shared";
import {
	ReaderLeaveDialog,
	useReaderLeaveBlocker,
} from "./ReaderLeaveProvider";
import {
	createReaderCopyLeaveAttempt,
	shouldBlockReaderCopyLeave,
} from "./reader-copy-leave";
import type { ReaderCopyEditor } from "./use-reader-copy-editor";

/** Remain mounted for the Reader route, including temporary query suspension. */
export function ReaderCopyLeaveGuard({
	editor,
	materialId,
	onContinueEditing,
}: {
	editor: ReaderCopyEditor;
	materialId: string;
	onContinueEditing: () => void;
}) {
	const titleId = useId();
	const editorRef = useRef(editor);
	editorRef.current = editor;
	const blocker = useReaderLeaveBlocker(
		"copy",
		(nextLocation) =>
			shouldBlockReaderCopyLeave(
				materialId,
				nextLocation.pathname,
				editorRef.current.dirty || editorRef.current.pending,
			),
		() => editorRef.current.dirty || editorRef.current.pending,
	);
	const blockerRef = useRef(blocker);
	blockerRef.current = blocker;
	const [attempt] = useState(createReaderCopyLeaveAttempt);
	const target = useRef<string | null>(null);
	const proceedingTarget = useRef<string | null>(null);
	const [waiting, setWaiting] = useState(false);
	const [failed, setFailed] = useState(false);
	const blockedTarget =
		blocker.state === "blocked" ? blocker.location.key : null;
	const proceed = useCallback(() => {
		const current = blockerRef.current;
		if (
			current.state === "blocked" &&
			proceedingTarget.current !== current.location.key
		) {
			proceedingTarget.current = current.location.key;
			current.proceed();
		}
	}, []);
	const saveAndLeave = useCallback(() => {
		const current = blockerRef.current;
		if (current.state !== "blocked") return;
		const savingTarget = current.location.key;
		setWaiting(true);
		setFailed(false);
		void attempt.wait(
			() => editorRef.current.save(),
			(saved) => {
				const latest = blockerRef.current;
				if (latest.state !== "blocked" || latest.location.key !== savingTarget)
					return;
				setWaiting(false);
				if (saved) proceed();
				else setFailed(true);
			},
		);
	}, [attempt, proceed]);
	useEffect(() => {
		if (target.current !== blockedTarget) {
			attempt.cancel();
			target.current = blockedTarget;
			proceedingTarget.current = null;
			setWaiting(false);
			setFailed(false);
		}
		if (!blockedTarget) return;
		if (editor.saving) saveAndLeave();
		else if (!editor.dirty && !editor.pending) {
			// The write may finish before this blocker gets its first effect.
			attempt.cancel();
			proceed();
		}
	}, [
		attempt,
		blockedTarget,
		editor.dirty,
		editor.pending,
		editor.saving,
		proceed,
		saveAndLeave,
	]);
	useEffect(() => () => attempt.cancel(), [attempt]);
	function continueEditing() {
		attempt.cancel();
		setWaiting(false);
		setFailed(false);
		const current = blockerRef.current;
		if (current.state === "blocked") current.reset();
		onContinueEditing();
	}
	if (blocker.state !== "blocked") return null;
	const busy = waiting || editor.pending;
	return (
		<ReaderLeaveDialog>
			<ConfirmDialog
				className="reader-copy-leave"
				titleId={titleId}
				onClose={continueEditing}
			>
				<h2 id={titleId}>有尚未保存的复制设置</h2>
				<p>
					{busy
						? "正在处理复制设置，请稍候。继续编辑可以取消这次离开，已经提交的保存仍会完成。"
						: "可以保存后离开，或放弃这次修改。"}
				</p>
				{(failed || (!busy && (!editor.valid || editor.needsReload))) && (
					<p className="inline-error" role="alert">
						{editor.needsReload
							? "复制设置已在其他页面更新，请继续编辑并重新读取后再保存。"
							: !editor.valid
								? "请继续编辑，填写有效的复制设置后再保存。"
								: "保存未完成，修改已保留。可以继续编辑后重试。"}
					</p>
				)}
				<div className="reader-copy-leave-actions">
					<button
						type="button"
						className="primary"
						disabled={busy || !editor.valid || editor.needsReload}
						onClick={saveAndLeave}
					>
						保存后离开
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							if (editorRef.current.pending || waiting) return;
							attempt.cancel();
							editorRef.current.discard();
							proceed();
						}}
					>
						放弃并离开
					</button>
					<button type="button" data-dialog-cancel onClick={continueEditing}>
						继续编辑
					</button>
				</div>
			</ConfirmDialog>
		</ReaderLeaveDialog>
	);
}
