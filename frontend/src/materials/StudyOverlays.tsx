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

function ToolIcon({ name }: { name: "translate" | "speak" | "save" | "copy" }) {
	const path = {
		copy: "M9 8h11v13H9zM5 16H3V3h11v2",
		translate: "m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1m10 20-5-10-5 10M14 18h6",
		speak:
			"M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14",
		save: "M6 4h12v16l-6-4-6 4z",
	}[name];
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}

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
	onCopy,
	copying = false,
	onClose,
}: {
	onTranslate?: () => void;
	onSpeak?: () => void;
	onCopy?: () => void;
	copying?: boolean;
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
			{onCopy && (
				<button
					type="button"
					aria-label="带上下文复制"
					aria-busy={copying}
					disabled={copying}
					onMouseDown={(event) => event.preventDefault()}
					onClick={onCopy}
				>
					<ToolIcon name="copy" />
					带上下文复制
				</button>
			)}
			{onTranslate && (
				<button
					type="button"
					onMouseDown={(event) => event.preventDefault()}
					onClick={onTranslate}
				>
					<ToolIcon name="translate" />
					翻译
				</button>
			)}
			{onSpeak && (
				<button
					type="button"
					onMouseDown={(event) => event.preventDefault()}
					onClick={onSpeak}
				>
					<ToolIcon name="speak" />
					朗读
				</button>
			)}
			<span className="reader-tool-divider" aria-hidden="true" />
			<button
				id="reader-selection-save"
				type="button"
				className="primary"
				aria-label="保存为学习片段"
				data-tooltip="保存为学习片段"
				onMouseDown={(event) => event.preventDefault()}
				onClick={onSave}
			>
				<ToolIcon name="save" />
				保存
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
