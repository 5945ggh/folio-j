export function handleDialogCancel(
	event: Pick<Event, "target" | "currentTarget" | "preventDefault">,
	onClose: () => void,
): void {
	if (event.target !== event.currentTarget) return;
	event.preventDefault();
	onClose();
}
