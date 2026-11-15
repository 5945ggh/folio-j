import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SelectionActions } from "../selection/SelectionActions";
import type { ScreenAnchor } from "./reader-study";
import { studyOverlayPosition } from "./study-overlays";
import "./study-overlays.css";
import "./reader-popover.css";

export function SelectionToolbar({
	onLookup,
	anchor,
	onSave,
	onTranslate,
	onSpeak,
	onCopy,
	copying = false,
	onClose,
}: {
	onLookup?: () => void;
	onTranslate?: () => void;
	onSpeak?: () => void;
	onCopy?: () => void;
	copying?: boolean;
	anchor: ScreenAnchor;
	onSave: () => void;
	onClose: () => void;
}) {
	const element = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const node = element.current;
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
				return;
			event.preventDefault();
			event.stopPropagation();
			close.current();
		};
		node?.addEventListener("keydown", handleEscape);
		return () => node?.removeEventListener("keydown", handleEscape);
	}, []);
	const [position, setPosition] = useState({ left: 12, top: 64 });
	useLayoutEffect(() => {
		const node = element.current;
		if (!node) return;
		const measure = () =>
			setPosition(
				studyOverlayPosition(
					anchor,
					{ width: window.innerWidth, height: window.innerHeight },
					{ width: node.offsetWidth, height: node.offsetHeight },
				),
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [anchor]);
	return (
		<SelectionActions
			ref={element}
			style={position}
			data-reader-tool=""
			onTranslate={onTranslate}
			onSpeak={onSpeak}
			onLookup={onLookup}
			onCopy={onCopy}
			copying={copying}
			onSave={onSave}
			saveButtonId="reader-selection-save"
		/>
	);
}

export function SavedSegmentNotice({
	id,
	kind,
	onOpen,
	onClose,
}: {
	id: string;
	kind: "created" | "existing";
	onOpen: () => void;
	onClose: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	const [focused, setFocused] = useState(false);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (hovered || focused) return;
		const timer = setTimeout(() => close.current(), 12000);
		return () => clearTimeout(timer);
	}, [hovered, focused]);
	return (
		<div
			className="reader-study-notice"
			data-segment-id={id}
			role="status"
			aria-live="polite"
			data-reader-tool=""
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setFocused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget))
					setFocused(false);
			}}
		>
			<span>{kind === "created" ? "已保存学习片段" : "已选用已有片段"}</span>
			<button
				type="button"
				className="reader-study-notice-open"
				onClick={onOpen}
			>
				打开片段 →
			</button>
			<button type="button" aria-label="关闭保存提示" onClick={onClose}>
				×
			</button>
		</div>
	);
}
