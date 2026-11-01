import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { MaterialProvenance } from "../materials/study-api";
import { ConfirmDialog, InlineError } from "../Shared";
import type { TranslationRemoval as Removal, TranslationResult } from "./api";
import type { TranslationSession } from "./session";
import { useTranslationSession } from "./session-react";
import { targetText } from "./state";

export type TranslationRemoved = (
	removed: Removal,
	reference: MaterialProvenance,
) => void;

/** Keep confirmation state at the host when the action moves between loading and result views. */
export function useTranslationRemoval({
	session,
	result,
	onRemoved,
	restoreFocusId,
	onOpenConfirmation,
	withLabel = false,
	label = result ? "删除这版译文" : "清除此处全部翻译",
}: {
	session: TranslationSession;
	result?: TranslationResult;
	onRemoved?: TranslationRemoved;
	restoreFocusId?: string;
	onOpenConfirmation?: () => void;
	withLabel?: boolean;
	label?: string;
}) {
	const [confirmation, setConfirmation] = useState<{
		result?: TranslationResult;
	} | null>(null);
	const id = useId();
	const triggerId = `${id}-trigger`;
	const state = useTranslationSession(session);
	const removal = useMutation({
		mutationFn: (resultId: string | undefined) => session.remove(resultId),
		onSuccess: (removed) => {
			setConfirmation(null);
			onRemoved?.(removed, session.reference);
		},
	});
	const pending = removal.isPending || state.phase === "removing";
	const unresolved =
		state.phase === "submitting" || state.phase === "uncertain";
	const action = (
		<button
			id={triggerId}
			type="button"
			className={
				withLabel
					? "translation-menu-item translation-remove"
					: "translation-icon-button translation-remove"
			}
			aria-label={label}
			title={unresolved ? "请先核实原提交，再删除翻译" : label}
			disabled={pending || unresolved}
			onClick={() => {
				removal.reset();
				setConfirmation({ result });
				onOpenConfirmation?.();
			}}
		>
			<svg
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" />
			</svg>
			{withLabel && <span>{label}</span>}
		</button>
	);
	const dialog = confirmation && (
		<ConfirmDialog
			titleId={id}
			restoreFocusId={restoreFocusId ?? triggerId}
			onClose={() => {
				if (!pending) setConfirmation(null);
			}}
		>
			<h2 id={id}>
				{confirmation.result ? "删除这版译文？" : "清除此处全部翻译？"}
			</h2>
			<blockquote className="translation-removal-target" lang="ja">
				{targetText(session.reference)}
			</blockquote>
			{confirmation.result && (
				<p className="translation-removal-target">
					{confirmation.result.translation}
				</p>
			)}
			<p>
				{confirmation.result
					? "将仅删除这版阅读译文，保留其他版本和进行中的重译；没有剩余版本时移除翻译划线。"
					: "将清除此处全部阅读译文历史和正文翻译划线，并停止进行中的重译。"}
				已另存的学习片段及关联译文快照保留。
			</p>
			<InlineError error={removal.error} />
			<div className="actions">
				<button
					type="button"
					data-dialog-cancel
					disabled={pending}
					onClick={() => setConfirmation(null)}
				>
					取消
				</button>
				<button
					type="button"
					className="danger"
					disabled={pending}
					onClick={() => removal.mutate(confirmation.result?.id)}
				>
					{pending ? "正在删除…" : "确认删除翻译"}
				</button>
			</div>
		</ConfirmDialog>
	);
	return { action, dialog };
}

/** Chapter-list action for clearing every reading translation at one exact target. */
export function TranslationRemoval(props: {
	session: TranslationSession;
	onRemoved?: TranslationRemoved;
	label?: string;
}) {
	const { action, dialog } = useTranslationRemoval(props);
	return (
		<>
			{action}
			{dialog}
		</>
	);
}
