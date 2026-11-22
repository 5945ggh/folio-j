import {
	type KeyboardEvent,
	type ToggleEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

function enabledItems(menu: HTMLDivElement) {
	return Array.from(
		menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
	);
}

export function useAnalysisActionMenu() {
	const menuId = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const lastItemFirst = useRef(false);
	const [open, setOpen] = useState(false);

	useLayoutEffect(() => {
		const element = menu.current;
		const anchor = trigger.current;
		if (!open || !element || !anchor) return;
		const positionMenu = () => {
			const bounds = anchor.getBoundingClientRect();
			const box = element.getBoundingClientRect();
			element.style.top = `${Math.max(8, Math.min(bounds.bottom + 6, window.innerHeight - box.height - 8))}px`;
			element.style.left = `${Math.max(8, Math.min(bounds.right - box.width, window.innerWidth - box.width - 8))}px`;
		};
		positionMenu();
		enabledItems(element)
			.at(lastItemFirst.current ? -1 : 0)
			?.focus();
		lastItemFirst.current = false;
		window.addEventListener("resize", positionMenu);
		window.addEventListener("scroll", positionMenu, true);
		return () => {
			window.removeEventListener("resize", positionMenu);
			window.removeEventListener("scroll", positionMenu, true);
		};
	}, [open]);

	function restoreFocus() {
		trigger.current?.focus({ preventScroll: true });
	}
	function closeMenu() {
		menu.current?.hidePopover();
		restoreFocus();
	}
	function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		lastItemFirst.current = event.key === "ArrowUp";
		menu.current?.showPopover();
	}
	function onToggle(event: ToggleEvent<HTMLDivElement>) {
		setOpen(event.newState === "open");
		if (
			event.newState === "closed" &&
			(event.currentTarget.contains(document.activeElement) ||
				document.activeElement === document.body)
		) {
			restoreFocus();
		}
	}
	function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape" || event.key === "Tab") {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
			}
			closeMenu();
			return;
		}
		const items = enabledItems(event.currentTarget);
		if (!items.length) return;
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		let next: number;
		switch (event.key) {
			case "Home":
				next = 0;
				break;
			case "End":
				next = items.length - 1;
				break;
			case "ArrowDown":
				next = (index + 1) % items.length;
				break;
			case "ArrowUp":
				next = (index - 1 + items.length) % items.length;
				break;
			default:
				return;
		}
		event.preventDefault();
		items[next]?.focus();
	}
	return {
		triggerProps: {
			ref: trigger,
			"aria-haspopup": "menu" as const,
			"aria-controls": menuId,
			"aria-expanded": open,
			popoverTarget: menuId,
			onKeyDown: onTriggerKeyDown,
		},
		menuProps: {
			ref: menu,
			id: menuId,
			popover: "auto" as const,
			onToggle,
			onKeyDown: onMenuKeyDown,
		},
		closeMenu,
	};
}
