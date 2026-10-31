import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { Segment, Source } from "../content";
import { getSegmentProvenance } from "../materials/study-api";
import { segmentShareText } from "./share";
import "./share.css";

type CopyMode = "full" | "original" | "source";
const copyLabels: Record<CopyMode, string> = {
	full: "原文与出处",
	original: "原文",
	source: "出处",
};

export type ShareSourceQuery = Pick<
	UseQueryResult<Source>,
	"data" | "isPending" | "isError" | "refetch"
>;

export function SegmentShare({
	segment,
	sourceTitle,
	sourceQuery,
	interactive,
}: {
	segment: Segment;
	sourceTitle?: string;
	sourceQuery?: ShareSourceQuery;
	interactive: boolean;
}) {
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDialogElement>(null);
	const primary = useRef<HTMLButtonElement>(null);
	const preview = useRef<HTMLElement>(null);
	const backdropPress = useRef(false);
	const copyAttempt = useRef(0);
	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<CopyMode>("full");
	const [message, setMessage] = useState("");
	const [copying, setCopying] = useState(false);
	const origin = useQuery({
		queryKey: ["segments", segment.id, "material-provenance"],
		queryFn: ({ signal }) => getSegmentProvenance(segment.id, signal),
		// Subscribe with the page; opening the dialog must not re-enable a stale query.
		enabled: !!segment.material_provenance,
	});
	const text = segmentShareText(
		segment,
		sourceQuery?.data?.title ?? sourceTitle,
		segment.material_provenance ? origin : undefined,
	);
	const loadingOrigin =
		!!segment.material_provenance && (origin.isPending || origin.isFetching);
	const hasMaterialTitle =
		!!segment.material_provenance &&
		origin.isSuccess &&
		!origin.isFetching &&
		origin.data.segment_id === segment.id &&
		!!origin.data.title?.trim();
	const loadingSource = !hasMaterialTitle && sourceQuery?.isPending === true;
	const loadingAttribution = loadingOrigin || loadingSource;
	const hasContext = !!(
		segment.context_before.trim() || segment.context_after.trim()
	);
	const close = () => {
		copyAttempt.current++;
		setOpen(false);
		setCopying(false);
		setMessage("");
	};
	useEffect(() => {
		if (!open) return;
		const element = panel.current;
		element?.showModal();
		preview.current?.scrollTo({ top: 0 });
		if (primary.current?.disabled) preview.current?.focus();
		else primary.current?.focus();
		return () => {
			element?.close();
			trigger.current?.focus({ preventScroll: true });
		};
	}, [open]);
	useEffect(() => {
		if (interactive) return;
		copyAttempt.current++;
		setOpen(false);
		setCopying(false);
		setMessage("");
	}, [interactive]);
	useEffect(
		() => () => {
			copyAttempt.current++;
		},
		[],
	);
	const copy = async () => {
		const attempt = ++copyAttempt.current;
		setMessage("");
		setCopying(true);
		try {
			if (!navigator.clipboard?.writeText) throw new Error("clipboard");
			await navigator.clipboard.writeText(text[mode]);
			if (attempt === copyAttempt.current)
				setMessage(`已复制${copyLabels[mode]}`);
		} catch {
			if (attempt === copyAttempt.current)
				setMessage("复制失败，可选中预览文字手动复制。");
		} finally {
			if (attempt === copyAttempt.current) setCopying(false);
		}
	};
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="segment-share-trigger"
				aria-label="复制分享"
				title="复制分享"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={id}
				disabled={!interactive}
				onClick={() => {
					copyAttempt.current++;
					setMode("full");
					setMessage("");
					setCopying(false);
					setOpen(true);
				}}
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 15V3m-4 4 4-4 4 4M5 11v9h14v-9" />
				</svg>
			</button>
			<dialog
				ref={panel}
				id={id}
				aria-labelledby={`${id}-title`}
				aria-describedby={`${id}-description`}
				className="segment-share-dialog dialog-enter-motion"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						close();
					} else if (event.key === "Tab") {
						const controls = Array.from(
							event.currentTarget.querySelectorAll<HTMLElement>(
								"button:not(:disabled),select:not(:disabled),[tabindex='0']",
							),
						);
						const first = controls[0];
						const last = controls.at(-1);
						if (event.shiftKey && document.activeElement === first) {
							event.preventDefault();
							last?.focus();
						} else if (!event.shiftKey && document.activeElement === last) {
							event.preventDefault();
							first?.focus();
						}
					}
				}}
				onCancel={(event) => {
					event.preventDefault();
					event.stopPropagation();
					close();
				}}
				onClose={() => {
					if (!panel.current?.open) close();
				}}
				onPointerDown={(event) => {
					backdropPress.current = event.target === event.currentTarget;
				}}
				onClick={(event) => {
					if (!backdropPress.current || event.target !== event.currentTarget)
						return;
					const bounds = event.currentTarget.getBoundingClientRect();
					if (
						event.clientX < bounds.left ||
						event.clientX > bounds.right ||
						event.clientY < bounds.top ||
						event.clientY > bounds.bottom
					)
						close();
				}}
			>
				<header className="segment-share-header">
					<div>
						<h2 id={`${id}-title`}>复制分享</h2>
						<p id={`${id}-description`}>带走这段文字，粘贴到 AI 或笔记工具</p>
					</div>
					<button
						type="button"
						className="segment-share-close"
						aria-label="关闭复制分享"
						onClick={close}
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<path d="m6 6 12 12M18 6 6 18" />
						</svg>
					</button>
				</header>
				<div className="segment-share-preview-label">
					<span>内容预览</span>
					<span>
						{mode === "full" && hasContext
							? "含前后文 · 引用块为当前片段"
							: copyLabels[mode]}
					</span>
				</div>
				<section
					ref={preview}
					className="segment-share-preview"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: The read-only preview needs keyboard scrolling and manual text selection.
					tabIndex={0}
					aria-label="复制内容预览"
				>
					{text[mode]}
				</section>
				{segment.material_provenance && origin.isError ? (
					<p className="segment-share-origin-status" role="status">
						材料出处读取失败，仍可复制已保存内容。
						<button type="button" onClick={() => void origin.refetch()}>
							重试
						</button>
					</p>
				) : null}
				{!hasMaterialTitle && sourceQuery?.isError ? (
					<p className="segment-share-origin-status" role="status">
						来源信息读取失败，可重试或复制现有内容。
						<button type="button" onClick={() => void sourceQuery.refetch()}>
							重试来源
						</button>
					</p>
				) : null}
				<footer className="segment-share-footer">
					<p className="segment-share-feedback" role="status">
						{message || "复制后即可粘贴使用"}
					</p>
					<div className="segment-share-copy">
						<button
							ref={primary}
							type="button"
							className="segment-share-main"
							disabled={
								copying ||
								(mode !== "original" && loadingAttribution) ||
								!text[mode]
							}
							onClick={() => void copy()}
						>
							{copying ? "正在复制…" : `复制${copyLabels[mode]}`}
						</button>
						<div className="segment-share-mode">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.7"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="m6 9 6 6 6-6" />
							</svg>
							<select
								aria-label="复制范围"
								value={mode}
								disabled={copying}
								onChange={(event) => {
									setMode(event.target.value as CopyMode);
									setMessage("");
									preview.current?.scrollTo({ top: 0 });
								}}
							>
								<option value="full">
									原文与出处{hasContext ? "（含前后文）" : ""}
								</option>
								<option value="original">仅原文</option>
								<option
									value="source"
									disabled={loadingAttribution || !text.source}
								>
									仅出处
								</option>
							</select>
						</div>
					</div>
				</footer>
			</dialog>
		</>
	);
}
