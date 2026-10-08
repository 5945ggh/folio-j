import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOOK_UI, ReaderPreferenceRequests } from "./preferences.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
for (const outcome of ["resolve", "reject"] as const) {
	test(`a pending all-range ${outcome} cannot overwrite a later default reset or its storage`, async () => {
		const requests = new ReaderPreferenceRequests();
		const pending = deferred();
		const oldTicket = requests.begin();
		const current = {
			...DEFAULT_BOOK_UI,
			font: "gothic" as const,
			width: 1040,
			rubyScope: "all" as const,
		};
		let persisted = JSON.stringify(current);
		let error: string | null = "old error";
		let busy = true;
		const done = pending.promise
			.then(
				() => {
					if (requests.accepts(oldTicket)) persisted = JSON.stringify(current);
				},
				(failure: Error) => {
					if (requests.accepts(oldTicket)) error = failure.message;
				},
			)
			.finally(() => {
				if (requests.accepts(oldTicket)) busy = false;
			});
		// Reset uses the same synchronous new-intent path as any preference click.
		const resetTicket = requests.begin();
		persisted = JSON.stringify(DEFAULT_BOOK_UI);
		error = null;
		busy = false;
		if (outcome === "resolve") pending.resolve();
		else pending.reject(new Error("late failure"));
		await done;
		assert.equal(requests.accepts(oldTicket), false);
		assert.equal(requests.accepts(resetTicket), true);
		assert.deepEqual(JSON.parse(persisted), DEFAULT_BOOK_UI);
		assert.equal(error, null);
		assert.equal(busy, false);
	});
}
