export function safeHref(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (
		value.startsWith("#") ||
		(value.startsWith("/") && !value.startsWith("//"))
	)
		return value;
	try {
		const url = new URL(value);
		return ["http:", "https:", "mailto:"].includes(url.protocol)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

export function imageHref(value: string | undefined): string | undefined {
	const href = safeHref(value);
	return href && /^https?:\/\//i.test(href) ? href : undefined;
}
