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

export type ReturnDestination = {
	to: string;
	label: string;
	state?: { returnTo: { to: string; label: string } };
};

export function returnDestination(
	state: unknown,
	fallback = { to: "/sources", label: "来源目录" },
): ReturnDestination {
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
	// Reject path traversal before URL normalization can turn it into another route.
	if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(to.split(/[?#]/)[0] ?? ""))
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
		!/^\/(?:sources(?:\/[A-Za-z0-9_-]+)?|materials(?:\/[A-Za-z0-9_-]+(?:\/details)?)?|segments\/[A-Za-z0-9_-]+|settings)?$/.test(
			url.pathname,
		)
	)
		return fallback;
	const result: ReturnDestination = {
		to: `${url.pathname}${url.search}${url.hash}`,
		label: label.trim(),
	};
	// A Reader can return to details with its original catalog destination.
	// Only one validated parent is carried; arbitrary nested state is discarded.
	if (
		/^\/materials\/[A-Za-z0-9_-]+\/details$/.test(url.pathname) &&
		"parent" in target
	) {
		const candidate = target.parent;
		const parent = returnDestination(
			{
				returnTo:
					candidate &&
					typeof candidate === "object" &&
					"to" in candidate &&
					"label" in candidate
						? { to: candidate.to, label: candidate.label }
						: null,
			},
			{ to: "/materials", label: "素材库" },
		);
		if (
			/^\/(?:materials|sources(?:\/[A-Za-z0-9_-]+)?)$/.test(
				new URL(parent.to, "https://folio.invalid").pathname,
			)
		)
			result.state = { returnTo: { to: parent.to, label: parent.label } };
	}
	return result;
}
