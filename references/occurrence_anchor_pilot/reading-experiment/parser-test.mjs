import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from './vendor/marked.esm.js';
import { parseMarkdown } from './build.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const batch = resolve(directory, '../batch-01');
const data = JSON.parse(await readFile(join(directory, 'data.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(batch, 'manifest.json'), 'utf8'));
const sampleById = new Map(manifest.samples.map(sample => [sample.sample_id, sample]));

function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function descendants(nodes) {
  return nodes.flatMap(node => [node, ...descendants(node.inline ?? node.children ?? node.items ?? [])]);
}

assert.equal(data.version, 'reading-demo-v1');
assert.deepEqual(data.cases.map(item => item.case_id),
  ['sample01-o11', 'sample04-o03', 'sample05-o05', 'sample04-o04']);

for (const item of data.cases) {
  const sample = sampleById.get(item.sample_id);
  const original = await readFile(join(batch, sample.snapshot_files.analysis), 'utf8');
  const sourceLines = lines(original);
  for (const section of item.sections) {
    assert.equal(section.raw_markdown,
      sourceLines.slice(section.start_line - 1, section.end_line).join(''), section.section_ref);
    assert.equal(section.tree.map(node => node.raw).join(''), section.raw_markdown, section.section_ref);
    assert.deepEqual(section.tree.map(node => node.type),
      marked.lexer(section.raw_markdown).map(token => token.type));
    for (const node of descendants(section.tree)) {
      assert(typeof node.raw === 'string');
      assert(node.source.start_line >= section.start_line, `${section.section_ref} start`);
      assert(node.source.end_line <= section.end_line, `${section.section_ref} end`);
    }
  }
  for (let i = 0; i < item.surface_refs.length; i++) {
    const span = item.surface_spans[i];
    assert.equal([...item.target_text].slice(span.start, span.end).join(''), span.text);
    assert.equal(span.text, item.surface_refs[i].text);
  }
}

function findInline(caseId, raw) {
  const item = data.cases.find(candidate => candidate.case_id === caseId);
  return item.sections.flatMap(section => descendants(section.tree))
    .find(node => node.raw === raw && node.type === 'strong');
}

// Markdown punctuation and Japanese text must survive as raw syntax and parsed children.
for (const [caseId, raw, childText] of [
  ['sample01-o11', '**見かける（見掛ける）**', '見かける（見掛ける）'],
  ['sample04-o03', '**くる（来る）**', 'くる（来る）'],
  ['sample04-o04', '**我昨天在网上查来的**', '我昨天在网上查来的'],
]) {
  const node = findInline(caseId, raw);
  assert(node, `${caseId}: missing ${raw}`);
  assert.equal(node.type, 'strong');
  assert.equal(node.children.map(child => child.raw).join(''), childText);
  assert.equal(node.children.map(child => child.text ?? '').join(''), childText);
}

assert(data.cases.some(item => item.sections.some(section =>
  section.tree.some(node => node.type === 'blockquote' || node.type === 'paragraph'))));
const fixture = '# Heading *em*\n\n- **bold** [link](https://example.test "Title")\n- ![alt](image.png) `code` ~~gone~~  \nnext\n\n> quoted\n\n```js\nconst x = 1;\n```\n\n---\n';
const fixtureTree = parseMarkdown(fixture, 80);
assert.equal(fixtureTree.map(node => node.raw).join(''), fixture);
const fixtureNodes = descendants(fixtureTree);
for (const type of ['heading', 'em', 'list', 'list_item', 'strong', 'link', 'image', 'code', 'del', 'br', 'blockquote', 'hr']) {
  assert(fixtureNodes.some(node => node.type === type), `Missing normalized ${type}`);
}
assert.equal(fixtureNodes.find(node => node.type === 'link').href, 'https://example.test');
assert.equal(fixtureNodes.find(node => node.type === 'image').text, 'alt');
assert.equal(fixtureNodes.find(node => node.type === 'list').ordered, false);
console.log('Parser tests passed: exact section slices, raw reconstruction, spans, and inline markup');
