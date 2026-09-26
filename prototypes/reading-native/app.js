/* Visual study only. All data and responses are local fixtures; no model/API calls. */
"use strict";

const icons = {
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  "chevron-left": '<path d="m14 5-7 7 7 7"/>',
  "chevron-right": '<path d="m9 5 7 7-7 7"/>',
  "chevron-down": '<path d="m7 10 5 5 5-5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
  history: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v6l4 2"/>',
  compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l1-5 8-8 5 5-8 8z"/>',
  book: '<path d="M3 4h7a3 3 0 0 1 2 1 3 3 0 0 1 2-1h7v15h-7a3 3 0 0 0-2 1 3 3 0 0 0-2-1H3z"/><path d="M12 5v15"/>',
  library: '<path d="M4 4v16M9 4v16M14 4v16M18 4l3 16"/>',
  chat: '<path d="M20 11a8 8 0 0 1-8 8H4l-2 3V11a9 9 0 0 1 18 0Z"/><path d="M6 9h10M6 13h7"/>',
  file: '<path d="M5 2h9l5 5v15H5zM14 2v6h5M8 12h8M8 16h6"/>',
  arrow: '<path d="M12 20V4M6 10l6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m8 3-1 3-3 1-1 4 2 2v4l4 3 3-1 3 1 4-3v-4l2-2-1-4-3-1-1-3z"/>',
  link: '<path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-5-5l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-6 0"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const STORAGE_KEY = "folio-j-reading-native-v2";
const params = new URLSearchParams(location.search);
const directionCopy = {
  a: ["A / 阅读书页", "以阅读为中心，讨论停留在页边。暖纸色 · 书页排版 · 轻量导航"],
  b: ["B / 并排工作台", "原文、讲解与讨论并排展开。清晰分区 · 较高密度 · 持续协作"],
  c: ["C / 对话与讲义", "从问题开始，把理解留在旁边的讲义里。对话优先 · 独立文档 · 双栏联动"],
};
const original = "雨はもう上がっていた。それでも、彼女は傘を差したまま、しばらく駅の前に立っていた。";
const oldText = "「たまま」表示前一个动作完成之后，其结果状态保持不变。这里指撑着伞的状态一直持续。";
const newText = "「傘を差したまま」表示撑伞后，这个状态没有改变。雨已经停了，却仍然撑着伞；与「それでも」连在一起，突出行为与通常预期的反差。原文没有说明原因，不能据此断定她忘了收伞，或正在伤心。";

// Unconfirmed interaction choices are isolated here and documented in README.md.
const studyAssumptions = {
  initialMode: "review", // TBD-17: demo choice, not a product default.
  collectNeedsReview: true, // TBD-14/16/17: one possible collection flow.
};
function initialScene(ready) {
  return {
    hasDocument: ready, seedReference: ready, savedTopic: ready, revision: 1, selectedDocument: "full",
    context: false, chatHidden: false, itemsHidden: false, chatView: "thread", itemExpanded: {reference: true, collected: true},
    threads: [{id: "main", title: ready ? "「まま」与动作的持续" : "关于这段原文", mode: studyAssumptions.initialMode, messages: [], reference: "原文 · 片段 07", review: null, draft: "", summary: ready ? "「まま」关注的是撑伞后的状态，而不是动作本身一直持续。" : "围绕这段原文开始讨论。", time: ready ? "14:32" : "尚未提问"}, ...(ready ? [
      {id:"contrast", title:"与「ながら」有什么不同？", mode:"review", reference:"完整解析 · 版本 1 · 第 01 节", review:null, draft:"", time:"14:20", messages:[{role:"user",text:"如果换成「ながら」，表达的重点会有什么变化？"},{role:"agent",text:"「まま」关注原有状态没有改变；「ながら」更强调两个动作同时进行。本句先交代雨已经停了，所以「まま」使仍然撑伞的反差更明显。"}]},
      {id:"context",title:"把语境与推测的边界补充进讲解",mode:"review",reference:"完整解析 · 版本 1 · 第 01 节",draft:"",time:"14:16",messages:[{role:"user",text:"请补充雨停之后仍然撑伞的反差，同时提醒我不要直接推断她的情绪。"},{role:"agent",text:"修改方案已经准备好。会补充语境中的反差，并保留原文没有说明原因的限定。"}],review:{kind:"edit",status:"pending",base:1,document:"full",thread:"context"}}
    ] : [])],
    thread: "main", collected: false,
  };
}
let persisted;
try { persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { persisted = null; }
let state = persisted?.version === 1 ? persisted : {version:1, direction:"a", scene:"ready", scenes:{ready:initialScene(true),start:initialScene(false)}};
if (["a","b","c"].includes(params.get("direction"))) state.direction = params.get("direction");
if (["ready","start"].includes(params.get("scene"))) state.scene = params.get("scene");
const current = () => state.scenes[state.scene];
const currentThread = () => current().threads.find((thread) => thread.id === current().thread);
function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Private browsing may disable storage. */ } }
function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("visible"), 3500);
}
function showDialog(content) {
  document.querySelector("#dialog-body").innerHTML = content;
  document.querySelector("#dialog").showModal();
}
function about() {
  showDialog(`<div class="eyebrow">FOLIO-J / A.3</div><h2>留更多空间给内容。</h2><p>基于 A 的紧凑版探索：图标竖栏、轻量工具栏、独立学习条目栏与右侧对话。讲解区切换文档；对话内返回后可以选择其他独立对话。左上角返回素材目录。</p><div class="scene-options"><button class="secondary" data-action="scene-ready">已有讲解</button><button class="secondary" data-action="scene-start">只有原文</button></div><p>所有回复、保存与审核均为本地模拟。原型仍沿用 TBD-14～17 的探索性假设。</p><div class="scene-options"><button class="secondary" data-action="reset">重置当前场景</button></div>`);
}
function grammarSection(revision = current().revision) {
  return `<div class="section-label">01 / 状态的保留</div><h2 lang="ja">傘を差したまま</h2><p>${revision > 1 ? newText : oldText}</p><div class="structure"><span class="jp" lang="ja">差す → 差した ＋ まま</span><small>撑伞 → 撑起伞之后，保持这个状态</small></div><p>这里的「た」把注意力放在动作已经发生后的状态上。接下来的「立っていた」说明她当时在做什么：<strong>站在车站前，同时保持撑着伞的状态。</strong></p><h3>和「ながら」放在一起看</h3><div class="compare"><div><b lang="ja">傘を差したまま</b><p>关注状态没有改变：伞没有收起来。</p></div><div><b lang="ja">傘を差しながら</b><p>关注两个动作同时进行：一边撑伞，一边做另一件事。</p></div></div><p>两种表达在某些场景下都能描述撑着伞做事，但叙述的焦点不同。本句前面先说雨已经停了，因此「まま」更容易让人注意到<strong>本来可以收伞，却仍未改变的状态</strong>。</p><h3>读到这里，保留一点不确定</h3><p>「それでも」连接的是预期上的反差。我们知道她没有收起伞，但还不知道为什么。至于是出神、等待，还是另有心事，需要更多语境才能判断。</p>`;
}
function topicSection() {
  return `<div class="section-label">专题讲解 / 来自讨论整理</div><h2>「まま」强调的是留下来的状态</h2><p>在「傘を差したまま、しばらく駅の前に立っていた」中，她站在车站前时，撑伞后的状态一直保留着。</p><p>「まま」不单独断言动作一直在进行。这里要把<strong>撑起伞这个动作</strong>，和<strong>伞仍撑着的状态</strong>区分开。后面的「立っていた」才是对当时持续行为的描述。</p><div class="structure"><span class="jp" lang="ja">雨はもう上がっていた。それでも…</span><small>雨已经停了。尽管如此……</small></div><p>前一句让人预期她会收起伞；「それでも」与「まま」使这种预期和实际情况之间的反差变得突出。</p><p>这段文字没有交代原因。可以感受到反常，却不能仅凭这个表达判断她的情绪或动机。</p>`;
}
function itemsContent() {
  const s = current();
  return `${s.seedReference || s.collected ? `${s.seedReference ? `<article class="occurrence"><div class="occurrence-title"><b lang="ja">それでも</b><span class="pill">表达 · 仅参考</span></div><p>尽管如此，后面仍出现与通常预期不同的情况。</p><p lang="ja">雨はもう上がっていた。<mark>それでも</mark>、彼女は傘を差したまま、しばらく駅の前に立っていた。</p><details data-item="reference" ${s.itemExpanded.reference ? "open" : ""}><summary>查看原讲解 · 片段完整解析 / 版本 1 / 第 02 节</summary><div class="prose"><div class="section-label">02 / 与预期不同</div><h2 lang="ja">それでも</h2><p>「それ」承接前面“雨已经停了”的情况；「でも」引出与通常预期不同的行为。可以理解为“尽管如此，她仍然撑着伞”。</p><p>这是一种语境中的反差，不等于严格的逻辑矛盾。收不收伞仍可能有其他原因，原文没有给出。</p></div></details><button class="text-button" data-action="open-full">回到完整讲解 ↗</button></article>` : ""}${s.collected ? `<article class="occurrence"><div class="occurrence-title"><b lang="ja">たまま</b><span class="pill">语法 · 已收录</span></div><p>原文形式：傘を差したまま</p><details data-item="collected" ${s.itemExpanded.collected ? "open" : ""}><summary>查看原讲解 · ${s.collectionDocument === "topic" ? "「まま」专题讲解" : "片段完整解析"} / 版本 ${s.collectionRevision} / 第 01 节</summary><div class="prose">${s.collectionDocument === "topic" ? topicSection() : grammarSection(s.collectionRevision)}</div></details></article>` : ""}` : `<div class="empty-state"><h2>值得积累的，慢慢留下。</h2><p>这里会显示关联原文与已保存讲解的学习点。现在可以直接开始讨论。</p><button class="text-button" data-action="focus-question">围绕原文提问 →</button></div>`}`;
}
function readingContent() {
  const s = current();
  if (!s.hasDocument && !s.savedTopic) return `<div class="empty-state"><div class="empty-mark">読</div><h2>从一句话，慢慢读懂。</h2><p>可以先问一个在意的问题，也可以留下一份完整讲解。按这次阅读的需要开始。</p><div class="empty-actions"><button class="primary" data-action="focus-question">${icon("chat")} 直接提问</button><button class="secondary" data-action="generate">生成并保存完整讲解</button></div><div class="empty-hint">片段已保存 · 随时可以回来继续</div></div>`;
  return `<div class="document-bar"><span>${s.selectedDocument === 'topic' ? '专题讲解 · 版本 1' : `片段完整解析 · 版本 ${s.revision}`}</span><button class="text-button" data-action="history">${icon("check")} 已保存</button></div><article class="prose">${s.selectedDocument === "topic" ? topicSection() : `<p class="translation">雨已经停了。尽管如此，她仍撑着伞，在车站前站了一会儿。</p>${grammarSection()}`}<div class="section-actions"><button class="text-button" data-action="ask-section">${icon("chat")} 围绕「まま」提问</button><button class="text-button" data-action="collect">${icon("plus")} ${s.collected ? "查看已收录条目" : "收录这个用法"}</button></div>${s.selectedDocument === "full" ? `<div class="section-label">02 / 与预期不同</div><h2 lang="ja">それでも</h2><p>「それ」承接前面“雨已经停了”的情况；「でも」引出与通常预期不同的行为。可以理解为“尽管如此，她仍然撑着伞”。</p><p>这是一种语境中的反差，不等于严格的逻辑矛盾。收不收伞仍可能有其他原因，原文没有给出。</p>` : ""}</article>`;
}
function reviewCard() {
  const review = currentThread().review;
  if (!review || review.thread !== current().thread) return "";
  if (review.status !== "pending") return `<div class="review-result">${review.status === "accepted" ? (review.kind === "edit" ? `✓ 已保存为版本 ${current().revision} · 旧版本仍保留` : "✓ 已收录 · 原文与讲解出处已关联") : "方案已拒绝 · 原有内容保持不变"}</div>`;
  return `<section class="review" aria-label="待审核方案"><div class="review-head"><span>● 等待审核</span><span>尚未写入</span></div><h3>${review.kind === "edit" ? "补充「まま」的语境与限定" : "收录「たまま」这个用法"}</h3><p>目标：${review.document === "topic" ? "「まま」专题讲解" : "片段完整解析"} · 版本 ${review.base} · 第 01 节</p>${review.kind === "edit" ? `<div class="before"><small>原内容</small>${oldText}</div><div class="after"><small>拟保存内容</small>${newText}</div>` : `<div class="after"><small>原文 → 讲解出处</small>傘を差したまま<br>「たまま」· 语法 · 状态：已收录<br>引用：版本 ${review.base} / 第 01 节</div>`}<div class="review-buttons"><button class="primary" data-action="approve">同意${review.kind === "edit" ? "并保存" : "收录"}</button><button class="secondary" data-action="reject">拒绝</button></div></section>`;
}
function starterMessages() {
  if (current().thread !== "main") return currentThread().messages.length ? "" : `<div class="message agent"><div class="message-label"><span class="ai-dot">✳</span> FOLIO</div><p>一个新的讨论。可以围绕原文提问，也可以选择一份讲解作为参考。</p></div>`;
  if (state.scene === "start") return `<div class="message agent"><div class="message-label"><span class="ai-dot">✳</span> FOLIO</div><p>这段原文已经在这里了。</p><p>比如，可以从「雨停了，为什么还用了『まま』？」开始。</p><div class="message-source">参考资料：原文 · 片段 07</div></div>`;
  return `<div class="message user"><div class="message-label">你 <span>· 14:32</span></div><p>这里的「まま」是在说她一直做同一个动作吗？</p></div><div class="message agent"><div class="message-label"><span class="ai-dot">✳</span> FOLIO <span>· 14:32</span></div><p>更准确地说，它强调的是<strong>一个状态一直没有改变</strong>。</p><p>「差した」是撑起伞；「差したまま」则是撑起伞之后，伞仍然撑着。她在车站前站着时，保留着这个状态。</p><p>再结合前面的「雨已经停了」，这里会让人注意到：她仍没有收伞。但为什么没有收，原文还没有告诉我们。</p><div class="message-source">参考：片段 07 · 完整解析 / 版本 1 / 第 01 节</div>${!current().savedTopic ? `<button class="saved-card" data-action="save-topic">${icon("file")}<span>把这个理解整理成讲解<small>保存为独立文档，之后可以直接重读 ↗</small></span></button>` : ""}</div>`;
}
function railButton(action, glyph, label, active = false) {
  return `<button class="rail-button${active ? ' selected' : ''}" data-action="${action}" aria-label="${label}" title="${label}" ${["toggle-items", "threads"].includes(action) ? `aria-expanded="${active}"` : active ? 'aria-current="page"' : ''}>${icon(glyph)}<span class="rail-tooltip">${label}</span></button>`;
}
function threadStatus(thread) {
  if (thread.review?.status === "pending") return {label: "等待审核", kind: "pending"};
  if (thread.draft?.trim()) return {label: "有草稿", kind: "draft"};
  return {label: (thread.messages.length || thread.id === "main" && state.scene === "ready") ? "可继续" : "新对话", kind: "idle"};
}
function threadSummary(thread) {
  if (thread.review?.status === "pending") return thread.review.kind === "edit"
    ? "已准备讲解的具体修改，等待你查看并决定。"
    : "已定位原文与讲解出处，等待确认收录。";
  return thread.messages.at(-1)?.text || thread.summary || "围绕这个片段开启一个新的问题。";
}
function openThread(id) {
  if (!current().threads.some(thread => thread.id === id)) return;
  current().thread = id;
  current().chatView = "thread";
  current().chatHidden = false;
  render();
}
function documentTabs() {
  const s = current();
  const tabs = [
    ...(s.hasDocument ? [{id: "full", title: "片段完整解析"}] : []),
    ...(s.savedTopic ? [{id: "topic", title: "「まま」专题讲解"}] : []),
  ];
  if (!tabs.length) return '<div class="documents-empty-label">讲解 <span>尚未保存</span></div>';
  return `<div class="document-tabs" role="tablist" aria-label="已保存讲解">${tabs.map(doc => `<button role="tab" id="document-tab-${doc.id}" data-document="${doc.id}" aria-controls="reading-panel" aria-selected="${s.selectedDocument === doc.id}" tabindex="${s.selectedDocument === doc.id ? 0 : -1}">${icon('file')}<span>${doc.title}</span></button>`).join('')}</div>`;
}
function itemsPanel() {
  const s = current();
  return `<aside class="items-pane" aria-label="学习条目栏" ${s.itemsHidden ? 'hidden' : ''}>
    <header class="pane-header"><div><h2>学习条目</h2><span class="pane-count">${Number(s.seedReference) + Number(s.collected)}</span></div><button class="toolbar-button" data-action="toggle-items" aria-label="收起学习条目栏" title="收起学习条目栏">${icon('close')}</button></header>
    <div class="items-scroll"><p class="pane-subtitle">本片段的积累</p>${itemsContent()}</div>
    <footer class="pane-footnote">关联原文与保存时的讲解版本</footer>
  </aside>`;
}
function conversationPanel() {
  const s = current();
  const thread = currentThread();
  const pending = s.threads.filter(item => item.review?.status === 'pending').length;
  if (s.chatView === 'list') return `<aside class="aside conversation-list" aria-label="片段讨论">
    <header class="discussion-head"><div class="discussion-heading"><strong>对话</strong><span class="pane-count">${s.threads.length}</span></div><button class="toolbar-button" data-action="new-thread" aria-label="新建独立讨论" title="新建讨论">${icon('compose')}</button></header>
    <div class="thread-list-meta"><span>雨停之后 · 当前片段</span>${pending ? `<span class="pending-count">${pending} 个等待审核</span>` : ''}</div>
    <div class="thread-list" aria-label="独立对话列表">${s.threads.map(item => {
      const status = threadStatus(item);
      return `<button class="thread-card${item.id === s.thread ? ' last-opened' : ''}" data-thread="${item.id}" aria-label="打开对话：${escapeHTML(item.title)}">
        <div class="thread-card-heading"><strong>${escapeHTML(item.title)}</strong>${icon('chevron-right')}</div>
        <p>${escapeHTML(threadSummary(item))}</p>
        <div class="thread-card-meta"><span class="thread-status ${status.kind}"><i></i>${status.label}</span><span>${item.id === s.thread ? '刚刚查看' : item.time || '本次新建'}</span></div>
      </button>`;
    }).join('')}</div>
    <footer class="thread-list-footer">每个对话独立保留历史、草稿和权限。<br>返回列表不会取消已提交的任务。<span>本地交互原型 · 示例状态</span></footer>
  </aside>`;
  return `<aside class="aside conversation-detail" aria-label="片段讨论">
    <header class="discussion-head"><div class="discussion-heading"><button class="toolbar-button conversation-back" data-action="threads-list" aria-label="返回对话列表" title="返回对话列表">${icon('chevron-left')}</button><strong>对话</strong></div><button class="toolbar-button" data-action="new-thread" aria-label="新建独立讨论" title="新建讨论">${icon('compose')}</button></header>
    <div class="thread-title"><h2>${escapeHTML(thread.title)}</h2><span class="thread-status ${threadStatus(thread).kind}"><i></i>${threadStatus(thread).label}</span></div>
    <div class="reference-chip">${icon('link')}<span>参考 <strong>${escapeHTML(thread.reference)}</strong></span></div>
    <div class="messages" aria-label="讨论消息">${starterMessages()}${thread.messages.map(message => `<div class="message ${message.role}"><div class="message-label">${message.role === 'user' ? '你' : 'Folio · 示例回复'}</div><p>${escapeHTML(message.text)}</p></div>`).join('')}${s.savedTopic && thread.id === 'main' ? `<button class="saved-card" data-action="open-topic">${icon('file')}<span>「まま」专题讲解<small>已保存 · 打开阅读</small></span>${icon('chevron-right')}</button>` : ''}${reviewCard()}</div>
    <form class="composer" id="composer"><div class="quick-actions">${s.hasDocument || s.savedTopic || thread.messages.length ? `<button type="button" data-action="save-topic">${icon('plus')}保存专题讲解</button>${s.hasDocument ? '<button type="button" data-action="propose-edit">补充到完整讲解</button>' : '<button type="button" data-action="generate">生成完整讲解</button>'}` : '<button type="button" data-action="sample-question">试问「まま」的意思</button>'}</div>
      <div class="composer-box"><label class="sr-only" for="question">输入你的问题</label><textarea id="question" placeholder="围绕这段原文，继续提问…" rows="2">${escapeHTML(thread.draft || '')}</textarea><div class="composer-row"><label class="sr-only" for="permission">当前对话权限模式</label><select id="permission" ${thread.review?.status === 'pending' ? 'disabled' : ''}><option value="review" ${thread.mode === 'review' ? 'selected' : ''}>审核模式</option><option value="full" ${thread.mode === 'full' ? 'selected' : ''}>Full access</option></select><button class="send" aria-label="发送问题" type="submit">${icon('arrow')}</button></div></div><p class="demo-label">本地交互原型 · 示例回复</p>
    </form>
  </aside>`;
}
function workspaceMarkup() {
  const s = current();
  return `<div class="native-shell"><aside class="icon-rail" aria-label="工作台工具"><div class="rail-top">${railButton('exit-workbench','chevron-left','返回素材目录')}</div><nav class="rail-tools">${railButton('read','book','阅读讲解',true)}${railButton('documents','file','已保存讲解')}${railButton('toggle-items','bookmark','展开或收起学习条目',!s.itemsHidden)}${railButton('threads','chat','查看对话列表',!s.chatHidden)}</nav><div class="rail-bottom">${railButton('settings','settings','学习设置')}${railButton('about','more','原型说明与场景')}</div></aside>
    <main class="workspace"><header class="native-toolbar"><div class="toolbar-title"><strong>雨停之后</strong><span>雨の日のこと <i>/</i> 片段 07</span></div><div class="toolbar-actions"><span class="save-state">${icon('check')} 已保存</span><button class="toolbar-button${s.itemsHidden ? '' : ' is-on'}" data-action="toggle-items" aria-label="${s.itemsHidden ? '展开学习条目栏' : '收起学习条目栏'}" aria-pressed="${!s.itemsHidden}" title="学习条目栏">${icon('bookmark')}</button><button class="toolbar-button${s.chatHidden ? '' : ' is-on'}" data-action="toggle-chat" aria-label="${s.chatHidden ? '展开讨论' : '收起讨论'}" aria-pressed="${!s.chatHidden}" title="对话栏">${icon('split')}</button><button class="toolbar-button" data-action="about" aria-label="查看原型说明" title="原型说明与场景">${icon('more')}</button></div></header>
    <div class="canvas"><section class="reading" aria-label="原文与讲解"><div class="reading-inner">
      <div class="source-text"><div class="source-caption"><span>原文</span><button class="text-button" data-action="context" aria-expanded="${s.context}">${s.context ? '收起语境' : '语境'} ${icon('chevron-down')}</button></div><p class="japanese" lang="ja">雨はもう上がっていた。それでも、彼女は<button class="highlight" data-action="select-source" aria-label="选择原文「傘を差したまま」并提问">傘を差したまま</button>、しばらく駅の前に立っていた。</p>${s.context ? '<p class="context">用户提供的语境：故事发生在一次雨后，她正在车站前等人。仅用于理解，不属于目标原文。</p>' : ''}</div>
      <div class="reading-controls">${documentTabs()}</div><div id="reading-panel" ${s.hasDocument || s.savedTopic ? `role="tabpanel" aria-labelledby="document-tab-${s.selectedDocument}"` : 'role="region" aria-label="讲解"'}>${readingContent()}</div><div class="endnote">${icon('check')} 所有讲解均保存在此片段下</div>
    </div></section>${itemsPanel()}${conversationPanel()}</div></main></div>`;
}
const scrollPositions = new Map();
let lastPaneKeys = null;
function paneKeys() {
  return {
    ".reading": `${state.scene}:document:${current().selectedDocument}`,
    ".items-scroll": `${state.scene}:items`,
    ".messages": `${state.scene}:thread:${current().thread}`,
    ".thread-list": `${state.scene}:list`,
  };
}
function render() {
  if (lastPaneKeys) for (const [selector, key] of Object.entries(lastPaneKeys)) {
    const element = document.querySelector(selector);
    if (element && element.offsetParent !== null) scrollPositions.set(key, element.scrollTop);
  }
  const s = current();
  const thread = currentThread();
  document.body.className = `native${s.chatHidden ? ' chat-hidden' : ''}${s.itemsHidden ? ' items-hidden' : ''}`;
  const count = Number(s.hasDocument) + Number(s.savedTopic);
  if (state.home) {
    document.querySelector('#app').innerHTML = `<div class="home-shell"><aside class="home-nav"><div class="home-brand">Folio<span>J</span></div><button class="home-nav-item selected" data-action="sources">${icon('book')}素材目录</button><button class="home-nav-item" data-action="library-home">${icon('library')}学习积累</button><div class="home-bottom"><button data-action="settings">${icon('settings')} 设置</button></div></aside><main class="home-main"><header><span>素材目录</span><button class="toolbar-button" data-action="about" aria-label="查看原型说明">${icon('more')}</button></header><section><p class="home-kicker">继续阅读</p><h1>你的日语，一点点积累。</h1><p class="home-description">从原文出发，留下值得重读的理解。</p><article class="source-entry"><div class="book-cover" lang="ja">雨の日<br>のこと<span>READING NOTES</span></div><div><small>随笔 · 自编示例素材</small><h2>雨の日のこと</h2><p>1 个片段 · ${count} 份讲解</p><button class="primary" data-action="enter-workbench">继续阅读 ${icon('chevron-right')}</button></div></article><div class="recent-heading">最近的片段</div><button class="recent-row" data-action="enter-workbench"><span class="recent-icon">${icon('file')}</span><span><strong>雨停之后</strong><small lang="ja">雨はもう上がっていた。それでも…</small></span><span class="recent-meta">片段 07</span>${icon('chevron-right')}</button></section><footer>本地视觉原型 · 此页仅演示退出工作台后的导航变化</footer></main></div>`;
    lastPaneKeys = null;
    persist();
    return;
  }
  document.querySelector('#app').innerHTML = workspaceMarkup();
  lastPaneKeys = paneKeys();
  for (const [selector, key] of Object.entries(lastPaneKeys)) {
    const element = document.querySelector(selector);
    if (element) element.scrollTop = scrollPositions.get(key) || 0;
  }
  persist();
}
function rerenderChat(message) { render(); const messages = document.querySelector(".messages"); if (messages) messages.scrollTop = 999999; if (message) toast(message); }
function focusQuestion(text = "") {
  current().chatHidden = false;
  current().chatView = "thread";
  render();
  const input = document.querySelector("#question");
  if (text) { input.value = text; currentThread().draft = text; persist(); }
  input.focus();
  if (innerWidth < 850) input.scrollIntoView({behavior:"smooth",block:"center"});
}
function requestReview(kind) {
  const s = current();
  s.chatHidden = false;
  s.chatView = "thread";
  if (currentThread().review?.status === "pending") { rerenderChat("请先处理已有的待审核方案"); return; }
  if (kind === "edit" && s.revision > 1) { toast("本示例的语境补充已保存，可查看历史版本"); return; }
  currentThread().review = {kind, status:"pending", base:kind === "collect" && s.selectedDocument === "topic" ? 1 : s.revision, document:kind === "edit" ? "full" : s.selectedDocument, thread:s.thread};
  if (currentThread().mode === "full" || (kind === "collect" && !studyAssumptions.collectNeedsReview)) {
    applyReview();
  } else rerenderChat("具体方案已准备好，尚未写入");
}
function applyReview() {
  const s = current();
  if (currentThread().review?.status !== "pending") return;
  if (currentThread().review.document !== "topic" && currentThread().review.base !== s.revision) { currentThread().review = null; rerenderChat("基础版本已变化，请重新准备方案"); return; }
  currentThread().review.status = "accepted";
  if (currentThread().review.kind === "edit") { s.revision += 1; s.selectedDocument = "full"; }
  else { s.itemsHidden = false; s.collected = true; s.collectionRevision = currentThread().review.base; s.collectionDocument = currentThread().review.document; }
  rerenderChat(currentThread().review.kind === "edit" ? "已保存为版本 2，版本 1 保留" : "已收录，并关联到确定的讲解版本");
}
const actions = {
  about,
  "exit-workbench": () => { state.home = true; render(); },
  "enter-workbench": () => { state.home = false; render(); },
  "scene-ready": () => { state.scene = "ready"; document.querySelector("#dialog").close(); render(); },
  "scene-start": () => { state.scene = "start"; document.querySelector("#dialog").close(); render(); },
  read: () => { document.querySelector(".reading").scrollIntoView({block:"start"}); },
  documents: () => showDialog(`<h2>已保存讲解</h2><p>雨停之后 · 当前片段</p><div class="document-list">${current().hasDocument ? '<button class="saved-card" data-action="choose-full">片段完整解析<span>打开 →</span></button>' : ''}${current().savedTopic ? '<button class="saved-card" data-action="choose-topic">「まま」专题讲解<span>打开 →</span></button>' : ''}${!current().hasDocument && !current().savedTopic ? '<p>还没有讲解，可以先围绕原文讨论。</p>' : ''}</div>`),
  "choose-full": () => { document.querySelector("#dialog").close(); actions["open-full"](); },
  "choose-topic": () => { document.querySelector("#dialog").close(); actions["open-topic"](); },
  "threads-list": () => { current().chatView = "list"; render(); },
  "toggle-items": () => { current().itemsHidden = !current().itemsHidden; render(); },
  "library-home": () => { state.home = false; current().itemsHidden = false; render(); },
  "toggle-chat": () => { current().chatHidden = !current().chatHidden; render(); },
  context: () => { current().context = !current().context; render(); },
  "focus-question": () => focusQuestion(),
  "select-source": () => { currentThread().reference = "原文选段 · 傘を差したまま"; focusQuestion("这里的「まま」是在说她一直做同一个动作吗？"); },
  "ask-section": () => { currentThread().reference = `${current().selectedDocument === "topic" ? "「まま」专题讲解 · 版本 1" : `完整解析 · 版本 ${current().revision}`} · 第 01 节`; focusQuestion("能再解释一下状态持续和动作持续的区别吗？"); },
  "sample-question": () => focusQuestion("这句里的「まま」是什么意思？"),
  generate: () => { current().hasDocument = true; current().selectedDocument = "full"; render(); toast("示例完整讲解已保存，可以直接阅读或继续讨论"); },
  "save-topic": () => { current().savedTopic = true; current().selectedDocument = "topic"; rerenderChat("已整理为独立专题讲解，未自动收录学习条目"); },
  "open-topic": () => { current().selectedDocument = "topic"; render(); document.querySelector(".document-bar")?.scrollIntoView({block:"nearest"}); },
  "open-full": () => { current().selectedDocument = "full"; render(); },
  "propose-edit": () => requestReview("edit"),
  collect: () => { if(current().collected) { current().itemsHidden = false; render(); } else requestReview("collect"); },
  approve: applyReview,
  reject: () => { if(currentThread().review?.status !== "pending") return; currentThread().review.status = "rejected"; rerenderChat("已拒绝方案，正式讲解与条目保持不变"); },
  "new-thread": () => { const s = current(); const id = `thread-${s.threads.length + 1}`; s.threads.push({id,title:`新的讨论 ${s.threads.length + 1}`,mode:studyAssumptions.initialMode,messages:[],reference:"原文 · 片段 07",review:null,draft:""}); s.thread = id; s.chatView = "thread"; s.chatHidden = false; rerenderChat("已新建独立讨论，未带入其他讨论的历史"); },
  threads: () => { current().chatHidden = false; current().chatView = "list"; render(); if(innerWidth < 1000) document.querySelector(".aside").scrollIntoView({block:"start"}); },
  history: () => showDialog(`<h2>讲解的保存记录</h2><p>${current().selectedDocument === "topic" ? "「まま」专题讲解 · 版本 1<br>从讨论整理为可以独立阅读的文档。" : `片段完整解析 · 当前版本 ${current().revision}<br>每次修改留下新版本，条目仍引用收录时的版本。`}</p>${current().revision > 1 && current().selectedDocument === "full" ? `<h3>版本 1 · 第 01 节原内容</h3><p>${oldText}</p><h3>版本 2 · 修改后的内容</h3><p>${newText}</p>` : ""}<p>本原型仅模拟当前设备上的保存。</p>`),
  sources: () => showDialog(`<h2>雨の日のこと</h2><p>随笔 · 自编示例素材</p><p>片段 07 — 雨停之后<br><span lang="ja">${original}</span></p><p>本轮聚焦片段工作台。素材目录的完整页面将在方向确定后继续探索。</p>`),
  library: () => { current().itemsHidden = false; render(); },
  settings: () => showDialog("<h2>学习设置</h2><p>本例使用中文讲解，偏好是保留必要推导、表达对比和不确定性。</p><p>模型、Provider 与长期偏好设置不在这轮工作台视觉探索范围内。每个讨论下方可以体验权限模式的切换。</p>"),
  reset: () => { state.scenes[state.scene] = initialScene(state.scene === "ready"); document.querySelector("#dialog").close(); render(); toast("当前场景已恢复初始状态"); },
};
document.addEventListener("click", (event) => {
  const direction = event.target.closest("[data-direction]");
  if (direction) { state.direction = direction.dataset.direction; const url = new URL(location.href); url.searchParams.set("direction", state.direction); history.replaceState(null,"",url); render(); return; }
  const doc = event.target.closest("[data-document]");
  if (doc) { current().selectedDocument = doc.dataset.document; render(); return; }
  const thread = event.target.closest("[data-thread]");
  if (thread) { openThread(thread.dataset.thread); return; }
  const action = event.target.closest("[data-action]");
  if (action && actions[action.dataset.action]) actions[action.dataset.action]();
});
document.addEventListener("change", (event) => {
  const value = event.target.value;
  if (event.target.id === "scene") { state.scene = value; const url = new URL(location.href); url.searchParams.set("scene",value); history.replaceState(null,"",url); render(); }
  if (event.target.id === "document-select") { current().selectedDocument = value; render(); }
  if (event.target.id === "thread-select") openThread(value);
  if (event.target.id === "permission") { currentThread().mode = value; persist(); toast(value === "full" ? "当前讨论已切换为 Full access，普通问答仍不会修改内容" : "当前讨论已切换为审核模式"); }
});
document.addEventListener("toggle", (event) => {
  if (event.target.dataset?.item) { current().itemExpanded[event.target.dataset.item] = event.target.open; persist(); }
}, true);
document.addEventListener("keydown", (event) => {
  if (!event.target.dataset?.document || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const documents = [current().hasDocument && "full", current().savedTopic && "topic"].filter(Boolean);
  event.preventDefault();
  const index = documents.indexOf(current().selectedDocument);
  current().selectedDocument = documents[event.key === "Home" ? 0 : event.key === "End" ? documents.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + documents.length) % documents.length];
  render();
  document.querySelector(`#document-tab-${current().selectedDocument}`).focus();
});
document.addEventListener("input", (event) => { if(event.target.id === "question") { currentThread().draft = event.target.value; persist(); } });
document.addEventListener("submit", (event) => {
  if (event.target.id !== "composer") return;
  event.preventDefault();
  const input = document.querySelector("#question");
  const question = input.value.trim();
  if (!question) { input.focus(); return; }
  currentThread().draft = "";
  currentThread().messages.push({role:"user",text:question});
  currentThread().messages.push({role:"agent",text:"【预写示例】「まま」强调撑起伞之后，状态没有改变。结合雨已经停了的前文，叙述突出她仍然撑伞的反差，但没有交代原因。这次问答没有自动保存讲解或收录学习条目。"});
  rerenderChat();
});

render();
