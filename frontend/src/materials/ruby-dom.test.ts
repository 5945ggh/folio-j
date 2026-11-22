import assert from "node:assert/strict";
import test from "node:test";
import type { ReadingsToken } from "./api";
import { projectPart } from "./dom.ts";
import { applyAutomaticRuby, rubyBoundaries } from "./ruby.ts";
import { harness, type TextNode } from "./ruby-test-dom.ts";

function token(start: number, surface: string, reading: string): ReadingsToken {
	return {
		start,
		end: start + Array.from(surface).length,
		surface,
		reading,
		dictionary_form: surface,
		normalized_form: surface,
		pos: [],
		is_oov: false,
	};
}
test("decorating rebuilds live Text projection and excludes rt without changing Unicode offsets", () => {
	const h = harness(["𠮷食べる今日"]);
	const original = projectPart(h.doc, "𠮷食べる今日", 0);
	applyAutomaticRuby(
		h.doc,
		original,
		[token(1, "食べる", "タベル"), token(4, "今日", "キョウ")],
		0,
	);
	const fresh = projectPart(h.doc, original.raw, 0);
	assert.equal(fresh.raw, original.raw);
	assert.equal(h.leaves[0]?.textContent, "𠮷食たべる今日きょう");
	assert.ok(
		fresh.entries.every((entry) => !entry.node.parentElement?.closest("rt")),
	);
	assert.equal(fresh.entries.length, 5);
});
test("whole token original ruby overlap and cross-format tokens remain untouched", () => {
	const h = harness(["食", "べる今日"], 0);
	const projection = projectPart(h.doc, "食べる今日", 0);
	applyAutomaticRuby(h.doc, projection, [token(0, "食べる", "タベル")], 0);
	assert.deepEqual(
		h.leaves.map((leaf) => leaf.textContent),
		["食", "べる今日"],
	);
	const cross = harness(["今", "日"]);
	applyAutomaticRuby(
		cross.doc,
		projectPart(cross.doc, "今日", 0),
		[token(0, "今日", "キョウ")],
		0,
	);
	assert.deepEqual(
		cross.leaves.map((leaf) => leaf.textContent),
		["今", "日"],
	);
});

test("trimmed ruby uses the kanji boundaries with nonzero part offsets and decomposed kana", () => {
	const raw = "𠮷まな板の上、お早う。か\u3099向く";
	const normalized = raw.normalize("NFC");
	const partStart = 37;
	const h = harness([raw]);
	const tokens = [
		["まな板", "マナイタ"],
		["お早う", "オハヨウ"],
		["が向く", "ガムク"],
	].map(([surface, reading]) => {
		assert.ok(surface && reading);
		return token(
			partStart +
				Array.from(normalized.slice(0, normalized.indexOf(surface))).length,
			surface,
			reading,
		);
	});
	const created = applyAutomaticRuby(
		h.doc,
		projectPart(h.doc, normalized, 0),
		tokens,
		partStart,
	);
	assert.equal(created.length, 6);
	assert.deepEqual(
		h.leaves[0]?.children.map((ruby) => ({
			base: (ruby.childNodes[0] as TextNode).data,
			reading: ruby.children[0]?.textContent,
		})),
		[
			{ base: "板", reading: "いた" },
			{ base: "早", reading: "はよ" },
			{ base: "向", reading: "む" },
		],
	);
	assert.equal(projectPart(h.doc, normalized, 0).raw, raw);
});

test("trimming kana preserves whole-token original ruby, formatting and text checks", () => {
	for (const originalIndex of [-1, 0]) {
		const h = harness(["まな", "板"], originalIndex);
		const created = applyAutomaticRuby(
			h.doc,
			projectPart(h.doc, "まな板", 0),
			[token(0, "まな板", "マナイタ")],
			0,
		);
		assert.equal(created.length, 0);
		assert.deepEqual(
			h.leaves.map((leaf) => leaf.textContent),
			["まな", "板"],
		);
	}
	const mismatch = harness(["もな板"]);
	assert.equal(
		applyAutomaticRuby(
			mismatch.doc,
			projectPart(mismatch.doc, "もな板", 0),
			[token(0, "まな板", "マナイタ")],
			0,
		).length,
		0,
	);
});
test("NFC boundary table handles decomposed Japanese, astral code points and a large chapter", () => {
	assert.deepEqual(rubyBoundaries("𠮷か\u3099く"), [0, 2, 4, 5]);
	const raw = "食べる今日𠮷".repeat(2000);
	const boundaries = rubyBoundaries(raw);
	assert.equal(boundaries.length, Array.from(raw).length + 1);
	assert.equal(boundaries.at(-1), raw.length);
});
test("a twelve-thousand-character chapter preserves its text and decorates every token", () => {
	const raw = "食べる".repeat(4000);
	const h = harness([raw]);
	const tokens = Array.from({ length: 4000 }, (_, index) =>
		token(index * 3, "食べる", "タベル"),
	);
	applyAutomaticRuby(h.doc, projectPart(h.doc, raw, 0), tokens, 0);
	assert.equal(projectPart(h.doc, raw, 0).raw, raw);
	assert.equal(h.leaves[0]?.children.length, 4000);
});
