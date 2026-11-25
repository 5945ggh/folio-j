import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";
import type { AnkiFieldDefinition } from "./api";
import { type AnkiMediaDraft, mediaExtensions } from "./draft";
export function MediaFieldControl({
	field,
	media,
	onSelect,
	onRemove,
}: {
	field: AnkiFieldDefinition;
	media: AnkiMediaDraft | undefined;
	onSelect: (file: File) => void;
	onRemove: () => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragOver, setDragOver] = useState(false);
	const accept =
		field.type === "text" ? undefined : mediaExtensions[field.type].join(",");

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		setDragOver(false);
		const file = event.dataTransfer.files[0];
		if (file) onSelect(file);
	};

	const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
		if (field.type !== "image") return;
		const items = Array.from(event.clipboardData.items);
		const imageItem = items.find((item) => item.type.startsWith("image/"));
		const file = imageItem?.getAsFile();
		if (file) {
			event.preventDefault();
			const ext = file.type.split("/")[1] || "png";
			const named =
				file.name && file.name !== "image.png"
					? file
					: new File([file], `pasted-${Date.now()}.${ext}`, {
							type: file.type,
						});
			onSelect(named);
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: supports file drag-drop and clipboard image paste
		<div
			className="anki-media-drop"
			data-dragover={dragOver || undefined}
			onDragOver={(event) => {
				event.preventDefault();
				setDragOver(true);
			}}
			onDragLeave={() => setDragOver(false)}
			onDrop={handleDrop}
			onPaste={handlePaste}
		>
			<input
				ref={inputRef}
				type="file"
				accept={accept}
				hidden
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) onSelect(file);
					event.target.value = "";
				}}
			/>
			<div className="anki-media-row">
				<button
					type="button"
					className="anki-btn-secondary"
					style={{ padding: "4px 10px", fontSize: 12 }}
					onClick={() => inputRef.current?.click()}
				>
					{media ? "替换文件" : "选择文件…"}
				</button>
				{media ? (
					<>
						<span className="anki-media-filename" title={media.name}>
							{media.name}
						</span>
						<button type="button" className="anki-link-btn" onClick={onRemove}>
							移除
						</button>
					</>
				) : (
					<span className="anki-media-placeholder">
						{field.type === "image"
							? "可拖入文件，或在此粘贴截图"
							: "未选择文件，可拖入或点击左侧按钮选择"}
					</span>
				)}
			</div>
			{media?.previewUrl && field.type === "image" && (
				<img
					className="anki-media-thumb"
					src={media.previewUrl}
					alt={media.name}
				/>
			)}
			{media?.previewUrl && field.type === "audio" && (
				// biome-ignore lint/a11y/useMediaCaption: local user-selected audio preview
				<audio className="anki-media-audio" controls src={media.previewUrl} />
			)}
		</div>
	);
}
