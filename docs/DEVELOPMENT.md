# 开发指南

本文维护本地开发环境、工程命令与仓库快照。首次试用见[项目首页](../README.md#快速开始)，应用配置见[使用指南](USAGE.md)，已有数据库的处理见[升级与备份](UPGRADING.md)。

参与开发前先读 [AGENTS.md](../AGENTS.md)。产品行为以 [PRD](PRD.md) 为准，当前实现与缺口见 [MVP 实施基线](handovers/MVP_IMPLEMENTATION_BASELINE.md)。

## 环境准备

准备 Python 3.11、Node.js 24、uv、pnpm 10 和 just。

Python 默认版本同时固定在根目录的 [.python-version](../.python-version) 和 [backend/.python-version](../backend/.python-version)，确保 `uv --project backend` 及后端目录内的命令使用同一版本。Python 包最低支持 3.11，Node 版本见 [.nvmrc](../.nvmrc)。依赖分别锁定在 [backend/uv.lock](../backend/uv.lock) 和 [frontend/pnpm-lock.yaml](../frontend/pnpm-lock.yaml)。

在仓库根目录运行：

```sh
just setup   # 安装锁定的后端与前端依赖
just dev     # 初始化／升级数据库，启动 FastAPI + Vite 热重载
```

开发页面为 [http://127.0.0.1:5173](http://127.0.0.1:5173)，API 文档为 [http://127.0.0.1:8000/api/docs](http://127.0.0.1:8000/api/docs)。`Ctrl-C` 一并停止前后端子进程。

后端绑定 `127.0.0.1`，数据保存在本地 SQLite。`just dev` 的前端代理随后端配置端口变化；端口和独立数据库的配置方式见[使用指南](USAGE.md#应用配置)。

## 常用命令

```sh
just lint         # Ruff、pyright strict、Biome、TypeScript 与原型语法检查
just test         # 后端与前端纯逻辑测试，禁止真实网络和模型调用
just gen-api      # 本地导出 OpenAPI 并生成前端类型，不需启动服务
just migrate      # 从空库建立当前 schema，或执行已有库的后续迁移
just start        # 初始化／升级数据库并构建前端，由 FastAPI 在 8000 端口托管（默认）
just build        # 构建前端
just check-docs   # 检查文档本地链接
just test-browser # 隔离 Chrome 中的真实组件与布局回归（可设置 CHROME_BIN）
just check        # lint + test + build + 文档链接 + 浏览器回归
just check-assets # 验证保留的实验和静态原型
```

`just` 或 `just --list` 列出可用命令，命令定义见 [justfile](../justfile)。

`just dev` 和 `just start` 使用同一后端端口，应选择一种运行方式；同一数据库只运行一个后台实例。两者都会先执行迁移，使用已有数据前须核对[升级与备份指南](UPGRADING.md)。

后端 schema 变化后运行 `just gen-api`，将 OpenAPI 与前端生成类型一并提交；不要手改生成类型。工程约束、测试规则及提交要求由 [AGENTS.md](../AGENTS.md) 维护。

## 仓库快照

运行 `just snapshot`（别名 `just snap`）可为远端 agent 生成仓库快照。需要 PATH 中已有 Repomix；它是可选开发工具，不加入项目锁定依赖。

快照自动保存在 `.snapshots/`，目录不存在时会创建。文件名为 `folio-j_仓库快照_YYYYMMDDHHMMSS.xml`，使用 XML 格式并显示文件树的 token 数量。Repomix 默认遵循 `.gitignore` 并检查敏感内容；整个快照目录已被忽略，不提交到 Git，也不打包进后续快照。

## 相关资料

- [文档导航](README.md)：产品需求、领域术语、架构和技术选型。
- [阶段性交接](handovers/README.md)：当前实施基线、后续安排与归档任务。
- [研究材料](../references/README.md)：可复核的原句、解析示例、提取和阅读实验。
- [第一阶段：素材与片段管理](handovers/archived/STAGE_1_SOURCE_SEGMENT.md)：该阶段已交付范围、接口和验收记录。
- [工作台视觉基线](../prototypes/reading-native/VISUAL_BASELINE.md)：正式界面的风格与布局参考；具体交互按实际功能设计，原型中的模拟行为不替代 PRD。

实验和原型保留各自的历史边界，不能据此恢复过时的产品需求。
