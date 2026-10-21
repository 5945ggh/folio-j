# 阅读器 R1.1 实施计划

> 历史阶段资料（2026-10-20 归档）。现行规则见[PRD](../../../PRD.md)与[架构](../../../ARCHITECTURE.md)，当前交付和未完成验收见[实施基线](../../MVP_IMPLEMENTATION_BASELINE.md)。

本轮依据本地交接包定稿，实施真实 `/materials/:id`，不替换 EPUB 引擎。验收结果与未验证事项另记 [ACCEPTANCE](ACCEPTANCE.md)，实际数据契约见 [API](API.md)。2026-10-06 后续用户反馈的交互优化另记 [INTERACTION_POLISH](INTERACTION_POLISH.md)，不改写原验收结论。

当前交付与提交状态见 [MVP 实施基线](../../MVP_IMPLEMENTATION_BASELINE.md)。

## 实施起点

2026-10-05 起始分支 `codex/sources-s2`，HEAD `079b56f80d09e4d2abc66c1844f53d18713ffaa6`；新分支 `codex/reader-r1`。开始已有 S2 未提交变更：GLOSSARY、INFORMATION_ARCHITECTURE、PRD、MVP_IMPLEMENTATION_BASELINE、阶段索引、SourcePages、catalog/SourceViews、hooks、state 及测试、main；未跟踪 sources-s2 交接目录、SourceDirectory、SourceOverview、source-content.css、sources-s2.css、repomix-output.xml。完整保留，不视作本轮新增。

实施起点的源码与交接导航一致：真实章节按 part 使用无脚本同源 sandbox iframe；已有文本投影、串行 revision 保存、布局恢复、opened 去重。当时仍使用应用 Shell，搜索及图库尚无正式接口。

## 切片和回归关口

1. A：独立 Reader 外壳、真实来处返回、加载与错误页；接入跨 iframe 的专注控制器与主题。
2. B：新增浏览器偏好、字体／宽度／原书 ruby；保留原位置输入三项设置及稳定锚点恢复，定向约束图片。
3. C：服务端派生只读分页搜索／图库，固定版本与资源出现身份，生成客户端，再接查询面板、显式导航和单个返回点。
4. D：共享三斜线占位小改；独立测试库、真实生产构建浏览器验收、综合检查和文档收口。

回归先使用已有 position／viewport／persistence／usage 与 EPUB 测试锁定行为；新纯逻辑与只读接口补针对性测试。清理仅拆 Reader 自有布局，保留 reader-refresh.css 内工作台／设置规则。主代理负责主阅读器与集成，独立子代理负责服务查询、交互纯逻辑、搜索图库面板，互不覆盖文件。

所有迁移／导入和浏览器写入仅使用 `temp/reader-r1-acceptance/app.db`；不访问日常库进行写入。样书使用本地已提供 EPUB，商业书内容和截图仅留在 gitignored temp。

## 工程决定

- 无新增领域表或第三方依赖；新增 UI 偏好保存在浏览器，不扩充严格位置 DTO。
- theme／ruby 呈现原地更新；几何设置沿用原恢复队列。高亮使用 DOM Range 与 CSS Highlight，不改变定位叶子。
- 新接口按材料／版本可见性校验，服务层离线程扫描不可变编译包；响应分页有界。
- 不修改 TBD 产品边界、不 push、不公开部署。
