import { useEffect } from "react";
import { useAnalysisActionMenu } from "../analysis/useAnalysisActionMenu";

import {
	ExplanationPromptCopyFeedback,
	useExplanationPromptCopy,
} from "./ExplanationPromptCopy";

/** Creation belongs to the collection; callers own the execution lifecycle. */
export function NewAnalysisActions({
	segmentId,
	onCreate,
	onExplain,
	disabled,
}: {
	segmentId: string;
	onCreate: () => void;
	onExplain: () => void;
	disabled: boolean;
}) {
	const { triggerProps, menuProps, closeMenu } = useAnalysisActionMenu();
	const promptCopy = useExplanationPromptCopy(segmentId, disabled);
	const menu = menuProps.ref;
	useEffect(() => {
		if (disabled) menu.current?.hidePopover();
	}, [disabled, menu]);
	return (
		<div className="segment-new-analysis">
			<button
				{...triggerProps}
				id="manual-analysis-create"
				className="analysis-quiet-button"
				type="button"
				disabled={disabled}
			>
				＋ 新建讲解
			</button>
			<div
				{...menuProps}
				role="menu"
				className="segment-create-menu popover-motion"
				aria-label="新建讲解"
			>
				<button
					className="button"
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={disabled}
					onClick={() => {
						closeMenu();
						onCreate();
					}}
				>
					编写或粘贴讲解
				</button>
				<button
					className="button"
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={disabled}
					onClick={() => {
						closeMenu();
						onExplain();
					}}
				>
					创建 AI 讲解
				</button>
				<button
					className="button"
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={disabled}
					onClick={() => {
						closeMenu();
						void promptCopy.copy();
					}}
				>
					复制讲解提示词
				</button>
			</div>
			<ExplanationPromptCopyFeedback
				state={promptCopy.state}
				onCopy={promptCopy.copy}
				onDismiss={promptCopy.dismiss}
				trigger={triggerProps.ref}
			/>
		</div>
	);
}
