import type { ComponentProps } from "react";
import "./selection-actions.css";

function ToolIcon({
	name,
}: {
	name: "translate" | "speak" | "save" | "copy" | "anki";
}) {
	const path = {
		copy: "M9 8h11v13H9zM5 16H3V3h11v2",
		translate: "m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1m10 20-5-10-5 10M14 18h6",
		speak:
			"M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14",
		save: "M6 4h12v16l-6-4-6 4z",
		anki: "M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm8 3v6m-3-3h6",
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

/** The host measures and positions this toolbar independently of its actions. */
export function SelectionActions({
	className,
	onTranslate,
	onSpeak,
	onLookup,
	lookupLabel,
	onCopy,
	copying = false,
	onSave,
	onAnki,
	saveButtonId,
	...root
}: Pick<ComponentProps<"div">, "className" | "ref" | "style"> & {
	onTranslate?: () => void;
	onSpeak?: () => void;
	onLookup?: () => void;
	lookupLabel?: string;
	onCopy?: () => void;
	copying?: boolean;
	onSave?: () => void;
	onAnki?: () => void;
	saveButtonId?: string;
}) {
	const hasReadingTools = !!(onTranslate || onSpeak || onLookup);
	return (
		<div
			{...root}
			className={
				className ? `selection-actions ${className}` : "selection-actions"
			}
			role="toolbar"
			aria-label="选区操作"
		>
			{hasReadingTools && (
				<div className="selection-action-group">
					{onTranslate && (
						<button
							type="button"
							onPointerDown={(event) => event.preventDefault()}
							onClick={onTranslate}
						>
							<ToolIcon name="translate" />
							翻译
						</button>
					)}
					{onSpeak && (
						<button
							type="button"
							onPointerDown={(event) => event.preventDefault()}
							onClick={onSpeak}
						>
							<ToolIcon name="speak" />
							朗读
						</button>
					)}
					{onLookup && (
						<button
							type="button"
							className="secondary"
							aria-label={lookupLabel}
							onPointerDown={(event) => event.preventDefault()}
							onClick={onLookup}
						>
							查词
						</button>
					)}
				</div>
			)}
			{onCopy && (
				<div className="selection-action-group">
					{hasReadingTools && (
						<span className="selection-action-divider" aria-hidden="true" />
					)}
					<button
						type="button"
						aria-label="带前后文复制"
						aria-busy={copying}
						disabled={copying}
						onPointerDown={(event) => event.preventDefault()}
						onClick={onCopy}
					>
						<ToolIcon name="copy" />
						带前后文复制
					</button>
				</div>
			)}
			{(onSave || onAnki) && (
				<div className="selection-action-group">
					{(hasReadingTools || onCopy) && (
						<span className="selection-action-divider" aria-hidden="true" />
					)}
					{onSave && (
						<button
							id={saveButtonId}
							type="button"
							className="primary"
							aria-label="保存为学习片段"
							data-tooltip="保存为学习片段"
							onPointerDown={(event) => event.preventDefault()}
							onClick={onSave}
						>
							<ToolIcon name="save" />
							保存
						</button>
					)}
					{onAnki && (
						<button
							type="button"
							aria-label="制卡（发送到 Anki）"
							data-tooltip="制卡（发送到 Anki）"
							onPointerDown={(event) => event.preventDefault()}
							onClick={onAnki}
						>
							<ToolIcon name="anki" />
							制卡
						</button>
					)}
				</div>
			)}
		</div>
	);
}
