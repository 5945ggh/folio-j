# Folio-J

Lingua Portfolio - Japanese

围绕原版日语片段阅读、讨论，并积累可独立阅读的讲解和有出处的学习条目。当前已实现来源与片段管理，以及学习背景、讲解预设、模型接入和文本验证设置；片段讨论、独立讲解与学习积累将在后续切片实现。当前手动录入片段，不接入或管理素材文件。

## 本地开发

准备 Python 3.11、Node.js 24、uv、pnpm 10 和 just。Python 默认版本同时固定在根目录和 `backend/.python-version`，确保 `uv --project backend` 及后端目录内的命令使用同一版本；Node 版本见 `.nvmrc`。Python 包最低支持 3.11，依赖分别锁定在 `backend/uv.lock` 和 `frontend/pnpm-lock.yaml`。

```sh
just setup       # 安装锁定依赖
just dev         # 初始化／升级数据库，FastAPI + Vite 热重载，Ctrl-C 一并停止
```

开发页面：[127.0.0.1:5173](http://127.0.0.1:5173)；API 文档：[127.0.0.1:8000/api/docs](http://127.0.0.1:8000/api/docs)。从来源目录新建来源、手动录入日文片段，再打开片段阅读与编辑；数据通过真实 API 保存在本地 SQLite。后端绑定 `127.0.0.1`。

```sh
just lint        # Ruff、pyright strict、Biome、TypeScript
just test        # 后端与前端纯逻辑测试，禁止真实网络和模型调用
just gen-api     # 本地导出 OpenAPI 并生成前端类型，不需启动服务
just migrate     # 从空库建立当前 schema，或执行已有迁移
just start       # 初始化／升级数据库并构建前端，由 FastAPI 在 8000 端口托管
just check       # lint + test + build + 文档链接检查
just check-assets # 验证保留的实验和静态原型
```

可将 [config/app.example.toml](config/app.example.toml) 复制为 `config/app.toml`，调整服务端口和数据库路径；不复制时使用同样的默认值。相对数据库路径以仓库根目录为基准，默认数据位于 `data/app.db`。`just dev` 的前端代理随后端配置端口变化。真实配置、数据库、缓存和密钥不提交。

可用 `FOLIO_J_DATABASE_PATH` 覆盖数据库路径，供临时验收或独立数据集使用；迁移和应用读取同一覆盖值。第一版发布前且数据可丢弃时，允许重整初始迁移及重建开发库；应用不会自动删库。开始积累需要保留的日常数据或正式发布后，采用增量迁移，重建前应先保留所需数据。

`just dev` 和 `just start` 使用同一后端端口，应选择一种运行方式。OpenAPI 与前端生成类型一并提交，修改后端 schema 后运行 `just gen-api`；不要手改生成类型。

## 模型设置

模型设置入口为 `/settings`，提供 Provider、模型、学习背景及讲解预设维护。「验证普通文本」和「验证流式文本」各发起一次短模型调用，可能产生 Provider 费用；结果保存在最近验证中，刷新页面不重复调用。列表获取成功不代表文本、结构化输出或工具能力均已验证。

密钥输入去除首尾空白，只保存在数据库旁的 `<数据库文件名>.secrets/` 私有目录（目录0700、文件0600），不进入普通API响应、Run或Git；编辑留空保持原密钥，清除需显式操作。这是本机文件权限保护，不是加密存储。保留配置时需同时妥善保管数据库及对应凭据目录；旧凭据暂保留以支撑已接受请求的固定引用。

验证在本地后台执行，页面关闭不取消；服务关闭或重启使未完成验证标为中断，不自动重放。每次操作一次调用、60秒超时、最多两次并发；重试需明确发起。配置变更后旧的能力验证不冒充新配置结果。Provider 停用只阻止新验证，运行中删除会被拒绝。当前设置页不是学习对话入口。

## 开始阅读

- [文档导航](docs/README.md)：PRD、领域术语、架构和技术选型等长期规范。
- [阶段性交接](docs/handovers/README.md)：当前实施基线、开发准备与归档任务书。
- [研究材料](references/README.md)：可复核的原句、解析示例、提取和阅读实验。
- [第一阶段：素材与片段管理](docs/handovers/archived/STAGE_1_SOURCE_SEGMENT.md)：已交付范围、接口和验收记录。
- [工作台视觉基线](prototypes/reading-native/VISUAL_BASELINE.md)：正式界面的风格与布局参考；具体交互按实际功能设计，原型中的模拟行为不替代 PRD。

参与开发前请阅读 [AGENTS.md](AGENTS.md)。产品行为以 PRD 为准，实验和原型保留各自的历史边界。
