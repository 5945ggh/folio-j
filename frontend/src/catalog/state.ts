export type CatalogKind = "books" | "sources" | "segments" | "analyses";
export const sortFields = {
	books: ["title", "created_at", "last_opened_at"],
	sources: ["title", "created_at", "updated_at"],
	segments: ["created_at", "updated_at"],
	analyses: ["title", "created_at", "updated_at"],
} as const;
export type CatalogSort =
	| "title"
	| "created_at"
	| "updated_at"
	| "last_opened_at";
export type CatalogState = {
	q: string;
	source_id: string;
	status: "" | "not_started" | "in_progress" | "completed";
	sort: CatalogSort;
	order: "asc" | "desc";
	page: number;
};
export function readCatalogState(
	search: string,
	kind: CatalogKind,
	preference = "",
	prefix = "",
): CatalogState {
	const params = new URLSearchParams(search);
	const saved = new URLSearchParams(preference);
	const defaults =
		kind === "segments"
			? { sort: "created_at", order: "desc" }
			: { sort: "title", order: "asc" };
	const sort =
		params.get(`${prefix}sort`) ?? saved.get("sort") ?? defaults.sort;
	const order =
		params.get(`${prefix}order`) ?? saved.get("order") ?? defaults.order;
	const status = params.get(`${prefix}status`);
	const page = Number(params.get(`${prefix}page`) ?? "1");
	return {
		q: params.get(`${prefix}q`) ?? "",
		source_id: params.get(`${prefix}source`) ?? "",
		status:
			status === "not_started" ||
			status === "in_progress" ||
			status === "completed"
				? status
				: "",
		sort: (sortFields[kind] as readonly string[]).includes(sort)
			? (sort as CatalogSort)
			: (defaults.sort as CatalogSort),
		order: order === "desc" ? "desc" : "asc",
		page: Number.isSafeInteger(page) && page > 0 ? page : 1,
	};
}
export function updateCatalogSearch(
	search: string,
	patch: Partial<CatalogState>,
	prefix = "",
): string {
	const params = new URLSearchParams(search);
	for (const [key, value] of Object.entries(patch)) {
		const name = `${prefix}${key === "source_id" ? "source" : key}`;
		if (value === "" || (key === "page" && value === 1)) params.delete(name);
		else params.set(name, String(value));
	}
	if (!("page" in patch)) params.delete(`${prefix}page`);
	return params.toString();
}
export function lastCatalogPage(total: number, pageSize = 50): number {
	return Math.max(1, Math.ceil(total / pageSize));
}
export function analysisDestination(item: {
	segment_id: string;
	id: string;
	current_revision_id: string;
}): string {
	const params = new URLSearchParams({
		analysis: item.id,
		revision: item.current_revision_id,
	});
	return `/segments/${encodeURIComponent(item.segment_id)}?${params}`;
}
export type SourceView = "overview" | "materials" | "segments" | "analyses";
export function sourceView(search: string, _legacyPreference = ""): SourceView {
	const params = new URLSearchParams(search);
	const view = params.get("view");
	if (
		view === "overview" ||
		view === "materials" ||
		view === "segments" ||
		view === "analyses"
	)
		return view;
	return !view && params.get("expanded") === "book" ? "materials" : "overview";
}

export function sourceOverviewDestination(id: string, search = ""): string {
	const params = new URLSearchParams(sourceListSearch(search, "s", "s"));
	params.set("view", "overview");
	return `/sources/${encodeURIComponent(id)}?${params}`;
}

export function sourceListSearch(
	search: string,
	fromPrefix: string,
	toPrefix: string,
): string {
	const current = new URLSearchParams(search);
	const next = new URLSearchParams();
	for (const key of ["q", "sort", "order", "page"]) {
		const value = current.get(`${fromPrefix}${key}`);
		if (value) next.set(`${toPrefix}${key}`, value);
	}
	const query = next.toString();
	return query ? `?${query}` : "";
}

export function catalogScrollSearch(search: string): string {
	const params = new URLSearchParams(search);
	for (const key of ["sq", "ssort", "sorder", "spage"]) params.delete(key);
	params.sort();
	return params.toString();
}

// The former standalone source directory used unprefixed list parameters.
export function sourceEntrySearch(search: string): string {
	const current = new URLSearchParams(search);
	const params = new URLSearchParams(sourceListSearch(search, "", "s"));
	for (const key of ["sq", "ssort", "sorder", "spage"]) {
		if (!current.has(key)) continue;
		const value = current.get(key);
		if (value) params.set(key, value);
		else params.delete(key);
	}
	return params.toString();
}
