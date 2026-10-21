# 前端调整实施计划

> 历史阶段资料（2026-10-20 归档）。现行规则见[PRD](../../../PRD.md)与[架构](../../../ARCHITECTURE.md)，当前交付和未完成验收见[实施基线](../../MVP_IMPLEMENTATION_BASELINE.md)。

> 2026-10-04 实施安排。先规范后实施；FUTURE_NOTES 不执行。验收证据和范围见 [ACCEPTANCE.md](ACCEPTANCE.md)，当前交付与提交状态见 [MVP 实施基线](../../MVP_IMPLEMENTATION_BASELINE.md)。

| 增量 | 范围 | 验证关口 |
| --- | --- | --- |
| A 外壳与契约 | 同步长期规范；统一导航／样式；目录、状态与返回契约 | 旧入口可达；增量迁移保留旧数据 |
| B 素材库 | 真实 EPUB 目录、组合筛选排序分页、封面、导入及状态 | 导入→打开→返回；完成持久化与状态竞争 |
| C Source | 素材／片段／讲解、全部书籍窗口、确切修订直达 | 窗口→读书→返回原窗口；刷新、后退、焦点 |
| D 阅读与工作台 | 紧凑阅读工具、工作台与设置一致化 | 重排、草稿、审核、停止及迟到成果回归 |
| E 整体验收 | 独立数据库、宽窄视口、异常、构建及交付证据 | 新命令结果与真实截图；日常库不污染 |

## 小范围重构计划与现有覆盖

先锁行为再按侧栏、目录展示、阅读工具逐项调整；复用现有导航、API、阅读持久化函数，提取职责清楚的共享组件，不建万能媒体框架，不加新状态库。业务仍在 services，DTO 由 OpenAPI 生成。主代理负责集成，本代理只写 docs。

现有前端覆盖：materials/viewport.test.ts、position.test.ts、persistence.test.ts；chat/navigation.test.ts、discussion.test.ts、layout.test.ts、review.test.ts、state.test.ts；analysis/links.test.ts、state.test.ts；settings/verification.test.ts。后端已有 test_materials.py、test_material_migration.py、test_epub_compiler.py、test_chat_races.py 及 Analysis／审核测试。它们仅为回归基础，不是本轮通过证据。

新增测试覆盖完整结果筛选排序分页、最近打开空值末尾、状态版本／重复打开／迟到响应、旧数据保留、删除门禁、返回路径校验与查询恢复。浏览器补足模态焦点、真实返回窗口、阅读重排和工作台挂载行为。

## 施工默认

仅真实书籍类型、必需网格；书籍／Source／讲解标题升序，片段创建时间降序；每页 50、上限 100；概览最多 6 本；最近打开空值双向置后，ID 升序破同值。标题采用 NFC 后 SQLite BINARY 确定序，不承诺自然卷序／拼音序。侧栏宽屏保存宽窄偏好，窄屏临时抽屉。历史有效位置初始化进行中，其余未开始，历史打开时间为空，不推断完成。

## 证据与范围

完成前执行 just gen-api、just lint、just test、just build、just check-docs、git diff --check。迁移仅在空／旧版本测试库验证；浏览器独立数据库，不用真实模型／外网。1440×900、1280×800、1024 宽、390×844 真实截图。未验证项保留缺口。本轮不关闭 TBD，不实现注音、选区学习、Lexeme、Occurrence、播放器、扫描、MCP 或统一预处理。无新依赖不预改 TECH_STACK。

API 收口见 [API.md](API.md)，验收见 [ACCEPTANCE.md](ACCEPTANCE.md)。
