# 开发准备交接

> 状态：工程初始化建议；不替代 [PRD](../PRD.md)、[领域术语](../GLOSSARY.md)、[架构](../ARCHITECTURE.md) 或 [技术选型](../TECH_STACK.md)。首轮能力范围见 [实施基线](MVP_IMPLEMENTATION_BASELINE.md)。

## 建议首切片：建立可验证的本地工程入口

当前仓库主要是文档、原型和实验材料；`backend/`、`frontend/`、`justfile` 尚未建立。先按 TECH_STACK 建立最小前后端目录、依赖锁文件和 `just` 命令入口，使空业务应用能够在本地启动，由 FastAPI 提供 OpenAPI，前端客户端从 OpenAPI 生成。添加不连接真实模型或网络的健康检查与相应测试，并使 `just lint`、`just test`、`just gen-api` 可运行。此切片只验证工具链与生成路径，不实现 Source、Segment、讲解或 Occurrence 等领域功能。

验收时记录实际工具版本、命令结果和浏览器看到的本地页面；配置只提交示例，不提交密钥。后续领域切片应连通界面、API、持久化和必要测试；开始前为该切片涉及的 PRD `[TBD-xx]` 写清局部契约，避免从旧任务书、实验 schema 或架构占位推断产品行为。尤其是讨论写入与恢复 `[TBD-16]`、组合审核呈现 `[TBD-17]`，须在依赖它们的实现前细化。
