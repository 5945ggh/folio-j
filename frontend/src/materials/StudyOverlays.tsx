import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { ScreenAnchor } from "./reader-study";
import type { ChapterSegment } from "./study-api";
import { studyOverlayPosition } from "./study-overlays";
import "./study-overlays.css";

function AnchoredStudyTool({
	anchor,
	label,
	role,
	children,
	onClose,
}: {
	anchor: ScreenAnchor;
	label: string;
	role: "toolbar" | "dialog";
	children: ReactNode;
	onClose: () => void;
}) {
	const element = useRef<HTMLDivElement>(null);
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
		// biome-ignore lint/a11y/noStaticElementInteractions: the role is constrained to an explicitly named toolbar or nonmodal dialog.
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: both permitted roles support an accessible label.
		<div
			ref={element}
			className={`reader-study-tool ${role}`}
			style={position}
			role={role}
			aria-label={label}
			aria-modal={role === "dialog" ? false : undefined}
			data-reader-tool=""
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			{children}
		</div>
	);
}

export function SelectionToolbar({
	anchor,
	onSave,
	onClose,
}: {
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
			<button
				id="reader-selection-save"
				type="button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={onSave}
			>
				保存为学习片段
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

export function StudyMarkPopover({
	anchor,
	items,
	onOpen,
	onClose,
	onEmphasize,
}: {
	anchor: ScreenAnchor;
	items: readonly ChapterSegment[];
	onOpen: (id: string) => void;
	onClose: () => void;
	onEmphasize: (id: string | null) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) onClose();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [onClose]);
	return (
		<AnchoredStudyTool
			anchor={anchor}
			label="此处的学习片段"
			role="dialog"
			onClose={onClose}
		>
			<div ref={root}>
				<header>
					<strong>
						{items.length === 1
							? "学习片段"
							: `此处有 ${items.length} 个学习片段`}
					</strong>
					<button type="button" aria-label="关闭片段浮层" onClick={onClose}>
						×
					</button>
				</header>
				<div className="reader-study-records">
					{items.map((item) => (
						<article
							key={item.segment_id}
							onMouseEnter={() => onEmphasize(item.segment_id)}
							onMouseLeave={() => onEmphasize(null)}
							onFocus={() => onEmphasize(item.segment_id)}
							onBlur={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget))
									onEmphasize(null);
							}}
						>
							<p lang="ja">{item.excerpt}</p>
							<button type="button" onClick={() => onOpen(item.segment_id)}>
								打开片段
							</button>
						</article>
					))}
				</div>
			</div>
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
