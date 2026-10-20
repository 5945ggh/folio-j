import { useId, useRef } from "react";

/** Creation belongs to the collection; callers own the execution lifecycle. */
export function NewAnalysisActions({
	onCreate,
	onGenerate,
	disabled,
	generationDisabled,
}: {
	onCreate: () => void;
	onGenerate: () => void;
	disabled: boolean;
	generationDisabled: boolean;
}) {
	const menuId = useId();
	const menu = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<div className="segment-new-analysis">
			<button
				id="manual-analysis-create"
				className="analysis-quiet-button"
				type="button"
				disabled={disabled}
				onClick={onCreate}
			>
				＋ 新建讲解
			</button>
			<button
				ref={trigger}
				type="button"
				className="analysis-quiet-button"
				aria-label="其他新建讲解方式"
				popoverTarget={menuId}
				disabled={disabled}
			>
				⌄
			</button>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				className="segment-create-menu"
				onToggle={(event) => {
					if (event.newState !== "open") return;
					const bounds = trigger.current?.getBoundingClientRect();
					if (!bounds || !menu.current) return;
					menu.current.style.top = `${Math.min(bounds.bottom + 6, window.innerHeight - 68)}px`;
					menu.current.style.left = `${Math.max(12, Math.min(bounds.right - 200, window.innerWidth - 212))}px`;
				}}
			>
				<button
					className="button"
					type="button"
					disabled={generationDisabled}
					onClick={() => {
						menu.current?.hidePopover();
						onGenerate();
					}}
				>
					AI 生成总体讲解
				</button>
			</div>
		</div>
	);
}
