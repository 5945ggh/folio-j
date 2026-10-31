import type { BookmarkCreate } from "./bookmarks-api.ts";

/** An unanswered write blocks new captures; a nearby response is a separate, replaceable choice. */
export class BookmarkCreationIntent {
	request: BookmarkCreate | null = null;
	nearby = false;
	get canRetry(): boolean {
		return this.request !== null && !this.nearby;
	}
	start(request: BookmarkCreate): boolean {
		if (this.canRetry) return false;
		this.request = request;
		this.nearby = false;
		return true;
	}
	isCurrent(request: BookmarkCreate): boolean {
		return (
			this.request?.request_id === request.request_id &&
			this.request.allow_nearby === request.allow_nearby
		);
	}
	offerNearby(): void {
		this.nearby = true;
	}
	force(): BookmarkCreate | null {
		if (!this.request || !this.nearby) return null;
		this.request = { ...this.request, allow_nearby: true };
		this.nearby = false;
		return this.request;
	}
	clear(): void {
		this.request = null;
		this.nearby = false;
	}
}
