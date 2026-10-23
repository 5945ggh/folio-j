import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { ScreenAnchor } from "./reader-study";
import { studyOverlayPosition } from "./study-overlays";
import "./study-overlays.css";

function AnchoredStudyTool({
	anchor,
	label,
	role,
	children,
	onClose,
	fixed = false,
}: {
	fixed?: boolean;
	anchor: ScreenAnchor;
	label: string;
	role: "toolbar" | "dialog";
	children: ReactNode;
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
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: both permitted roles support an accessible label.
		<div
			ref={element}
			className={`reader-study-tool ${role}${fixed ? " fixed" : ""}`}
			style={fixed ? undefined : position}
			role={role}
			aria-label={label}
			aria-modal={role === "dialog" ? false : undefined}
			data-reader-tool=""
		>
			{children}
		</div>
	);
}

export function SelectionToolbar({
	anchor,
	onSave,
	onTranslate,
	onSpeak,
	onClose,
}: {
	onTranslate?: () => void;
	onSpeak?: () => void;
	anchor: ScreenAnchor;
	onSave: () => void;
	onClose: () => void;
}) {
	return (
		<AnchoredStudyTool
			anchor={anchor}
			label="选区操作"
			role="toolbar"
			onClose={onClose}
		>
			{onTranslate && (
				<button
					type="button"
					onMouseDown={(event) => event.preventDefault()}
					onClick={onTranslate}
				>
					翻译
				</button>
			)}
			{onSpeak && (
				<button
					type="button"
					onMouseDown={(event) => event.preventDefault()}
					onClick={onSpeak}
				>
					朗读
				</button>
			)}
			<button
				id="reader-selection-save"
				type="button"
				aria-label="保存为学习片段"
				data-tooltip="保存为学习片段"
				onMouseDown={(event) => event.preventDefault()}
				onClick={onSave}
			>
				保存
			</button>
			<button
				type="button"
				aria-label="关闭选区工具栏"
				onMouseDown={(event) => event.preventDefault()}
				onClick={onClose}
			>
				×
			</button>
		</AnchoredStudyTool>
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
		const timer = setTimeout(() => close.current(), 6000);
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
			<button type="button" onClick={onOpen}>
				打开片段 →
			</button>
			<button type="button" aria-label="关闭保存提示" onClick={onClose}>
				×
			</button>
		</div>
	);
}
