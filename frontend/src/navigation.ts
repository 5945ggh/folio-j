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

export type ReturnTarget = {
	to: string;
	label: string;
	parent?: ReturnTarget;
};
export type ReturnDestination = {
	to: string;
	label: string;
	state?: { returnTo: ReturnTarget };
};
const CATALOG_FALLBACK = { to: "/materials", label: "素材库" };
const MAX_RETURN_TARGETS = 4;
const MAX_RETURN_INSPECTIONS = 12;
const CATALOG_ROUTE = /^\/(?:materials|sources(?:\/[A-Za-z0-9_-]+)?)$/;
const DETAILS_ROUTE = /^\/materials\/[A-Za-z0-9_-]+\/details$/;
const LEARNING_ROUTE = /^\/(?:materials|segments)\/[A-Za-z0-9_-]+$/;

function returnValue(value: unknown): {
	target: ReturnTarget;
	pathname: string;
	parent: unknown;
	hasParent: boolean;
} | null {
	if (
		!value ||
		typeof value !== "object" ||
		!("to" in value) ||
		!("label" in value)
	)
		return null;
	const { to, label } = value;
	if (
		typeof to !== "string" ||
		typeof label !== "string" ||
		!label.trim() ||
		/[\s\\]/.test(to)
	)
		return null;
	// Reject traversal before URL normalization can turn it into another allowed route.
	if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(to.split(/[?#]/)[0] ?? ""))
		return null;
	if (!to.startsWith("/") || to.startsWith("//")) return null;
	const url = new URL(to, "https://folio.invalid");
	if (
		url.origin !== "https://folio.invalid" ||
		!/^\/(?:sources(?:\/[A-Za-z0-9_-]+)?|materials(?:\/[A-Za-z0-9_-]+(?:\/details)?)?|segments\/[A-Za-z0-9_-]+|settings)?$/.test(
			url.pathname,
		)
	)
		return null;
	return {
		target: {
			to: `${url.pathname}${url.search}${url.hash}`,
			label: label.trim(),
		},
		pathname: url.pathname,
		parent: "parent" in value ? value.parent : undefined,
		hasParent: "parent" in value,
	};
}

/** Only explicit, validated parent links survive; repeated routes never grow a return loop. */
function returnTrail(
	value: unknown,
	excludedPath?: string,
): ReturnTarget | null {
	const objects = new WeakSet<object>();
	const paths = new Set(
		excludedPath ? [excludedPath.split(/[?#]/)[0] ?? excludedPath] : [],
	);
	let inspections = 0;
	const visit = (
		candidate: unknown,
		remaining: number,
	): ReturnTarget | null => {
		if (
			remaining === 0 ||
			inspections++ >= MAX_RETURN_INSPECTIONS ||
			!candidate ||
			typeof candidate !== "object" ||
			objects.has(candidate)
		)
			return null;
		objects.add(candidate);
		const parsed = returnValue(candidate);
		if (!parsed) return null;
		const { target, pathname, parent, hasParent } = parsed;
		if (paths.has(pathname)) return visit(parent, remaining);
		paths.add(pathname);
		if (remaining === 1) return target;
		if (
			!hasParent ||
			(!DETAILS_ROUTE.test(pathname) && !LEARNING_ROUTE.test(pathname))
		)
			return target;
		const parentValue = returnValue(parent);
		if (DETAILS_ROUTE.test(pathname) && !parentValue)
			return { ...target, parent: CATALOG_FALLBACK };
		if (
			!parentValue ||
			(!CATALOG_ROUTE.test(parentValue.pathname) &&
				!DETAILS_ROUTE.test(parentValue.pathname) &&
				!LEARNING_ROUTE.test(parentValue.pathname))
		)
			return target;
		const cleanParent = visit(parent, remaining - 1);
		// Details have always returned directly to a catalog/source view.
		if (
			cleanParent &&
			(!DETAILS_ROUTE.test(pathname) ||
				CATALOG_ROUTE.test(
					new URL(cleanParent.to, "https://folio.invalid").pathname,
				))
		)
			target.parent = cleanParent;
		return target;
	};
	return visit(value, MAX_RETURN_TARGETS);
}

export function returnDestination(
	state: unknown,
	fallback = { to: "/sources", label: "来源目录" },
): ReturnDestination {
	const target =
		state && typeof state === "object" && "returnTo" in state
			? returnTrail(state.returnTo)
			: null;
	if (!target) return fallback;
	return {
		to: target.to,
		label: target.label,
		...(target.parent ? { state: { returnTo: target.parent } } : {}),
	};
}

/** Compose a bounded return trail from an already resolved parent, excluding the destination page. */
export function returnState(
	destination: Pick<ReturnDestination, "to" | "label">,
	parent?: ReturnDestination,
	destinationPath?: string,
): { returnTo: ReturnTarget } {
	const candidate = {
		...destination,
		...(parent
			? {
					parent: {
						to: parent.to,
						label: parent.label,
						...(parent.state ? { parent: parent.state.returnTo } : {}),
					},
				}
			: {}),
	};
	return {
		returnTo: returnTrail(candidate, destinationPath) ?? CATALOG_FALLBACK,
	};
}
