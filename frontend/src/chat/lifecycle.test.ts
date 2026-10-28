import assert from "node:assert/strict";
import test from "node:test";
import { readSegmentLocation } from "../navigation.ts";
import { shouldMountWorkbench } from "./lifecycle.ts";

test("plain and exact-revision reading do not activate a workbench", () => {
	for (const search of [
		"",
		"?analysis=a",
		"?analysis=a&revision=old",
		"?chat=0&thread=t&analysis=a",
	]) {
		assert.equal(
			shouldMountWorkbench(false, readSegmentLocation(search).chatOpen, null),
			false,
		);
	}
});

test("opening discussion and a visible direct thread activate the workbench", () => {
	for (const search of ["?chat=1", "?thread=t", "?thread=t&chat=1"])
		assert.equal(
			shouldMountWorkbench(false, readSegmentLocation(search).chatOpen, null),
			true,
		);
});

test("explanation shortcut activates before its URL update, then hiding preserves the mounted session", () => {
	let active = shouldMountWorkbench(false, false, "generation-request");
	assert.equal(active, true);
	for (const search of [
		"?thread=t&chat=1",
		"?thread=t&chat=0",
		"?analysis=a&chat=0",
		"?chat=1",
		"?chat=0",
	]) {
		active = shouldMountWorkbench(
			active,
			readSegmentLocation(search).chatOpen,
			null,
		);
		assert.equal(active, true);
	}
});
