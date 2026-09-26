# 第一阶段：素材与片段管理

状态：已完成并验收（2026-09-26）。范围依据 PRD F2；本切片交付真实录入、管理和重读，不包含模型调用、讲解、候选或对话功能。

## 交付范围

- 素材目录：创建、查看、编辑 Source，显示其未删除片段数。
- 来源详情：查看片段列表，录入目标原文及可选译文、前后文、听写、管理备注和出处。
- 片段详情：重读、编辑及删除；刷新、直接访问详情 URL、服务重启后数据保留。
- 删除前展示具体对象和当前影响范围，用户确认后执行。Source 删除同时隐藏其片段；其他来源不受影响。
- 原型仅作为风格和布局参考，交互按真实功能设计，不展示不能使用的 AI 操作。

## 本切片契约

- Source：`id`、`title`、`description`（来源描述）、`note`、创建／更新时间；响应另有 `segment_count`。
- Segment：`id`、`source_id`、`text`、`translation`、`context_before`、`context_after`、`transcription`、`note`（个人管理备注）、`source_ref`、创建／更新时间、`text_locked_at`。
- ID 使用 ULID 字符串；所有时间以 UTC 表达。标题去除首尾空白，1–200 字符；目标原文非空白，最多 100000 字符，保留换行和首尾空白。所有入库文本做 NFC 规范化；可选文本默认空串，最多 100000 字符。
- 未知字段和显式 null 输入拒绝。PATCH 只更新提供的字段；不可通过 API 改变归属、身份、锁定时间或删除标记。
- 首次 AI 任务接受后锁定原文的产品规则保留。本切片无 AI 任务，正常录入的片段尚未锁定；服务层拒绝修改已有锁定原文（409），允许更新附带信息。锁定的事务边界随 AI 切片实现，不提供手动锁定接口。
- Source、Segment 使用 `deleted_at` 逻辑删除，列表和详情排除已删除对象；没有恢复入口。删除 Source 在同一事务内标记其全部存活 Segment。本切片没有讲解、对话和条目，未来加入时扩展同一删除服务的范围及影响预览。
- 列表按创建时间及 ID 倒序，返回数组；本地首阶段不增加分页、搜索或目录层级。

## API 与页面

| API | 契约 |
|---|---|
| `GET /api/sources` | `SourceResponse[]` |
| `POST /api/sources` | `SourceCreate` → 201 `SourceResponse` |
| `GET /api/sources/{source_id}` | `SourceResponse` |
| `PATCH /api/sources/{source_id}` | `SourceUpdate` → `SourceResponse` |
| `GET /api/sources/{source_id}/delete-impact` | `{source_id, title, segment_count}` |
| `DELETE /api/sources/{source_id}` | 204 |
| `GET /api/sources/{source_id}/segments` | `SegmentResponse[]` |
| `POST /api/sources/{source_id}/segments` | `SegmentCreate` → 201 `SegmentResponse` |
| `GET /api/segments/{segment_id}` | `SegmentResponse` |
| `PATCH /api/segments/{segment_id}` | `SegmentUpdate` → `SegmentResponse` |
| `DELETE /api/segments/{segment_id}` | 204 |

不存在及已删除对象返回 404，输入校验返回 422，原文锁定冲突返回 409。错误信息可在页面展示，失败后保留输入并允许重试。前端仅使用生成的 API 类型及 TanStack Query。

页面为 `/`（目录）、`/sources/:id`（来源详情）、`/segments/:id`（片段阅读）。创建与编辑可使用页内表单；删除需明确确认及取消。窄屏可完成相同核心操作。

## 开发和数据库策略

使用 `main` 加短期 `codex/*` 功能分支；main 保持通过检查。独立子任务才并行，开发与验证分工，集成后统一验收。

第一版发布前且本地数据可丢弃时，保留 Alembic 基础并允许重整初始迁移，不维护所有开发中间 schema 的升级路径。空库须能用 `just migrate` 建立当前 schema；不在应用启动时自动删库。需要保留的日常数据出现或第一版发布后，切换为增量迁移。重建前由操作者明确选择可丢弃数据库，不由启动脚本擅自清空。

## 验收

1. 创建两份来源及多个片段，正确显示归属与计数；编辑、刷新、重启后重读一致。
2. 非法空输入、未知字段、非法 null、缺失／已删除 ID 均正确拒绝；日文 NFC 和文本换行保留。
3. 锁定原文不可改，管理信息可改；客户端不能自行解除锁定。
4. 删除单片段不删除来源；删除来源仅隐藏其所属片段；取消删除无影响。
5. 使用临时 SQLite 覆盖服务/API 持久化及删除行为，测试不访问真实网络或模型。
6. `just lint`、`just test`、`just build`、`just check-docs` 通过；运行 `just gen-api` 并保留生成文件。
7. 浏览器实际验证目录、录入、编辑、直接打开、确认／取消删除及窄屏布局；只使用明确标注的测试数据。

本切片沿用 TBD-12（本地单用户）和 TBD-13（路由与 lint）占位，不实现 TBD-16/17 执行与审核契约，也不将实验 anchor 规则定为生产协议。

## 验收结果与限制

- 独立测试子代理完成 API、数据库、迁移与契约验证；主代理集成运行 `just check`，17 项离线测试、Ruff／pyright／Biome／tsc、生产构建及文档链接检查均通过。最终前端错误提示修正后另行通过 lint、typecheck 与 build。
- `just gen-api` 已重新生成 OpenAPI 与前端类型。PATCH 字段可省略但不可 null，回归测试同时检查声明和运行时行为。
- 浏览器使用独立临时数据库及明确标注的虚构测试数据，实际完成来源创建／编辑、片段多行日文及可选语境录入／编辑、非法空白拒绝、刷新及服务重启后重读、删除确认／取消、单片段删除与来源级联删除隔离，以及旧链接的已删除提示。
- 390px 窄屏阅读、桌面阅读均经截图检查。停服时，已缓存的删除预览不能继续触发删除；显示一条中文连接错误，恢复服务并重试后清除旧错误，重新取得实际影响范围。
- 未新增依赖。当前列表不分页，不包含导入、AI 讨论、讲解、候选或学习积累；原文锁定的保护已测试，但首次 AI 任务接受时的原子锁定仍由后续切片实现。
- 初始迁移覆盖当前 schema；不承诺开发中间版本数据库的自动升级。测试未使用用户默认数据库，也未访问真实模型。
