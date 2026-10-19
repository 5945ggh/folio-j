export type BookMenuPage = "main" | "status";

export function bookMenuPageForKey(
	page: BookMenuPage,
	key: string,
	statusTriggerFocused: boolean,
): BookMenuPage {
	if (page === "main" && key === "ArrowRight" && statusTriggerFocused) {
		return "status";
	}
	if (page === "status" && (key === "ArrowLeft" || key === "Escape")) {
		return "main";
	}
	return page;
}

export function nextBookMenuIndex(
	disabled: readonly boolean[],
	current: number,
	key: string,
): number | null {
	const enabled = disabled.flatMap((value, index) => (value ? [] : [index]));
	if (!enabled.length) return null;
	if (key === "Home") return enabled[0] ?? null;
	if (key === "End") return enabled.at(-1) ?? null;
	if (key !== "ArrowDown" && key !== "ArrowUp") return null;
	const active = enabled.indexOf(current);
	const next =
		active < 0
			? key === "ArrowDown"
				? 0
				: enabled.length - 1
			: (active + (key === "ArrowDown" ? 1 : -1) + enabled.length) %
				enabled.length;
	return enabled[next] ?? null;
}
