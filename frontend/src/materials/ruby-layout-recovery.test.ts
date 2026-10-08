import assert from "node:assert/strict";
import test from "node:test";
import { ViewportRecovery } from "./viewport.ts";

test("successive reset layout submissions restore sampling even when settings and viewport size are identical", () => {
	const recovery = new ViewportRecovery();
	const size = { width: 760, height: 800 };
	const first = recovery.begin(size);
	assert.equal(recovery.finish(first, size), true);
	for (let reset = 0; reset < 2; reset++) {
		recovery.invalidate();
		assert.equal(recovery.canSample(size), false);
		const submittedLayout = recovery.begin(size);
		assert.equal(recovery.finish(submittedLayout, size), true);
		assert.equal(recovery.canSample(size), true);
	}
});
test("late readings mount establishes a viewport baseline and the following resize remains recoverable", () => {
	const recovery = new ViewportRecovery();
	const initial = { width: 760, height: 800 };
	// No viewport exists while the initial all-range assets are pending.
	assert.equal(recovery.canSample(initial), false);
	const mounted = recovery.begin(initial);
	assert.equal(recovery.finish(mounted, initial), true);
	const resized = { width: 640, height: 800 };
	assert.equal(
		recovery.observe(resized, () => 42),
		null,
	);
	const pass = recovery.begin(resized);
	assert.equal(recovery.finish(pass, resized), true);
	assert.equal(
		recovery.observe(resized, () => 42),
		42,
	);
});
