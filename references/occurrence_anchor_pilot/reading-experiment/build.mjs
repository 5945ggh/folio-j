import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { marked } from './vendor/marked.esm.js';

const directory = dirname(fileURLToPath(import.meta.url));
const batch = resolve(directory, '../batch-01');
const selected = ['sample01-o11', 'sample04-o03', 'sample05-o05', 'sample04-o04'];

function lineAt(text, offset, startLine) {
  return startLine + (text.slice(0, offset).match(/\n/g)?.length ?? 0);
}

function sourceFor(raw, sourceText, offset, startLine) {
  const first = lineAt(sourceText, offset, startLine);
  const lastOffset = offset + Math.max(raw.length - 1, 0);
  return { start_line: first, end_line: lineAt(sourceText, lastOffset, startLine) };
}

function childOffset(parentRaw, childRaw, cursor) {
  let found = parentRaw.indexOf(childRaw, cursor);
  if (found < 0) found = parentRaw.indexOf(childRaw);
  return found;
}

function inlineTokens(tokens = [], parentRaw = '', parentOffset = 0, fullText = parentRaw, startLine = 1) {
  let cursor = 0;
  return tokens.map(token => {
    const raw = token.raw ?? '';
    const local = childOffset(parentRaw, raw, cursor);
    if (local >= 0) cursor = local + raw.length;
    const offset = parentOffset + Math.max(local, 0);
    const node = { type: token.type === 'codespan' ? 'code' : token.type, raw,
      source: sourceFor(raw, fullText, offset, startLine) };
    switch (token.type) {
      case 'text':
      case 'escape':
      case 'codespan':
        node.text = token.text ?? '';
        break;
      case 'strong':
      case 'em':
      case 'del':
        node.children = inlineTokens(token.tokens, raw, offset, fullText, startLine);
        break;
      case 'link':
        node.href = token.href;
        node.title = token.title ?? null;
        node.children = inlineTokens(token.tokens, raw, offset, fullText, startLine);
        break;
      case 'image':
        node.href = token.href;
        node.title = token.title ?? null;
        node.text = token.text ?? '';
        break;
      case 'br':
        break;
      default:
        node.type = 'fallback';
        node.original_type = token.type;
    }
    return node;
  });
}

function blockTokens(tokens, parentRaw, parentOffset, fullText, startLine) {
  let cursor = 0;
  return tokens.map(token => {
    const raw = token.raw ?? '';
    const local = childOffset(parentRaw, raw, cursor);
    if (local >= 0) cursor = local + raw.length;
    const offset = parentOffset + Math.max(local, 0);
    const node = { type: token.type, raw, source: sourceFor(raw, fullText, offset, startLine) };
    switch (token.type) {
      case 'heading':
        node.depth = token.depth;
        node.inline = inlineTokens(token.tokens, raw, offset, fullText, startLine);
        break;
      case 'paragraph':
      case 'text':
        node.inline = inlineTokens(token.tokens, raw, offset, fullText, startLine);
        break;
      case 'blockquote':
        node.children = blockTokens(token.tokens, raw, offset, fullText, startLine);
        break;
      case 'list':
        node.ordered = token.ordered;
        node.start = token.ordered ? token.start : null;
        node.items = blockTokens(token.items, raw, offset, fullText, startLine);
        break;
      case 'list_item':
        node.children = blockTokens(token.tokens, raw, offset, fullText, startLine);
        break;
      case 'code':
        node.text = token.text;
        node.lang = token.lang ?? null;
        break;
      case 'hr':
      case 'space':
        break;
      default:
        node.type = 'fallback';
        node.original_type = token.type;
    }
    return node;
  });
}

export function parseMarkdown(raw, startLine = 1) {
  const tree = blockTokens(marked.lexer(raw), raw, 0, raw, startLine);
  assert.equal(tree.map(node => node.raw).join(''), raw, 'Marked top-level raw mismatch');
  return tree;
}

function sectionLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function surfaceSpans(target, refs) {
  return refs.map(({ text, match_index }) => {
    let at = -1;
    for (let i = 0; i < match_index; i++) {
      at = target.indexOf(text, at + 1);
      assert.notEqual(at, -1, `Missing surface ${text} #${match_index}`);
    }
    const start = [...target.slice(0, at)].length;
    const end = start + [...text].length;
    return { start, end, text };
  });
}

async function main() {
  const manifest = JSON.parse(await readFile(join(batch, 'manifest.json'), 'utf8'));
  const records = (await readFile(join(batch, 'occurrences.jsonl'), 'utf8'))
    .trimEnd().split('\n').map(line => JSON.parse(line));
  const byId = new Map(records.map(record => [record.case_id, record]));
  const bySample = new Map(manifest.samples.map(sample => [sample.sample_id, sample]));
  const cases = [];
  for (const caseId of selected) {
    const record = byId.get(caseId);
    assert(record, `Missing ${caseId}`);
    const sample = bySample.get(record.sample_id);
    assert(sample, `Missing sample ${record.sample_id}`);
    const analysis = await readFile(join(batch, sample.snapshot_files.analysis), 'utf8');
    const lines = sectionLines(analysis);
    const references = [...new Set(record.item.section_refs)];
    const sections = sample.section_refs.filter(ref => references.includes(ref.section_ref)).map(ref => {
      const raw_markdown = lines.slice(ref.start_line - 1, ref.end_line).join('');
      assert(raw_markdown, `Empty section ${ref.section_ref}`);
      const tree = parseMarkdown(raw_markdown, ref.start_line);
      return { ...ref, raw_markdown, tree };
    });
    assert.equal(sections.length, references.length, `Missing section reference for ${caseId}`);
    const surface_refs = [...new Map(record.item.surface_refs.map(ref => [`${ref.text}\u0000${ref.match_index}`, ref])).values()];
    cases.push({ case_id: caseId, sample_id: record.sample_id, kind: record.item.kind,
      title: record.item.title, gloss: record.item.gloss, target_text: sample.target_text,
      context: sample.context, surface_refs, surface_spans: surfaceSpans(sample.target_text, surface_refs), sections });
  }
  const data = { version: 'reading-demo-v1', cases };
  await writeFile(join(directory, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Built ${cases.length} cases and ${cases.reduce((n, c) => n + c.sections.length, 0)} sections`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
