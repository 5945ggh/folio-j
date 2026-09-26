import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capabilityPresentation,
	isActiveVerification,
	undiscoveredRegistrations,
} from "./verification.ts";

test("discovery excludes registered IDs and duplicate remote entries", () => {
	assert.deepEqual(
		undiscoveredRegistrations(["a", "b", "a", "c"], [{ model_id: "b" }]),
		["a", "c"],
	);
});

test("interrupted is distinct from failed, and active states are only queued/running", () => {
	assert.equal(capabilityPresentation("interrupted").label, "验证中断");
	assert.equal(capabilityPresentation("failed").label, "验证失败");
	assert.equal(isActiveVerification("queued"), true);
	assert.equal(isActiveVerification("running"), true);
	assert.equal(isActiveVerification("interrupted"), false);
});
