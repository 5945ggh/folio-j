type Color = [number, number, number, number];

/** Resolve browser computed colors, including color-mix(), through the canvas parser. */
export function color(value: string): Color {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context)
		throw new Error("Canvas unavailable for computed color parsing");
	context.fillStyle = value;
	context.fillRect(0, 0, 1, 1);
	const pixel = context.getImageData(0, 0, 1, 1).data;
	return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, (pixel[3] ?? 0) / 255];
}
export function over(front: Color, back: Color): Color {
	const alpha = front[3] + back[3] * (1 - front[3]);
	if (!alpha) return [0, 0, 0, 0];
	return [0, 1, 2]
		.map(
			(i) =>
				((front[i] ?? 0) * front[3] +
					(back[i] ?? 0) * back[3] * (1 - front[3])) /
				alpha,
		)
		.concat(alpha) as Color;
}
export function computed(node: Element) {
	const view = node.ownerDocument.defaultView;
	if (!view) throw new Error("Detached color sample");
	return view.getComputedStyle(node);
}
export function background(node: Element | null): Color {
	if (!node) return [255, 255, 255, 1];
	const style = computed(node);
	// A gradient/image cannot be inferred from background-color. Require the real
	// presentation layer to remove author paint before measuring text contrast.
	if (style.backgroundImage !== "none")
		throw new Error(
			`${node.tagName}.${node.className}: unexpected painted background ${style.backgroundImage}`,
		);
	return over(color(style.backgroundColor), background(node.parentElement));
}
export function luminance(value: Color) {
	const linear = value.slice(0, 3).map((n) => {
		const v = n / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return (
		(linear[0] ?? 0) * 0.2126 +
		(linear[1] ?? 0) * 0.7152 +
		(linear[2] ?? 0) * 0.0722
	);
}
