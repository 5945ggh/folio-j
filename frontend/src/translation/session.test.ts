import assert from "node:assert/strict";
import test from "node:test";
import type { StudyTarget } from "../materials/study-api.ts";
import type {
	TranslationInput,
	TranslationResult,
	TranslationSettings,
	TranslationTask,
} from "./api.ts";
import {
	createTranslationSessions,
	type TranslationHistory,
	type TranslationQueryAdapter,
} from "./session.ts";
import { translationTargetKey } from "./state.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function target(spine = 0): StudyTarget {
	return {
		reference: {
			contract_version: "1",
			material_id: "book",
			version_id: "version",
			ranges: [
				{
					resource_id: "r",
					spine_index: spine,
					start: 3,
					end: 6,
					exact: "猫だ。",
					text_sha256: "hash",
					prefix: "",
					suffix: "",
				},
			],
		},
		chapter: {
			id: "chapter",
			material_id: "book",
			version_id: "version",
			title: "章",
			level: 0,
			resources: [
				{
					id: "r",
					text: "前文。猫だ。後文。",
					text_sha256: "hash",
					href: "r.xhtml",
					css: "",
					body_attributes: {},
					html_attributes: {},
				},
			],
			parts: [
				{
					resource_id: "r",
					spine_index: spine,
					start: 0,
					end: 9,
					html: "",
					leaf_start: 0,
					leaf_end: 9,
				},
			],
		},
	};
}
const settings: TranslationSettings = {
	id: "default",
	adapter: "llm",
	revision: 1,
	name: "翻译",
	model_id: "model",
	target_language: "中文",
	before_sentences: 3,
	before_characters: 200,
	after_sentences: 0,
	after_characters: 0,
	max_context_characters: 2000,
	max_target_characters: 2000,
};
function task(reference = target().reference, id = "task"): TranslationTask {
	return {
		id,
		source_id: "source",
		material_id: "book",
		material_provenance: reference,
		text: "猫だ。",
		context_before: "历史前文",
		context_after: "历史后文",
		status: "queued",
		result_id: null,
		run_id: null,
		error: null,
		created_at: "2026-10-24T00:00:00Z",
	};
}
function result(): TranslationResult {
	return {
		id: "result",
		task_id: "task",
		source_id: "source",
		material_id: "book",
		chapter_id: "chapter",
		material_provenance: target().reference,
		material_deleted: false,
		adopted_segment_ids: [],
		parts: [],
		identity_sha256: "identity",
		text: "猫だ。",
		translation: "猫",
		context_before: "前文",
		context_after: "",
		target_language: "中文",
		scheme_id: "scheme",
		scheme_name: "翻译",
		scheme_revision: 1,
		model_id: "model",
		provider_name: "provider",
		protocol: "chat_completions",
		prompt_version: "1",
		run_id: "run",
		created_at: "2026-10-24T00:00:00Z",
		max_output_tokens: null,
		reasoning_effort: null,
		temperature: null,
	};
}

function fixture() {
	const requests: TranslationInput[] = [];
	const accepted: TranslationTask[] = [];
	const histories = new Map<string, TranslationHistory>();
	let uuid = 0;
	let historyReads = 0;
	let settingsReads = 0;
	const empty = (): TranslationHistory => ({
		results: [],
		tasks: [],
		next_offset: null,
	});
	const adapter: TranslationQueryAdapter = {
		async settings() {
			settingsReads++;
			return settings;
		},
		async history(reference) {
			historyReads++;
			const value = histories.get(translationTargetKey(reference)) ?? empty();
			histories.set(translationTargetKey(reference), value);
			return value;
		},
		peekHistory: (reference) => histories.get(translationTargetKey(reference)),
		hasActiveTask: (reference, id) =>
			histories
				.get(translationTargetKey(reference))
				?.tasks.some((item) =>
					["queued", "running", "stopping"].includes(item.status),
				) ||
			accepted.some(
				(item) =>
					item.id === id &&
					["queued", "running", "stopping"].includes(item.status),
			),
		async submit(_materialId, input) {
			requests.push(input);
			return task(input.material_provenance, input.request_id);
		},
		accept(value) {
			accepted.push(value);
		},
		async stop(id) {
			return { ...task(), id, status: "cancelled" };
		},
		uuid: () => `uuid-${++uuid}`,
	};
	const sessions = createTranslationSessions(adapter);
	const unbind = sessions.bindOwner();
	const session = sessions.forTarget("source", target());
	return {
		adapter,
		sessions,
		session,
		unbind,
		requests,
		accepted,
		histories,
		empty,
		reads: () => ({ history: historyReads, settings: settingsReads }),
	};
}

test("same target has one stable immutable snapshot shared by subscribers", async () => {
	const f = fixture();
	assert.equal(f.sessions.forTarget("source", target()), f.session);
	const initial = f.session.getSnapshot();
	assert.equal(initial, f.session.getSnapshot());
	let observed = initial;
	const off = f.session.subscribe(() => {
		observed = f.session.getSnapshot();
	});
	f.session.edit({ kind: "context", before: "共有" });
	assert.equal(observed.draft.before, "共有");
	assert.notEqual(initial, observed);
	assert.equal(initial.draft.before, "");
	assert.equal(Object.isFrozen(observed.draft.budget), true);
	off();
	f.session.edit({ kind: "context", before: "" });
	assert.equal(f.session.getSnapshot().draft.before, "");
	assert.equal(f.session.getSnapshot().draft.edited, true);
	await f.session.open({ kind: "history" });
	assert.equal(f.session.getSnapshot().draft.before, "");
	assert.equal(f.requests.length, 0);
});

test("late settings preserve edits, clearing and budget; only refill replaces context", async () => {
	const f = fixture();
	const read = deferred<TranslationSettings>();
	f.adapter.settings = () => read.promise;
	const opening = f.session.open({ kind: "history" });
	assert.equal(f.session.getSnapshot().phase, "idle");
	f.session.edit({ kind: "context", before: "", after: "人工" });
	const budget = {
		...settings,
		before_sentences: 0,
		before_characters: 0,
		after_sentences: 1,
		after_characters: 30,
	};
	f.session.edit({ kind: "budget", value: budget });
	read.resolve(settings);
	await opening;
	assert.equal(f.session.getSnapshot().draft.before, "");
	assert.equal(f.session.getSnapshot().draft.after, "人工");
	assert.equal(f.session.getSnapshot().draft.budget.before_sentences, 0);
	f.session.edit({
		kind: "budget",
		value: { ...budget, before_sentences: 1, before_characters: 30 },
	});
	assert.equal(f.session.getSnapshot().draft.after, "人工");
	f.session.edit({ kind: "refill" });
	assert.equal(f.session.getSnapshot().draft.before, "前文。");
	assert.equal(f.session.getSnapshot().draft.after, "後文。");
	await f.session.open({ kind: "history" });
	assert.equal(f.session.getSnapshot().draft.budget.before_sentences, 1);
});

test("same-target commands reserve synchronously while another target proceeds", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	const second = f.sessions.forTarget("source", target(1));
	await second.open({ kind: "history" });
	const post = deferred<TranslationTask>();
	f.adapter.submit = async (_id, body) => {
		f.requests.push(body);
		return body.material_provenance.ranges[0]?.spine_index === 0
			? post.promise
			: task(body.material_provenance, "other");
	};
	const first = f.session.execute({ kind: "translate" });
	assert.equal(
		(await f.session.execute({ kind: "translate" })).kind,
		"not-executed",
	);
	assert.equal(f.session.edit({ kind: "context", before: "bypass" }), false);
	assert.equal((await second.execute({ kind: "translate" })).kind, "accepted");
	post.resolve(task());
	assert.equal((await first).kind, "accepted");
	assert.equal(f.requests.length, 2);
});

test("POST unknown retries original UUID and entire DTO without reading settings or history", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	f.session.edit({ kind: "context", before: "固定语境" });
	f.adapter.submit = async (_id, input) => {
		f.requests.push(input);
		throw Object.assign(new Error("丢失"), { status: 500 });
	};
	assert.equal(
		(await f.session.execute({ kind: "translate" })).kind,
		"uncertain",
	);
	const input = f.requests[0];
	assert.equal(f.session.edit({ kind: "context", before: "替换" }), false);
	assert.equal(f.session.edit({ kind: "refill" }), false);
	f.session.edit({
		kind: "budget",
		value: { ...settings, before_sentences: 0 },
	});
	f.adapter.settings = async () => {
		throw new Error("设置不可用");
	};
	f.adapter.history = async () => {
		throw new Error("历史不可用");
	};
	assert.equal(
		(await f.session.execute({ kind: "translate" })).kind,
		"not-executed",
	);
	f.adapter.submit = async (_id, body) => {
		f.requests.push(body);
		return task(body.material_provenance);
	};
	assert.equal((await f.session.execute({ kind: "verify" })).kind, "accepted");
	assert.deepEqual(f.requests[1], input);
	assert.equal(input?.context_before, "固定语境");
	assert.equal(f.session.getSnapshot().phase, "idle");
});

test("preflight failure is definite; rejection clears UUID and fresh submit gets another", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	f.adapter.history = async () => {
		throw new Error("历史故障");
	};
	assert.equal((await f.session.execute({ kind: "translate" })).kind, "failed");
	assert.equal(f.session.getSnapshot().phase, "idle");
	assert.equal(f.requests.length, 0);
	f.adapter.history = async () => f.empty();
	f.adapter.submit = async (_id, body) => {
		f.requests.push(body);
		throw Object.assign(new Error("无效"), { status: 422 });
	};
	assert.equal((await f.session.execute({ kind: "translate" })).kind, "failed");
	assert.equal(
		(await f.session.execute({ kind: "verify" })).kind,
		"not-executed",
	);
	await f.session.execute({ kind: "translate" });
	assert.notEqual(f.requests[0]?.request_id, f.requests[1]?.request_id);
});

test("automatic intent waits for fresh canonical history and browsing consumes it", async () => {
	const f = fixture();
	const read = deferred<TranslationHistory>();
	f.histories.set(f.session.key, f.empty());
	f.adapter.history = async () => {
		const value = await read.promise;
		f.histories.set(f.session.key, value);
		return value;
	};
	const opening = f.session.open({ kind: "selection" });
	await Promise.resolve();
	assert.equal(f.requests.length, 0);
	f.session.browseHistory();
	read.resolve(f.empty());
	await opening;
	await f.session.open({ kind: "selection" });
	assert.equal(f.requests.length, 0);
	assert.equal(
		(await f.session.execute({ kind: "translate" })).kind,
		"accepted",
	);
});

test("incomplete canonical history and successful results consume automatic intent", async () => {
	for (const value of [
		{ ...fixture().empty(), next_offset: 15 },
		{ ...fixture().empty(), tasks: [task()] },
		{ ...fixture().empty(), results: [result()] },
	]) {
		const f = fixture();
		f.histories.set(f.session.key, value);
		await f.session.open({ kind: "selection" });
		f.histories.set(f.session.key, f.empty());
		await f.session.open({ kind: "selection" });
		assert.equal(f.requests.length, 0);
	}
});

test("new active facts before POST block manual, automatic and recent submissions", async () => {
	for (const kind of ["translate", "automatic", "repeat"] as const) {
		const f = fixture();
		await f.session.open({ kind: "history" });
		const read = deferred<TranslationSettings>();
		f.adapter.settings = () => read.promise;
		const operation =
			kind === "automatic"
				? f.session.open({ kind: "selection" })
				: f.session.execute(
						kind === "repeat"
							? { kind: "repeat-task", task: { ...task(), status: "failed" } }
							: { kind: "translate" },
					);
		await Promise.resolve();
		await Promise.resolve();
		f.histories.set(f.session.key, { ...f.empty(), tasks: [task()] });
		read.resolve(settings);
		await operation;
		assert.equal(f.requests.length, 0, kind);
		assert.equal(f.session.getSnapshot().phase, "idle");
	}
});

test("Reader unbinding releases preflight and StrictMode rebind only allows a new operation", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	const old = deferred<TranslationSettings>();
	f.adapter.settings = () => old.promise;
	const operation = f.session.execute({ kind: "translate" });
	await Promise.resolve();
	f.unbind();
	assert.equal(f.session.getSnapshot().phase, "idle");
	f.sessions.bindOwner();
	f.adapter.settings = async () => settings;
	const replacement = await f.session.open({ kind: "selection" });
	assert.equal(replacement.kind, "accepted");
	old.reject(new Error("旧读取失败"));
	assert.deepEqual(await operation, {
		kind: "not-executed",
		reason: "inactive",
	});
	assert.equal(f.session.getSnapshot().acceptedTaskId, "uuid-1");
	assert.equal(f.session.getSnapshot().error, null);
	assert.equal(f.requests.length, 1);
});

test("already posted acceptance survives owner unbind and view unsubscribe", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	const posted = deferred<TranslationTask>();
	const sent = deferred<void>();
	f.adapter.submit = async (_id, body) => {
		f.requests.push(body);
		sent.resolve();
		return posted.promise;
	};
	const off = f.session.subscribe(() => {});
	const operation = f.session.execute({ kind: "translate" });
	await sent.promise;
	off();
	f.unbind();
	posted.resolve(task());
	assert.equal((await operation).kind, "accepted");
	assert.equal(f.accepted.length, 1);
	assert.equal(f.session.getSnapshot().acceptedTaskId, "task");
	assert.equal(f.session.getSnapshot().phase, "idle");
});

test("history observer cannot take over a selection's pending automatic completion", async () => {
	const f = fixture();
	const read = deferred<TranslationHistory>();
	f.adapter.history = async () => {
		const value = await read.promise;
		f.histories.set(f.session.key, value);
		return value;
	};
	const selection = f.session.open({ kind: "selection" });
	const observer = f.session.open({ kind: "history" });
	read.resolve(f.empty());
	assert.equal((await selection).kind, "accepted");
	assert.equal((await observer).kind, "not-executed");
	assert.equal(f.requests.length, 1);
});

test("recent repeat uses task input, keeps edited shared draft and cannot bypass unknown", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	f.session.edit({ kind: "context", before: "当前草稿", after: "新后文" });
	const previous = { ...task(), status: "failed" as const };
	const recent = f.sessions.forTask("source", previous);
	assert.equal(recent, f.session);
	f.adapter.submit = async (_id, body) => {
		f.requests.push(body);
		throw new Error("lost");
	};
	await recent.execute({ kind: "repeat-task", task: previous });
	assert.equal(f.requests[0]?.context_before, "历史前文");
	assert.equal(f.requests[0]?.context_after, "历史后文");
	assert.equal(f.session.getSnapshot().draft.before, "当前草稿");
	assert.equal(
		(await recent.execute({ kind: "repeat-task", task: previous })).kind,
		"not-executed",
	);
	assert.equal(f.requests.length, 1);
});

test("prefill error blocks automatic only; manual prepared context remains usable", async () => {
	const f = fixture();
	const invalid = target(2);
	const part = invalid.chapter.parts[0];
	assert.ok(part);
	part.spine_index = 3;
	const session = f.sessions.forTarget("source", invalid);
	await session.open({ kind: "selection" });
	assert.ok(session.getSnapshot().draft.localError);
	assert.equal(f.requests.length, 0);
	session.edit({ kind: "context", before: "人工准备" });
	assert.equal((await session.execute({ kind: "translate" })).kind, "accepted");
	assert.equal(f.requests[0]?.context_before, "人工准备");
});

test("request provenance and accepted association are protected from caller mutations and browsing", async () => {
	const f = fixture();
	const inputTarget = target(4);
	const session = f.sessions.forTarget("source", inputTarget);
	const range = inputTarget.reference.ranges[0];
	assert.ok(range);
	range.exact = "外部修改";
	assert.equal(session.reference.ranges[0]?.exact, "猫だ。");
	assert.equal(Object.isFrozen(session.reference.ranges), true);
	await session.open({ kind: "history" });
	await session.execute({ kind: "translate" });
	assert.equal(f.requests[0]?.text, "猫だ。");
	assert.equal(
		Object.isFrozen(f.requests[0]?.material_provenance.ranges[0]),
		true,
	);
	const accepted = session.getSnapshot().acceptedTaskId;
	session.browseHistory();
	assert.equal(session.getSnapshot().acceptedTaskId, accepted);
	await session.stop("old-task");
	assert.equal(session.getSnapshot().acceptedTaskId, accepted);
});

test("failed initialization can be retried and a missing model can later enable the same intent", async () => {
	const f = fixture();
	f.adapter.settings = async () => {
		throw new Error("设置失败");
	};
	await f.session.open({ kind: "selection" });
	assert.equal(f.session.getSnapshot().draft.initialized, false);
	f.adapter.settings = async () => ({ ...settings, model_id: null });
	await f.session.open({ kind: "selection" });
	assert.equal(f.session.getSnapshot().draft.initialized, true);
	assert.equal(f.requests.length, 0);
	f.adapter.settings = async () => settings;
	assert.equal((await f.session.open({ kind: "selection" })).kind, "accepted");
	assert.equal(f.requests.length, 1);
});

test("a synchronous subscriber cannot bypass a submission reservation", async () => {
	const f = fixture();
	await f.session.open({ kind: "history" });
	const reentrant: Promise<unknown>[] = [];
	const off = f.session.subscribe(() => {
		if (f.session.getSnapshot().phase === "submitting")
			reentrant.push(f.session.execute({ kind: "translate" }));
	});
	await f.session.execute({ kind: "translate" });
	off();
	assert.deepEqual(await Promise.all(reentrant), [
		{ kind: "not-executed", reason: "busy" },
	]);
	assert.equal(f.requests.length, 1);
});
