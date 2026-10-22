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
	fixed = false,
	loading = false,
}: {
	fixed?: boolean;
	loading?: boolean;
	anchor: ScreenAnchor;
	items: readonly ChapterSegment[];
	onOpen: (id: string) => void;
	onClose: () => void;
	onEmphasize: (id: string | null) => void;
}) {
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (anchor) closeButton.current?.focus({ preventScroll: true });
	}, [anchor]);
	return (
		<AnchoredStudyTool
			anchor={anchor}
			fixed={fixed}
			label={fixed ? "本章片段" : "此处的学习片段"}
			role="dialog"
			onClose={onClose}
		>
			<div>
				<header>
					<strong>
						{fixed
							? `本章片段 · ${items.length}`
							: items.length === 1
								? "学习片段"
								: `此处有 ${items.length} 个学习片段`}
					</strong>
					<button
						type="button"
						ref={closeButton}
						aria-label="关闭片段浮层"
						onClick={onClose}
					>
						×
					</button>
				</header>
				<p className="reader-study-list-hint">
					{fixed
						? "固定本章列表 · 指向或聚焦条目查看原文范围"
						: "指向或聚焦条目查看全部原文范围"}
				</p>
				{loading ? (
					<p role="status">正在读取本章全部片段…</p>
				) : items.length === 0 ? (
					<p>本章暂无可定位片段。</p>
				) : null}
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
							<small>
								{new Date(item.created_at).toLocaleString()} · {item.segment_id}
							</small>
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
