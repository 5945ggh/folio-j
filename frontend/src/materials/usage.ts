/** One action belongs to one reader mount; retries reuse its identity and revision. */
export class OpenAction {
	readonly id: string;
	private promise: Promise<void> | null = null;
	private revision: number | null = null;
	private completed = false;
	constructor(id: string) {
		this.id = id;
	}
	run(
		revision: number,
		send: (id: string, revision: number) => Promise<void>,
	): Promise<void> {
		if (this.completed) return Promise.resolve();
		if (this.promise) return this.promise;
		this.revision ??= revision;
		this.promise = send(this.id, this.revision)
			.then(() => {
				this.completed = true;
			})
			.finally(() => {
				this.promise = null;
			});
		return this.promise;
	}
}
export function freshestUsage<T extends { revision: number }>(
	previous: T | undefined,
	fresh: T,
): T {
	return previous && previous.revision > fresh.revision ? previous : fresh;
}
