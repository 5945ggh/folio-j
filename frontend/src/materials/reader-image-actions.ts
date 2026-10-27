import type { ReaderImageCache } from "./reader-image-cache";

async function pngBlob(
	cache: ReaderImageCache,
	url: string,
	signal: AbortSignal,
): Promise<Blob> {
	const blob = await cache.get(url, signal);
	signal.throwIfAborted();
	if (blob.type === "image/png") return blob;
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement("canvas");
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("无法转换图片");
		context.drawImage(bitmap, 0, 0);
		const result = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(result) =>
					result ? resolve(result) : reject(new Error("无法转换图片")),
				"image/png",
			),
		);
		signal.throwIfAborted();
		return result;
	} finally {
		bitmap.close();
	}
}

export async function copyReaderImage(
	cache: ReaderImageCache,
	url: string,
	signal: AbortSignal,
): Promise<void> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
		throw new Error("当前浏览器不支持复制图片");
	await navigator.clipboard.write([
		new ClipboardItem({ "image/png": pngBlob(cache, url, signal) }),
	]);
}

export async function downloadReaderImage(
	cache: ReaderImageCache,
	url: string,
	ordinal: number | null,
	signal: AbortSignal,
): Promise<void> {
	const blob = await cache.get(url, signal);
	signal.throwIfAborted();
	const extension: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
	};
	const objectUrl = URL.createObjectURL(blob);
	try {
		const link = document.createElement("a");
		link.href = objectUrl;
		link.download = `插图${ordinal === null ? "" : `-${ordinal + 1}`}.${extension[blob.type] ?? "image"}`;
		link.click();
	} finally {
		window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
	}
}
