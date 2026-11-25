import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { MaterialProvenance } from "../materials/study-api";
import { ConfirmDialog, InlineError } from "../Shared";
import type { TranslationRemoval as Removal } from "./api";
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
	onRemoved,
	restoreFocusId,
	onOpenConfirmation,
	hideTrigger,
	withLabel = false,
	label = "删除该处翻译记录",
}: {
	session: TranslationSession;
	onRemoved?: TranslationRemoved;
	restoreFocusId?: string;
	onOpenConfirmation?: () => void;
	hideTrigger?: boolean;
	withLabel?: boolean;
	label?: string;
}) {
	const [confirmation, setConfirmation] = useState(false);
	const id = useId();
	const triggerId = `${id}-trigger`;
	const state = useTranslationSession(session);
	const removal = useMutation({
		mutationFn: () => session.remove(),
		onSuccess: (removed) => {
			setConfirmation(false);
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
			hidden={hideTrigger}
			className={
				withLabel
					? "translation-menu-item translation-remove"
					: "translation-icon-button translation-remove"
			}
			aria-label={label}
			title={unresolved ? "请先确认当前翻译请求状态，再执行删除" : label}
			disabled={pending || unresolved}
			onClick={() => {
				removal.reset();
				setConfirmation(true);
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
				if (!pending) setConfirmation(false);
			}}
		>
			<h2 id={id}>删除此处全部译文？</h2>
			<blockquote className="translation-removal-target" lang="ja">
				{targetText(session.reference)}
			</blockquote>
			<p>
				将删除此处全部译文记录和正文翻译划线，并停止进行中的翻译任务。
				已保存的学习片段及关联译文记录会保留。
			</p>
			<InlineError error={removal.error} />
			<div className="actions">
				<button
					type="button"
					data-dialog-cancel
					disabled={pending}
					onClick={() => setConfirmation(false)}
				>
					取消
				</button>
				<button
					type="button"
					className="danger"
					disabled={pending}
					onClick={() => removal.mutate()}
				>
					{pending ? "正在删除…" : "确认删除"}
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
	hideTrigger?: boolean;
}) {
	const { action, dialog } = useTranslationRemoval(props);
	return (
		<>
			{action}
			{dialog}
		</>
	);
}
