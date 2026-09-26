import { marked } from './vendor/marked.esm.js';

const CASE_ORDER = ['sample01-o11', 'sample04-o03', 'sample05-o05', 'sample04-o04'];
const VIEWS = ['baseline', 'original', 'tree'];
const VIEW_NAMES = { baseline: '当前基线', original: '原 Section', tree: 'JSON 树' };
const $ = (id) => document.getElementById(id);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

let cases = [];
let selectedCase = CASE_ORDER[0];
let selectedView = 'baseline';

function safeHref(href) {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// Marked handles Markdown in the source view. Build a fresh, restricted DOM from
// its output so neither Markdown links nor embedded HTML can inject active UI.
function safeMarkdown(raw) {
  const container = element('div', 'prose');
  try {
    const renderer = new marked.Renderer();
    renderer.html = (token) => {
      const source = typeof token === 'string' ? token : token.text;
      return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    };
    const html = marked.parse(raw, { renderer });
    const parsed = new DOMParser().parseFromString(String(html), 'text/html');
    const allowed = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'STRONG', 'EM', 'DEL', 'BR', 'HR', 'A']);
    const copy = (source, parent) => {
      for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(child.textContent)); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'TEMPLATE'].includes(child.tagName)) continue;
        if (child.tagName === 'IMG') { parent.append(element('span', 'image-alt', child.getAttribute('alt') || '图片')); continue; }
        if (!allowed.has(child.tagName)) { copy(child, parent); continue; }
        const clean = document.createElement(child.tagName.toLowerCase());
        if (child.tagName === 'A') {
          const href = safeHref(child.getAttribute('href'));
          if (href) { clean.href = href; clean.rel = 'noopener noreferrer'; }
        }
        if (child.tagName === 'OL') {
          const start = Number(child.getAttribute('start'));
          if (Number.isInteger(start) && start > 0) clean.start = start;
        }
        copy(child, clean);
        parent.append(clean);
      }
    };
    copy(parsed.body, container);
  } catch {
    container.append(element('pre', 'render-fallback', raw));
  }
  return container;
}

function appendInline(parent, nodes) {
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;
    let child;
    switch (node.type) {
      case 'text': case 'escape': parent.append(document.createTextNode(node.text ?? node.raw ?? '')); break;
      case 'code': parent.append(element('code', '', node.text ?? node.raw ?? '')); break;
      case 'strong': case 'em': case 'del':
        child = document.createElement(node.type); appendInline(child, node.children); parent.append(child); break;
      case 'link': {
        const href = safeHref(node.href);
        child = document.createElement(href ? 'a' : 'span');
        if (href) { child.href = href; child.rel = 'noopener noreferrer'; }
        appendInline(child, node.children);
        parent.append(child);
        break;
      }
      case 'image': parent.append(element('span', 'image-alt', node.text ? `图片：${node.text}` : node.raw)); break;
      case 'br': parent.append(document.createElement('br')); break;
      default: parent.append(document.createTextNode(node.raw ?? ''));
    }
  }
}

function treeBlock(node, headings) {
  if (!node || typeof node !== 'object') return element('pre', 'render-fallback', '');
  let result;
  switch (node.type) {
    case 'heading':
      result = document.createElement(`h${Math.min(6, Math.max(1, Number(node.depth) || 2))}`);
      appendInline(result, node.inline);
      result.id = `tree-heading-${headings.sectionIndex}-${headings.items.length}`;
      result.tabIndex = -1;
      headings.items.push({ id: result.id, text: result.textContent, depth: Number(node.depth) || 2 });
      break;
    case 'paragraph': case 'text':
      result = document.createElement('p'); appendInline(result, node.inline); break;
    case 'blockquote':
      result = document.createElement('blockquote'); result.append(...(node.children || []).map((child) => treeBlock(child, headings))); break;
    case 'list':
      result = document.createElement(node.ordered ? 'ol' : 'ul');
      if (node.ordered && Number.isInteger(node.start) && node.start > 0) result.start = node.start;
      for (const item of node.items || []) {
        const li = document.createElement('li');
        li.append(...(item.children || []).map((child) => treeBlock(child, headings)));
        result.append(li);
      }
      break;
    case 'code':
      result = document.createElement('pre'); result.append(element('code', '', node.text ?? node.raw ?? '')); break;
    case 'hr': result = document.createElement('hr'); break;
    case 'space': result = element('div', 'markdown-space'); break;
    default: result = element('pre', 'render-fallback', node.raw ?? '');
  }
  return result;
}

function currentCase() { return cases.find((row) => row.case_id === selectedCase); }

function renderCases() {
  $('case-list').replaceChildren(...cases.map((row, index) => {
    const button = element('button', 'case-button');
    button.type = 'button';
    button.dataset.caseId = row.case_id;
    button.setAttribute('aria-pressed', String(row.case_id === selectedCase));
    button.append(element('span', 'case-number', String(index + 1).padStart(2, '0')));
    const text = element('span', 'case-button-text');
    text.append(element('strong', '', row.title), element('small', '', `${row.sample_id} · ${row.kind}`));
    button.append(text, element('span', 'case-arrow', '↗'));
    button.addEventListener('click', () => { selectedCase = row.case_id; render(); });
    return button;
  }));
}

function renderTabs() {
  for (const view of VIEWS) {
    const tab = $(`tab-${view}`);
    const selected = view === selectedView;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('view-panel').setAttribute('aria-labelledby', `tab-${selectedView}`);
}

function targetWithSpans(row) {
  const text = Array.from(row.target_text || '');
  const spans = (row.surface_spans || [])
    .filter((span) => Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end <= text.length && span.start < span.end)
    .sort((a, b) => a.start - b.start);
  const target = element('p', 'target-text');
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    target.append(document.createTextNode(text.slice(cursor, span.start).join('')));
    const mark = element('mark', '', text.slice(span.start, span.end).join(''));
    target.append(mark);
    cursor = span.end;
  }
  target.append(document.createTextNode(text.slice(cursor).join('')));
  return target;
}

function contextBlock(label, text, position) {
  const block = element('div', `context-block context-${position}`);
  block.append(element('div', 'context-label', label), element('p', 'context-text', text || '（无）'));
  return block;
}

function renderReading(row) {
  const reading = element('section', 'reading-card');
  reading.setAttribute('aria-label', '目标原文与前后语境');
  reading.append(contextBlock('前文 · CONTEXT BEFORE', row.context?.before, 'before'));
  const focus = element('div', 'focus-text');
  focus.append(element('div', 'focus-label', '本次解析目标 · TARGET'), targetWithSpans(row), element('p', 'surface-note', '荧光标记为此学习点的 Surface 位置'));
  reading.append(focus, contextBlock('后文 · CONTEXT AFTER', row.context?.after, 'after'));
  return reading;
}

function uniqueSections(row) {
  const seen = new Set();
  return (row.sections || []).filter((section) => {
    if (!section || seen.has(section.section_ref)) return false;
    seen.add(section.section_ref); return true;
  });
}

function sectionCard(section, view, index) {
  const card = element('details', 'section-card');
  if (index === 0) card.open = true;
  const summary = element('summary', 'section-summary');
  const number = element('span', 'section-number', String(index + 1).padStart(2, '0'));
  const heading = element('span', 'section-heading');
  heading.append(element('strong', '', section.title || '未命名 Section'), element('small', '', `${section.section_ref} · L${section.start_line}–${section.end_line}`));
  summary.append(number, heading, element('span', 'section-toggle', '展开 / 收起'));
  const body = element('div', 'section-body');
  if (view === 'original') body.append(safeMarkdown(section.raw_markdown || ''));
  else {
    const headings = { sectionIndex: index, items: [] };
    const prose = element('div', 'prose tree-prose');
    prose.append(...(section.tree || []).map((node) => treeBlock(node, headings)));
    if (headings.items.length) {
      const outline = element('nav', 'tree-outline');
      outline.setAttribute('aria-label', `Section ${section.section_ref} 标题导航`);
      outline.append(element('p', 'tree-outline-label', '本 Section 标题'));
      const links = element('div', 'tree-outline-links');
      for (const heading of headings.items) {
        const button = element('button', `tree-outline-link depth-${Math.min(6, Math.max(1, heading.depth))}`, heading.text);
        button.type = 'button';
        button.addEventListener('click', () => {
          const target = document.getElementById(heading.id);
          target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target?.focus({ preventScroll: true });
        });
        links.append(button);
      }
      outline.append(links);
      body.append(outline);
    }
    body.append(prose);
  }
  card.append(summary, body);
  return card;
}

function render() {
  const row = currentCase();
  if (!row) return;
  renderCases(); renderTabs();
  $('case-meta').textContent = `${row.case_id} · ${row.kind}`;
  const panel = $('view-panel');
  const layout = element('div', selectedView === 'baseline' ? 'panel-layout baseline-layout' : 'panel-layout');
  const primary = element('div', 'primary-column');
  const eyebrow = element('p', 'eyebrow', 'SELECTED OCCURRENCE');
  const title = element('h3', 'occurrence-title', row.title);
  const gloss = element('p', 'gloss', row.gloss);
  const intro = element('div', 'occurrence-intro'); intro.append(eyebrow, title, gloss);
  primary.append(intro, renderReading(row));
  layout.append(primary);
  if (selectedView !== 'baseline') {
    const sections = uniqueSections(row);
    const aside = element('aside', 'sections-column');
    aside.setAttribute('aria-label', '所引用的解析 Section');
    const heading = element('div', 'sections-head');
    const headText = element('div');
    headText.append(element('p', 'eyebrow', VIEW_NAMES[selectedView].toUpperCase()), element('h3', '', '所引用的讲解'));
    heading.append(headText, element('span', 'section-total', `${sections.length} Section${sections.length === 1 ? '' : 's'}`));
    aside.append(heading, element('p', 'sections-help', '点击标题可展开完整内容；Section 顺序与原文一致。'));
    const cards = element('div', 'section-stack');
    cards.append(...sections.map((section, index) => sectionCard(section, selectedView, index)));
    aside.append(cards); layout.append(aside);
  }
  panel.replaceChildren(layout);
}

function showError(error) {
  const panel = $('view-panel');
  panel.replaceChildren(element('div', 'load-error', `无法载入阅读数据：${error.message}。请在 reading-experiment 目录启动本地 HTTP 服务后打开此页。`));
}

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  selectedView = tab.dataset.view;
  render();
});
document.querySelector('.tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = VIEWS.indexOf(selectedView);
  selectedView = event.key === 'Home' ? VIEWS[0] : event.key === 'End' ? VIEWS.at(-1) : VIEWS[(index + (event.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length];
  render();
  $(`tab-${selectedView}`).focus();
});

try {
  const response = await fetch('./data.json');
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.version !== 'reading-demo-v1' || !Array.isArray(data.cases)) throw Error('数据格式不匹配');
  cases = CASE_ORDER.map((id) => data.cases.find((row) => row.case_id === id));
  if (cases.some((row) => !row)) throw Error('缺少精选案例');
  render();
} catch (error) { showError(error); }
