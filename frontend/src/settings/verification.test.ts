import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capabilityPresentation,
	isActiveVerification,
	undiscoveredRegistrations,
	type VerificationState,
} from "./verification.ts";

test("discovery excludes registered IDs and duplicate remote entries", () => {
	assert.deepEqual(
		undiscoveredRegistrations(["a", "b", "a", "c"], [{ model_id: "b" }]),
		["a", "c"],
	);
});

test("interrupted and failed have distinct nonempty labels and icons", () => {
	const interrupted = capabilityPresentation("interrupted");
	const failed = capabilityPresentation("failed");
	for (const field of ["icon", "label"] as const) {
		assert.ok(interrupted[field].trim());
		assert.ok(failed[field].trim());
		assert.notEqual(interrupted[field], failed[field]);
	}
});

test("the complete verification state set has only queued and running active", () => {
	const expected = {
		unknown: false,
		queued: true,
		running: true,
		succeeded: false,
		failed: false,
		interrupted: false,
		cancelled: false,
	} satisfies Record<VerificationState, boolean>;
	for (const [state, active] of Object.entries(expected)) {
		assert.equal(
			isActiveVerification(state as VerificationState),
			active,
			state,
		);
	}
});
