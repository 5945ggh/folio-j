import { ConfirmDialog } from "../Shared";
import { FIELD_TYPE_LABELS } from "./AnkiMappingField";
import type { BuiltinNoteType } from "./api";
import type { AnkiMaterialContext } from "./context";
import {
	type AnkiConfigOption,
	type AnkiDraftValues,
	buildPreviewFieldMap,
	fieldValueKey,
	getFieldText,
	renderBuiltinTemplate,
} from "./draft";

export function AnkiCardPreviewModal({
	mode,
	config,
	draft,
	context,
	builtinNoteType,
	sharedCss,
	night,
	deckName,
	noteTypeName,
	busy = false,
	onClose,
	onConfirmInstall,
}: {
	mode: "preview" | "install";
	config: AnkiConfigOption;
	draft: AnkiDraftValues;
	context: AnkiMaterialContext;
	builtinNoteType: BuiltinNoteType | null;
	sharedCss: string;
	night: boolean;
	deckName: string | null;
	noteTypeName: string;
	busy?: boolean;
	onClose: () => void;
	onConfirmInstall?: () => void;
}) {
	const template = builtinNoteType?.card_templates[0] ?? null;
	const frontHtml = template
		? renderBuiltinTemplate(
				template.front,
				buildPreviewFieldMap(config, draft, context, "front"),
			)
		: null;
	const backHtml = template
		? renderBuiltinTemplate(
				template.back,
				buildPreviewFieldMap(config, draft, context, "back"),
			)
		: null;

	const mappedFields = config.fields.filter((field) =>
		Boolean(field.target_field?.trim()),
	);

	return (
		<ConfirmDialog
			className="anki-modal"
			titleId="anki-preview-modal-title"
			onClose={() => {
				if (!busy) onClose();
			}}
		>
			<div className="anki-modal-head">
				<div>
					<h2 id="anki-preview-modal-title">
						{mode === "install"
							? `创建「${noteTypeName}」笔记类型？`
							: `预览 · ${config.name}`}
					</h2>
					<p>
						{mode === "install"
							? `当前 Anki 用户缺少这个内置笔记类型。创建后，将把本次笔记发送到「${deckName || "所选卡组"}」。`
							: builtinNoteType
								? `卡片模板预览 · 目标卡组：${deckName || "未选择"}`
								: `待发送字段核对（笔记类型：${noteTypeName}）`}
					</p>
				</div>
				<button
					data-dialog-cancel=""
					type="button"
					className="anki-close-btn"
					aria-label="关闭预览"
					disabled={busy}
					onClick={onClose}
				>
					×
				</button>
			</div>

			<div className="anki-modal-body">
				{frontHtml !== null && backHtml !== null ? (
					<div className="anki-preview-grid">
						<style>{`@scope (.anki-preview-grid) { ${sharedCss} }`}</style>
						<section className="anki-preview-card">
							<header className="anki-preview-card-head">正面预览</header>
							<div
								className={`anki-preview-card-body card${night ? " nightMode" : ""}`}
								// biome-ignore lint/security/noDangerouslySetInnerHtml: builtin template rendered with strictly escaped field values
								dangerouslySetInnerHTML={{ __html: frontHtml }}
							/>
						</section>
						<section className="anki-preview-card">
							<header className="anki-preview-card-head">背面预览</header>
							<div
								className={`anki-preview-card-body card${night ? " nightMode" : ""}`}
								// biome-ignore lint/security/noDangerouslySetInnerHtml: builtin template rendered with strictly escaped field values
								dangerouslySetInnerHTML={{ __html: backHtml }}
							/>
						</section>
					</div>
				) : (
					<div className="anki-field-table">
						{mappedFields.length === 0 ? (
							<div className="anki-field-table-row">
								<span>未映射字段</span>
								<span>当前配置尚无已映射的目标字段。</span>
							</div>
						) : (
							mappedFields.map((field) => {
								const media = draft.media[fieldValueKey(field)];
								const displayValue =
									field.type === "text"
										? getFieldText(draft, field, context) || "（空）"
										: media
											? `${media.name}（${FIELD_TYPE_LABELS[field.type]}）`
											: "（未选择文件）";
								return (
									<div className="anki-field-table-row" key={field.id}>
										<strong>{field.target_field}</strong>
										<span style={{ whiteSpace: "pre-wrap" }}>
											{displayValue}
										</span>
									</div>
								);
							})
						)}
					</div>
				)}
			</div>

			<div className="anki-modal-foot">
				<span style={{ fontSize: 12.5, opacity: 0.72 }}>
					{builtinNoteType
						? `${noteTypeName} · ${builtinNoteType.card_templates.length} 个卡片模板 · ${builtinNoteType.fields.length} 个笔记字段`
						: `目标卡组：${deckName || "未选择"}`}
				</span>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className="anki-btn-secondary"
						disabled={busy}
						onClick={onClose}
					>
						{mode === "install" ? "返回编辑" : "关闭"}
					</button>
					{mode === "install" && onConfirmInstall && (
						<button
							type="button"
							className="anki-btn-primary"
							disabled={busy}
							onClick={onConfirmInstall}
						>
							{busy ? "创建并发送中…" : "创建并发送"}
						</button>
					)}
				</div>
			</div>
		</ConfirmDialog>
	);
}
