import assert from "node:assert/strict";
import test from "node:test";
import { readerSessionRoute } from "./reader-session-route.ts";

for (const suffix of ["", "/"]) {
	test(`classifies reader and segment routes with suffix "${suffix}"`, () => {
		assert.deepEqual(readerSessionRoute(`/materials/book${suffix}`), {
			kind: "reader",
			materialId: "book",
		});
		assert.deepEqual(readerSessionRoute(`/segments/saved${suffix}`), {
			kind: "segment",
			segmentId: "saved",
		});
	});
}

test("uses Router parameter decoding and case-insensitive page matching", () => {
	assert.deepEqual(readerSessionRoute("/MATERIALS/book%20one/"), {
		kind: "reader",
		materialId: "book one",
	});
	assert.deepEqual(readerSessionRoute("/SEGMENTS/saved/"), {
		kind: "segment",
		segmentId: "saved",
	});
});

test("unrelated pages and incomplete or nested paths do not retain a reader", () => {
	for (const pathname of [
		"/",
		"/materials",
		"/materials/",
		"/materials/book/details",
		"/segments",
		"/segments/",
		"/segments/saved/extra",
		"/sources/source",
		"/settings",
	]) {
		assert.equal(readerSessionRoute(pathname), null, pathname);
	}
});
