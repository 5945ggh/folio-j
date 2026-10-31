// A group writes one snapshot at a time. While it saves, retain only the latest commit.
export function createAutosaveQueue<T extends object>(
	write: (value: T) => Promise<void>,
) {
	let queued: T | undefined;
	let running: Promise<void> | undefined;
	async function flush() {
		try {
			while (queued) {
				const next = queued;
				queued = undefined;
				await write(next);
			}
		} finally {
			queued = undefined;
			running = undefined;
		}
	}
	return (value: T) => {
		queued = value;
		running ??= Promise.resolve().then(flush);
		return running;
	};
}
