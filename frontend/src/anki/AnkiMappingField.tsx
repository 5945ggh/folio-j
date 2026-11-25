import { NativeSelect } from "../NativeSelect";
import type { AnkiFieldDefinition } from "./api";
export const FIELD_TYPE_LABELS: Record<AnkiFieldDefinition["type"], string> = {
	text: "文字",
	audio: "音频",
	image: "图片",
	video: "视频",
};

export const FIELD_SOURCE_LABELS: Record<
	AnkiFieldDefinition["source"],
	string
> = {
	selection: "自动填入（选区）",
	sentence: "自动填入（原句）",
	sourceMetadata: "自动填入（出处）",
	manual: "手动填写",
};

export const PRESENTATION_LABELS: Record<
	AnkiFieldDefinition["presentation"],
	string
> = {
	common: "常用",
	summary: "单行摘要",
	more: "靠后显示",
};

export function AnkiMappingField({
	field,
	first,
	last,
	issue,
	expanded,
	knownTargetFields,
	unverifiedTargetLabel,
	onMove,
	onToggle,
	onChange,
	onRemove,
}: {
	field: AnkiFieldDefinition;
	first: boolean;
	last: boolean;
	issue?: string;
	expanded: boolean;
	knownTargetFields: string[] | null;
	unverifiedTargetLabel: string;
	onMove: (direction: -1 | 1) => void;
	onToggle: () => void;
	onChange: (patch: Partial<AnkiFieldDefinition>) => void;
	onRemove: () => void;
}) {
	const savedTarget = field.target_field ?? "";
	const targetMissingFromKnown =
		Boolean(savedTarget) &&
		knownTargetFields !== null &&
		!knownTargetFields.includes(savedTarget);
	const targetUnverified = Boolean(savedTarget) && knownTargetFields === null;
	return (
		<div className="anki-mapping-item">
			<div className="anki-mapping-row">
				<div>
					<div className="anki-mapping-label">
						<span>{field.label || "（未命名）"}</span>
						<span className="anki-badge" data-tone="muted">
							{FIELD_TYPE_LABELS[field.type]}
						</span>
					</div>
					<div className="anki-mapping-meta">
						<span>{PRESENTATION_LABELS[field.presentation]}</span>
						{field.source !== "manual" && (
							<span>· {FIELD_SOURCE_LABELS[field.source]}</span>
						)}
						{field.required && (
							<span className="anki-mapping-required">· 必填</span>
						)}
					</div>
				</div>

				<span className="anki-mapping-arrow" aria-hidden="true">
					→
				</span>

				<NativeSelect
					wrapperClassName="anki-select-wrap"
					aria-label={`${field.label || "未命名字段"} 对应的 Anki 字段`}
					value={savedTarget}
					onChange={(event) =>
						onChange({
							target_field: event.target.value || null,
						})
					}
				>
					<option value="">未映射</option>
					{(targetMissingFromKnown || targetUnverified) && (
						<option value={savedTarget}>
							{savedTarget}
							{targetMissingFromKnown
								? "（所选笔记类型中没有此字段）"
								: unverifiedTargetLabel}
						</option>
					)}
					{knownTargetFields?.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</NativeSelect>

				<div className="anki-mapping-controls">
					<button
						type="button"
						className="anki-icon-btn"
						aria-label={`上移 ${field.label}`}
						title="上移"
						disabled={first}
						onClick={() => onMove(-1)}
					>
						↑
					</button>
					<button
						type="button"
						className="anki-icon-btn"
						aria-label={`下移 ${field.label}`}
						title="下移"
						disabled={last}
						onClick={() => onMove(1)}
					>
						↓
					</button>
					<button
						type="button"
						className="anki-text-action"
						aria-expanded={expanded}
						onClick={onToggle}
					>
						{expanded ? "收起" : "设置"}
					</button>
				</div>
			</div>

			{issue && (
				<p className="anki-mapping-issue" role="alert">
					{issue}
				</p>
			)}

			{expanded && (
				<div className="anki-mapping-drawer">
					<div className="anki-field-group">
						<label htmlFor={`field-label-${field.id}`}>显示名称</label>
						<input
							id={`field-label-${field.id}`}
							type="text"
							value={field.label}
							onChange={(event) => onChange({ label: event.target.value })}
						/>
					</div>

					<div className="anki-field-group">
						<label htmlFor={`field-type-${field.id}`}>字段类型</label>
						<NativeSelect
							id={`field-type-${field.id}`}
							wrapperClassName="anki-select-wrap"
							disabled={field.source !== "manual"}
							value={field.type}
							onChange={(event) => {
								const nextType = event.target
									.value as AnkiFieldDefinition["type"];
								onChange({
									type: nextType,
									multiline: nextType === "text" ? field.multiline : false,
								});
							}}
						>
							<option value="text">文字</option>
							<option value="audio">音频</option>
							<option value="image">图片</option>
							<option value="video">视频</option>
						</NativeSelect>
					</div>

					<div className="anki-field-group">
						<label htmlFor={`field-pres-${field.id}`}>显示方式</label>
						<NativeSelect
							id={`field-pres-${field.id}`}
							wrapperClassName="anki-select-wrap"
							value={field.presentation}
							onChange={(event) =>
								onChange({
									presentation: event.target
										.value as AnkiFieldDefinition["presentation"],
								})
							}
						>
							<option value="common">常用</option>
							<option value="summary">单行摘要</option>
							<option value="more">靠后显示</option>
						</NativeSelect>
					</div>

					{field.type === "text" && (
						<div className="anki-field-group">
							<label htmlFor={`field-lines-${field.id}`}>文字输入</label>
							<NativeSelect
								id={`field-lines-${field.id}`}
								wrapperClassName="anki-select-wrap"
								value={field.multiline ? "multiline" : "single"}
								onChange={(event) =>
									onChange({
										multiline: event.target.value === "multiline",
									})
								}
							>
								<option value="single">单行</option>
								<option value="multiline">多行</option>
							</NativeSelect>
						</div>
					)}

					<div className="anki-field-group">
						<label className="anki-checkbox-line">
							<input
								type="checkbox"
								checked={field.required}
								onChange={(event) =>
									onChange({
										required: event.target.checked,
									})
								}
							/>
							<span>发送时必填</span>
						</label>
					</div>

					<div className="anki-drawer-foot">
						<span>
							{field.source === "manual"
								? "手动填写字段，可自由改名、调整类型或删除。"
								: "该字段会自动填入，不需要时可保留为未映射。"}
						</span>
						{field.source === "manual" && (
							<button
								type="button"
								className="anki-text-action"
								data-tone="danger"
								onClick={onRemove}
							>
								删除该字段
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
