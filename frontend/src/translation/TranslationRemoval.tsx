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

/** The same target command is available in the card and the chapter list. */
export function TranslationRemoval({
	session,
	onRemoved,
	label = "删除此处翻译",
}: {
	session: TranslationSession;
	onRemoved?: TranslationRemoved;
	label?: string;
}) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const state = useTranslationSession(session);
	const removal = useMutation({
		mutationFn: () => session.remove(),
		onSuccess: (removed) => {
			setOpen(false);
			onRemoved?.(removed, session.reference);
		},
	});
	const pending = removal.isPending || state.phase === "removing";
	const unresolved =
		state.phase === "submitting" || state.phase === "uncertain";
	return (
		<>
			<button
				type="button"
				className="translation-icon-button translation-remove"
				aria-label={label}
				title={unresolved ? "请先核实原提交，再删除此处翻译" : label}
				disabled={pending || unresolved}
				onClick={() => {
					removal.reset();
					setOpen(true);
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
			</button>
			{open && (
				<ConfirmDialog
					titleId={id}
					onClose={() => {
						if (!pending) setOpen(false);
					}}
				>
					<h2 id={id}>删除此处翻译？</h2>
					<blockquote className="translation-removal-target" lang="ja">
						{targetText(session.reference)}
					</blockquote>
					<p>
						将删除此处全部阅读译文历史和正文翻译划线，并停止进行中的重译。
						已另存的学习片段及关联译文快照保留。
					</p>
					<InlineError error={removal.error} />
					<div className="actions">
						<button
							type="button"
							data-dialog-cancel
							disabled={pending}
							onClick={() => setOpen(false)}
						>
							取消
						</button>
						<button
							type="button"
							className="danger"
							disabled={pending}
							onClick={() => removal.mutate()}
						>
							{pending ? "正在删除…" : "确认删除翻译"}
						</button>
					</div>
				</ConfirmDialog>
			)}
		</>
	);
}
