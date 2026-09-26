# Folio-J

Lingua Portfolio - Japanese

围绕原版日语片段阅读、讨论，并积累可独立阅读的讲解和有出处的学习条目。当前已建立可运行的工程基础；素材管理、Agent 和学习积累等业务功能将在后续切片实现。

## 本地开发

准备 Python 3.14、Node.js 24、uv、pnpm 10 和 just。运行时版本见 `.python-version`、`.nvmrc`；Python 包最低支持 3.11，依赖分别锁定在 `backend/uv.lock` 和 `frontend/pnpm-lock.yaml`。

```sh
just setup       # 安装锁定依赖
just dev         # FastAPI + Vite 热重载，Ctrl-C 一并停止
```

开发页面：[127.0.0.1:5173](http://127.0.0.1:5173)；API 文档：[127.0.0.1:8000/api/docs](http://127.0.0.1:8000/api/docs)。页面只验证真实本地 API 连接，不含模拟的产品功能。后端绑定 `127.0.0.1`。

```sh
just lint        # Ruff、pyright strict、Biome、TypeScript
just test        # 离线后端测试，禁止真实网络和模型调用
just gen-api     # 本地导出 OpenAPI 并生成前端类型，不需启动服务
just migrate     # 初始化或升级 SQLite；当前没有领域模型迁移
just start       # 构建前端，由 FastAPI 在 8000 端口托管
just check       # lint + test + build + 文档链接检查
just check-assets # 验证保留的实验和静态原型
```

可将 [config/app.example.toml](config/app.example.toml) 复制为 `config/app.toml`，调整服务端口和数据库路径；不复制时使用同样的默认值。相对数据库路径以仓库根目录为基准，默认数据位于 `data/app.db`。`just dev` 的前端代理随后端配置端口变化。真实配置、数据库、缓存和密钥不提交。

`just dev` 和 `just start` 使用同一后端端口，应选择一种运行方式。OpenAPI 与前端生成类型一并提交，修改后端 schema 后运行 `just gen-api`；不要手改生成类型。

## 开始阅读

- [文档导航](docs/README.md)：PRD、领域术语、架构和技术选型等长期规范。
- [阶段性交接](docs/handovers/README.md)：当前实施基线、开发准备与归档任务书。
- [研究材料](references/README.md)：可复核的原句、解析示例、提取和阅读实验。
- [工作台视觉基线](prototypes/reading-native/VISUAL_BASELINE.md)：正式界面的视觉与交互参考；原型中的模拟业务行为不替代 PRD。

参与开发前请阅读 [AGENTS.md](AGENTS.md)。产品行为以 PRD 为准，实验和原型保留各自的历史边界。
