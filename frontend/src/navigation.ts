export type SegmentLocation = {
	analysisId: string | null;
	revisionId: string | null;
	threadId: string | null;
	chatOpen: boolean;
};

export function readSegmentLocation(search: string): SegmentLocation {
	const params = new URLSearchParams(search);
	const analysisId = params.get("analysis") || null;
	const threadId = params.get("thread") || null;
	return {
		analysisId,
		revisionId: analysisId ? params.get("revision") || null : null,
		threadId,
		chatOpen:
			params.get("chat") === "0"
				? false
				: params.get("chat") === "1" || Boolean(threadId),
	};
}

export function updateSegmentLocation(
	search: string,
	patch: Partial<SegmentLocation>,
): string {
	const params = new URLSearchParams(search);
	if (patch.analysisId !== undefined) {
		if (patch.analysisId) params.set("analysis", patch.analysisId);
		else params.delete("analysis");
		params.delete("revision");
	}
	if (patch.revisionId !== undefined) {
		if (patch.revisionId && params.get("analysis"))
			params.set("revision", patch.revisionId);
		else params.delete("revision");
	}
	if (!params.get("analysis")) params.delete("revision");
	if (patch.threadId !== undefined) {
		if (patch.threadId) params.set("thread", patch.threadId);
		else params.delete("thread");
	}
	if (patch.chatOpen !== undefined)
		params.set("chat", patch.chatOpen ? "1" : "0");
	const query = params.toString();
	return query ? `?${query}` : "";
}

export function returnDestination(
	state: unknown,
	fallback = { to: "/sources", label: "来源目录" },
): {
	to: string;
	label: string;
} {
	if (!state || typeof state !== "object" || !("returnTo" in state))
		return fallback;
	const target = state.returnTo;
	if (
		!target ||
		typeof target !== "object" ||
		!("to" in target) ||
		!("label" in target)
	)
		return fallback;
	const { to, label } = target;
	if (
		typeof to !== "string" ||
		typeof label !== "string" ||
		!label.trim() ||
		/[\s\\]/.test(to)
	)
		return fallback;
	// Only known local application routes can be recorded as a return destination.
	if (!to.startsWith("/") || to.startsWith("//")) return fallback;
	const url = new URL(to, "https://folio.invalid");
	if (
		url.origin !== "https://folio.invalid" ||
		!to.startsWith("/") ||
		to.startsWith("//")
	)
		return fallback;
	if (
		!/^\/(?:sources(?:\/[A-Za-z0-9_-]+)?|materials(?:\/[A-Za-z0-9_-]+)?|segments\/[A-Za-z0-9_-]+|settings)?$/.test(
			url.pathname,
		)
	)
		return fallback;
	return { to: `${url.pathname}${url.search}${url.hash}`, label: label.trim() };
}
