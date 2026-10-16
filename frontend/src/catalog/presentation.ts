export function cardWidth(value: string): number {
	const width = Number(value);
	return Number.isFinite(width) && width >= 140 && width <= 280 ? width : 216;
}
export function bookListState(
	total: number,
	count: number,
	filtered: boolean,
	page: number,
) {
	if (filtered && total === 0) return "no-results";
	if (total === 0) return "empty";
	if (count === 0 || page > Math.max(1, Math.ceil(total / 50)))
		return "out-of-page";
	return "books";
}

export function sourceListState(
	total: number | undefined,
	count: number,
	search: string,
) {
	if (total === undefined) return "loading";
	if (total === 0) return search ? "no-results" : "empty";
	return count === 0 ? "out-of-page" : "items";
}
