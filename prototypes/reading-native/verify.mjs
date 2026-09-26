import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");

function open(storage = new Map()) {
  const listeners = new Map();
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: "", innerHTML: "", textContent: "", scrollTop: 0,
        classList: { add() {}, remove() {} },
        focus() {}, scrollIntoView() {}, setAttribute() {}, addEventListener() {},
        showModal() {}, close() {},
      });
    }
    return elements.get(selector);
  };
  const document = {
    body: { className: "" },
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const context = createContext({
    document, localStorage, location: { search: "", href: "http://localhost/" },
    history: { replaceState() {} }, URL, URLSearchParams,
    setTimeout: () => 1, clearTimeout() {}, innerWidth: 1200,
  });
  runInContext(source, context);
  const snapshot = () => JSON.parse(runInContext("JSON.stringify(state)", context));
  return {
    storage, snapshot,
    scene: (value) => listeners.get("change")({ target: { id: "scene", value } }),
    thread: (value) => listeners.get("change")({ target: { id: "thread-select", value } }),
    mode: (value) => listeners.get("change")({ target: { id: "permission", value } }),
    document: (value) => listeners.get("click")({ target: { closest: (selector) => selector === "[data-document]" ? { dataset: { document: value } } : null } }),
    item: (name, expanded) => listeners.get("toggle")({ target: { dataset: { item: name }, open: expanded } }),
    openThread: (id) => listeners.get("click")({ target: { closest: (selector) => selector === "[data-thread]" ? { dataset: { thread: id } } : null } }),
    action: (name) => runInContext(`actions[${JSON.stringify(name)}]()`, context),
    input: (value) => {
      element("#question").value = value;
      listeners.get("input")({ target: { id: "question", value } });
    },
    submit: (value) => {
      element("#question").value = value;
      listeners.get("submit")({ target: { id: "composer" }, preventDefault() {} });
    },
    html: () => element("#app").innerHTML,
  };
}

test("a plain question persists only the conversation", () => {
  const app = open();
  app.scene("start");
  app.submit("这里的まま是什么意思？");
  const scene = app.snapshot().scenes.start;
  assert.equal(scene.threads[0].messages.length, 2);
  assert.equal(scene.hasDocument, false);
  assert.equal(scene.savedTopic, false);
  assert.equal(scene.collected, false);
});

test("saving a topic from source-only discussion creates no full analysis or item", () => {
  const app = open();
  app.scene("start");
  app.submit("解释一下まま");
  app.action("save-topic");
  const scene = app.snapshot().scenes.start;
  assert.equal(scene.savedTopic, true);
  assert.equal(scene.hasDocument, false);
  assert.equal(scene.selectedDocument, "topic");
  assert.equal(scene.collected, false);
  assert.match(app.html(), /「まま」专题讲解/);
});

test("generating a full analysis does not seed an Occurrence", () => {
  const app = open();
  app.scene("start");
  app.action("generate");
  const scene = app.snapshot().scenes.start;
  assert.equal(scene.hasDocument, true);
  assert.equal(scene.collected, false);
  assert.match(app.html(), /<aside class="items-pane" aria-label="学习条目栏"/);
  assert.match(app.html(), /<span class="pane-count">0<\/span>/);
});

test("collection from a selected topic cites that topic's version", () => {
  const app = open();
  app.scene("start");
  app.action("save-topic");
  app.action("collect");
  let scene = app.snapshot().scenes.start;
  assert.equal(scene.threads[0].review.document, "topic");
  assert.equal(scene.threads[0].review.base, 1);
  assert.equal(scene.collected, false);
  app.action("approve");
  scene = app.snapshot().scenes.start;
  assert.equal(scene.collectionDocument, "topic");
  assert.equal(scene.collectionRevision, 1);
  assert.equal(scene.collected, true);
  assert.equal(scene.hasDocument, false);
});

test("reject leaves content unchanged; approve changes a version only once", () => {
  const app = open();
  app.action("propose-edit");
  assert.equal(app.snapshot().scenes.ready.revision, 1);
  app.action("reject");
  assert.equal(app.snapshot().scenes.ready.revision, 1);
  assert.equal(app.snapshot().scenes.ready.threads[0].review.status, "rejected");
  app.action("propose-edit");
  app.action("approve");
  app.action("approve");
  assert.equal(app.snapshot().scenes.ready.revision, 2);
});

test("a stale proposal from another thread cannot overwrite the newer revision", () => {
  const app = open();
  app.action("propose-edit");
  app.action("new-thread");
  app.action("propose-edit");
  app.action("approve");
  assert.equal(app.snapshot().scenes.ready.revision, 2);
  app.thread("main");
  app.action("approve");
  const scene = app.snapshot().scenes.ready;
  assert.equal(scene.revision, 2);
  assert.equal(scene.threads[0].review, null);
});

test("threads retain independent references and unsent drafts", () => {
  const app = open();
  app.action("select-source");
  app.input("first draft");
  app.action("new-thread");
  const newThreadId = app.snapshot().scenes.ready.thread;
  app.input("second draft");
  app.thread("main");
  const scene = app.snapshot().scenes.ready;
  const main = scene.threads.find((thread) => thread.id === "main");
  const created = scene.threads.find((thread) => thread.id === newThreadId);
  assert.match(main.reference, /傘を差したまま/);
  assert.equal(main.draft, "first draft");
  assert.equal(created.reference, "原文 · 片段 07");
  assert.equal(created.draft, "second draft");
  assert.match(app.html(), /first draft/);
});

test("items pane stays independent of document tabs and remembers disclosure state", () => {
  const app = open();
  app.action("toggle-items");
  assert.equal(app.snapshot().scenes.ready.itemsHidden, true);
  assert.match(app.html(), /<aside class="items-pane" aria-label="学习条目栏" hidden>/);
  app.document("topic");
  assert.equal(app.snapshot().scenes.ready.selectedDocument, "topic");
  assert.equal(app.snapshot().scenes.ready.itemsHidden, true);
  assert.match(app.html(), /id="document-tab-topic"[^>]*aria-selected="true"/);
  app.action("toggle-items");
  app.item("reference", false);
  app.document("full");
  assert.equal(app.snapshot().scenes.ready.itemExpanded.reference, false);
  assert.match(app.html(), /<details data-item="reference"\s*>/);
  app.action("threads-list");
  app.document("topic");
  assert.equal(app.snapshot().scenes.ready.itemExpanded.reference, false);
  assert.equal(app.snapshot().scenes.ready.itemsHidden, false);
});

test("conversation list roundtrip preserves each thread's draft, reference, mode and pending review", () => {
  const app = open();
  app.action("select-source");
  app.input("main draft");
  app.mode("full");
  app.action("threads-list");
  assert.equal(app.snapshot().scenes.ready.chatView, "list");
  assert.match(app.html(), /data-thread="context"/);
  app.openThread("context");
  assert.equal(app.snapshot().scenes.ready.chatView, "thread");
  assert.match(app.html(), /等待审核/);
  assert.match(app.html(), /尚未写入/);
  app.action("threads-list");
  app.openThread("main");
  const scene = app.snapshot().scenes.ready;
  const main = scene.threads.find((thread) => thread.id === "main");
  const context = scene.threads.find((thread) => thread.id === "context");
  assert.equal(main.draft, "main draft");
  assert.match(main.reference, /傘を差したまま/);
  assert.equal(main.mode, "full");
  assert.equal(context.review.status, "pending");
  assert.equal(context.mode, "review");
  assert.equal(scene.revision, 1);
  assert.match(app.html(), /main draft/);
});

test("selecting seeded conversations keeps their histories separate", () => {
  const app = open();
  app.action("threads-list");
  app.openThread("contrast");
  app.submit("contrast follow-up");
  app.action("threads-list");
  app.openThread("context");
  app.submit("context follow-up");
  const scene = app.snapshot().scenes.ready;
  const contrast = scene.threads.find((thread) => thread.id === "contrast");
  const context = scene.threads.find((thread) => thread.id === "context");
  assert.equal(contrast.messages.at(-2).text, "contrast follow-up");
  assert.equal(context.messages.at(-2).text, "context follow-up");
  assert.doesNotMatch(app.html(), /contrast follow-up/);
  app.action("threads-list");
  app.openThread("contrast");
  assert.match(app.html(), /contrast follow-up/);
  assert.doesNotMatch(app.html(), /context follow-up/);
});

test("new discussion enters detail view from the conversation list", () => {
  const app = open();
  app.action("threads-list");
  const before = app.snapshot().scenes.ready.threads.length;
  app.action("new-thread");
  const scene = app.snapshot().scenes.ready;
  const created = scene.threads.find((thread) => thread.id === scene.thread);
  assert.equal(scene.threads.length, before + 1);
  assert.equal(scene.chatView, "thread");
  assert.equal(scene.chatHidden, false);
  assert.deepEqual(created.messages, []);
  assert.match(app.html(), /class="aside conversation-detail"/);
  assert.match(app.html(), /一个新的讨论/);
});

test("a pending proposal survives reload without applying itself", () => {
  const storage = new Map();
  const app = open(storage);
  app.action("propose-edit");
  const reloaded = open(storage);
  const scene = reloaded.snapshot().scenes.ready;
  assert.equal(scene.revision, 1);
  assert.equal(scene.threads[0].review.status, "pending");
  assert.match(reloaded.html(), /等待审核/);
  assert.match(reloaded.html(), /尚未写入/);
});
