import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

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
	const lastItemFirst = useRef(false);
	const [open, setOpen] = useState(false);
	const positionMenu = useCallback(() => {
		const element = menu.current;
		const bounds = trigger.current?.getBoundingClientRect();
		if (!element || !bounds) return;
		const box = element.getBoundingClientRect();
		element.style.top = `${Math.max(8, Math.min(bounds.bottom + 6, window.innerHeight - box.height - 8))}px`;
		element.style.left = `${Math.max(8, Math.min(bounds.right - box.width, window.innerWidth - box.width - 8))}px`;
	}, []);
	useLayoutEffect(() => {
		if (!open) return;
		positionMenu();
		const items = menu.current?.querySelectorAll<HTMLButtonElement>(
			"button:not(:disabled)",
		);
		(lastItemFirst.current
			? items?.item(items.length - 1)
			: items?.item(0)
		)?.focus();
		lastItemFirst.current = false;
	}, [open, positionMenu]);
	useEffect(() => {
		if (!open) return;
		window.addEventListener("resize", positionMenu);
		window.addEventListener("scroll", positionMenu, true);
		return () => {
			window.removeEventListener("resize", positionMenu);
			window.removeEventListener("scroll", positionMenu, true);
		};
	}, [open, positionMenu]);
	useEffect(() => {
		if (disabled) menu.current?.hidePopover();
	}, [disabled]);
	const closeMenu = () => {
		menu.current?.hidePopover();
		trigger.current?.focus({ preventScroll: true });
	};
	return (
		<div className="segment-new-analysis">
			<button
				ref={trigger}
				id="manual-analysis-create"
				className="analysis-quiet-button"
				type="button"
				disabled={disabled}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={menuId}
				popoverTarget={menuId}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					lastItemFirst.current = event.key === "ArrowUp";
					menu.current?.showPopover();
				}}
			>
				＋ 新建讲解
			</button>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				className="segment-create-menu"
				role="menu"
				aria-label="新建讲解"
				onToggle={(event) => {
					setOpen(event.newState === "open");
					if (
						event.newState === "closed" &&
						(menu.current?.contains(document.activeElement) ||
							document.activeElement === document.body)
					)
						trigger.current?.focus({ preventScroll: true });
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape" || event.key === "Tab") {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
						}
						closeMenu();
						return;
					}
					const items = Array.from(
						event.currentTarget.querySelectorAll<HTMLButtonElement>(
							"button:not(:disabled)",
						),
					);
					if (!items.length) return;
					const index = items.indexOf(
						document.activeElement as HTMLButtonElement,
					);
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? items.length - 1
								: event.key === "ArrowDown"
									? (index + 1) % items.length
									: event.key === "ArrowUp"
										? (index - 1 + items.length) % items.length
										: null;
					if (next !== null) {
						event.preventDefault();
						items[next]?.focus();
					}
				}}
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
					自己编写
				</button>
				<button
					className="button"
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={disabled || generationDisabled}
					title={generationDisabled ? "已有讲解正在生成" : undefined}
					onClick={() => {
						closeMenu();
						onGenerate();
					}}
				>
					使用 AI 生成
				</button>
			</div>
		</div>
	);
}
