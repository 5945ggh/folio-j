import { useId, useRef, useState } from "react";
import { Icon } from "./LibraryTools";

export function SegmentMenu({
	id,
	onDelete,
}: {
	id: string;
	onDelete: () => void;
}) {
	const menuId = useId();
	const menu = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				id={`segment-menu-${id}`}
				ref={trigger}
				type="button"
				className="library-icon segment-menu-trigger"
				aria-label="片段更多操作"
				title="片段更多操作"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={menuId}
				popoverTarget={menuId}
			>
				<Icon name="more" />
			</button>
			<div
				id={menuId}
				ref={menu}
				popover="auto"
				role="menu"
				aria-label="片段更多操作"
				className="library-popover segment-list-menu"
				onToggle={(event) => {
					setOpen(event.newState === "open");
					if (event.newState !== "open") return;
					const box = trigger.current?.getBoundingClientRect();
					if (!box) return;
					const panel = event.currentTarget;
					panel.style.top = `${Math.max(12, Math.min(box.bottom + 6, innerHeight - panel.offsetHeight - 12))}px`;
					panel.style.right = `${Math.max(12, Math.min(innerWidth - box.right, innerWidth - panel.offsetWidth - 12))}px`;
					panel.querySelector<HTMLButtonElement>("button")?.focus();
				}}
				onKeyDown={(event) => {
					if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
						event.preventDefault();
						event.currentTarget
							.querySelector<HTMLButtonElement>("button")
							?.focus();
					} else if (event.key === "Escape" || event.key === "Tab") {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
						}
						menu.current?.hidePopover();
						trigger.current?.focus();
					}
				}}
			>
				<button
					type="button"
					role="menuitem"
					tabIndex={-1}
					className="text-danger"
					onClick={() => {
						menu.current?.hidePopover();
						trigger.current?.focus();
						onDelete();
					}}
				>
					删除片段…
				</button>
			</div>
		</>
	);
}
