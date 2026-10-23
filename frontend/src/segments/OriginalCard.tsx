import { useId, useState } from "react";
import { createPortal } from "react-dom";
import type { Segment } from "../content";
import { SegmentMaterialOrigin } from "../materials/SegmentMaterialOrigin";
import { ConfirmDialog, dateLabel } from "../Shared";
import "./material-fields.css";
import "./original-card.css";

function Field({
	label,
	value,
	lang,
}: {
	label: string;
	value: string;
	lang?: string;
}) {
	return value.trim() ? (
		<section className="segment-material-field">
			<h4>{label}</h4>
			<p lang={lang}>{value}</p>
		</section>
	) : null;
}

/** Context is a preview of saved fields; the popup keeps every character readable. */
export function OriginalCard({
	segment,
	onEdit,
	returnFocusId = "segment-original-trigger",
}: {
	segment: Segment;
	onEdit: () => void;
	returnFocusId?: string;
}) {
	const [open, setOpen] = useState(false);
	const titleId = useId();
	const overlayHost = document.getElementById("segment-overlays");
	const close = () => {
		setOpen(false);
		requestAnimationFrame(() =>
			document.getElementById(returnFocusId)?.focus({ preventScroll: true }),
		);
	};
	return (
		<section id="segment-original" aria-label="原文">
			<button
				id="segment-original-trigger"
				type="button"
				className="segment-original-card"
				aria-label="查看完整原文与资料"
				aria-haspopup="dialog"
				onClick={() => setOpen(true)}
			>
				<span className="segment-original-label">原文</span>
				<span className="segment-context-preview" lang="ja">
					{segment.context_before.trim() && (
						<span className="segment-context-line segment-context-before">
							<span>{segment.context_before}</span>
						</span>
					)}
					<span className="segment-original-focus">{segment.text}</span>
					{segment.context_after.trim() && (
						<span className="segment-context-line segment-context-after">
							<span>{segment.context_after}</span>
						</span>
					)}
				</span>
				<span className="segment-original-footer">
					<span>查看完整原文与资料</span>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						aria-hidden="true"
					>
						<path d="M14 4h6v6M20 4l-9 9M10 4H4v16h16v-6" />
					</svg>
				</span>
			</button>
			{open &&
				overlayHost &&
				createPortal(
					<ConfirmDialog
						titleId={titleId}
						className="segment-material-dialog"
						restoreFocusId="segment-original-trigger"
						onClose={close}
					>
						<header className="segment-material-header">
							<h2 id={titleId}>原文与资料</h2>
							<button
								type="button"
								className="segment-material-close"
								aria-label="关闭原文与资料"
								data-dialog-cancel
								onClick={close}
							>
								×
							</button>
						</header>
						<section
							className="segment-material-body"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: This scrolling text region needs keyboard access.
							tabIndex={0}
							aria-label="完整原文与补充资料"
						>
							<section
								className="segment-material-group"
								aria-label="原文与语境"
							>
								<h3 className="segment-group-title">原文与语境</h3>
								<Field label="前文" value={segment.context_before} lang="ja" />
								<Field label="目标原文" value={segment.text} lang="ja" />
								<Field label="后文" value={segment.context_after} lang="ja" />
							</section>
							{(segment.translation.trim() || segment.transcription.trim()) && (
								<section
									className="segment-material-group"
									aria-label="译文与听写"
								>
									<h3 className="segment-group-title">译文与听写</h3>
									<Field label="译文" value={segment.translation} />
									<Field label="听写" value={segment.transcription} lang="ja" />
								</section>
							)}
							{(segment.material_provenance ||
								segment.source_ref.trim() ||
								segment.note.trim()) && (
								<section
									className="segment-material-group"
									aria-label="出处与备注"
								>
									<h3 className="segment-group-title">出处与备注</h3>
									<SegmentMaterialOrigin segment={segment} />
									<Field
										label={
											segment.material_provenance ? "出处补充" : "出处说明"
										}
										value={segment.source_ref}
									/>
									<Field label="个人管理备注" value={segment.note} />
								</section>
							)}
							<p className="segment-material-date">
								{dateLabel(segment.created_at)} 保存
							</p>
						</section>
						<footer className="segment-material-actions">
							<button
								type="button"
								className="button secondary"
								onClick={() => {
									setOpen(false);
									onEdit();
								}}
							>
								编辑片段资料
							</button>
							<button type="button" className="button primary" onClick={close}>
								完成
							</button>
						</footer>
					</ConfirmDialog>,
					overlayHost,
				)}
		</section>
	);
}
