import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type ReaderCardDragStart,
	type ReaderCardPosition,
	readerCardDragPosition,
	readerCardKeyPosition,
} from "./reader-card-drag";

export function useReaderCardDrag(
	element: RefObject<HTMLElement | null>,
	enabled: boolean,
	clamp: (position: ReaderCardPosition) => ReaderCardPosition,
	onChange: (position: ReaderCardPosition) => void,
) {
	const current = useRef({ clamp, onChange });
	current.current = { clamp, onChange };
	const gesture = useRef<
		| (ReaderCardDragStart & {
				pointerId: number;
				handle: HTMLElement;
				dragging: boolean;
		  })
		| null
	>(null);
	const suppressClick = useRef(false);
	const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const [dragging, setDragging] = useState(false);
	const finish = useCallback(() => {
		const active = gesture.current;
		gesture.current = null;
		if (!active) return;
		if (active.handle.hasPointerCapture(active.pointerId))
			active.handle.releasePointerCapture(active.pointerId);
		if (active.dragging) {
			suppressClick.current = true;
			clearTimeout(clickTimer.current);
			clickTimer.current = setTimeout(() => {
				suppressClick.current = false;
			}, 0);
		}
		setDragging(false);
	}, []);
	useEffect(() => {
		if (!enabled) finish();
	}, [enabled, finish]);
	useEffect(
		() => () => {
			const active = gesture.current;
			gesture.current = null;
			if (active?.handle.hasPointerCapture(active.pointerId))
				active.handle.releasePointerCapture(active.pointerId);
			clearTimeout(clickTimer.current);
		},
		[],
	);
	const endPointer = (event: ReactPointerEvent<HTMLElement>) => {
		if (gesture.current?.pointerId === event.pointerId) finish();
	};
	return {
		dragging,
		handlers: {
			onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
				if (
					!enabled ||
					gesture.current ||
					event.button !== 0 ||
					!event.isPrimary ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey ||
					(event.target as Element).closest(
						"button, a, input, select, textarea",
					)
				)
					return;
				const rect = element.current?.getBoundingClientRect();
				if (!rect) return;
				const handle = event.currentTarget;
				event.preventDefault();
				handle.focus({ preventScroll: true });
				handle.setPointerCapture(event.pointerId);
				gesture.current = {
					pointerId: event.pointerId,
					handle,
					x: event.clientX,
					y: event.clientY,
					left: rect.left,
					top: rect.top,
					dragging: false,
				};
			},
			onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
				const active = gesture.current;
				if (!enabled || !active || active.pointerId !== event.pointerId) return;
				const position = readerCardDragPosition(
					active,
					{ x: event.clientX, y: event.clientY },
					active.dragging,
				);
				if (!position) return;
				event.preventDefault();
				active.dragging = true;
				setDragging(true);
				current.current.onChange(current.current.clamp(position));
			},
			onPointerUp: endPointer,
			onPointerCancel: endPointer,
			onLostPointerCapture: endPointer,
			onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
				if (!suppressClick.current) return;
				suppressClick.current = false;
				event.preventDefault();
				event.stopPropagation();
			},
			onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
				if (
					!enabled ||
					event.target !== event.currentTarget ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.nativeEvent.isComposing
				)
					return;
				const rect = element.current?.getBoundingClientRect();
				if (!rect) return;
				const position = readerCardKeyPosition(
					{ left: rect.left, top: rect.top },
					event.key,
					event.shiftKey,
				);
				if (!position) return;
				event.preventDefault();
				event.stopPropagation();
				current.current.onChange(current.current.clamp(position));
			},
		},
	};
}
