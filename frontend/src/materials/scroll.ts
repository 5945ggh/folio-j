type WheelInput = Pick<
	WheelEvent,
	"deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "defaultPrevented"
>;

/** Leave native scrolling intact except for outer gutters and vertical reading's wheel axis. */
export function readerWheelScroll(
	event: WheelInput,
	options: {
		vertical: boolean;
		outside: boolean;
		lineHeight: number;
		pageSize: number;
	},
): ScrollToOptions | null {
	if (event.defaultPrevented || event.ctrlKey) return null;
	const remap =
		options.vertical && Math.abs(event.deltaY) > Math.abs(event.deltaX);
	if (!options.outside && !remap) return null;
	if (!event.deltaX && !event.deltaY) return null;
	const unit =
		event.deltaMode === 1
			? options.lineHeight
			: event.deltaMode === 2
				? options.pageSize
				: 1;
	return {
		left: (remap ? -event.deltaY : event.deltaX) * unit,
		top: remap ? 0 : event.deltaY * unit,
		behavior: "instant",
	};
}
