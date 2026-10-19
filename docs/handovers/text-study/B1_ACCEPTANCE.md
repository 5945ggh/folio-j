# B1 文本处理接口解耦验收

2026-10-20，接续 S0 提交 4e705a1。实现范围仅 B1，不包含统计页面或 A／C 行为。

## 实现与兼容

`nlp/contracts.py` 提供 TextResource 和词法结果契约，generate 接收有序普通文本资源；`nlp/assets.py` 解码完整资产并校验正文；`services/epub_readings.py` 负责 EPUB 输入转换和章节投影。构建／发布沿用原事务、不可变代次和当前指针，readings API 类名与字段保留。

改动前先保存固定 fixture 并运行 13 项基线测试。fixture 包含 main、empty、main 的重复资源顺序与零跨度 token；改动后 configuration、完整解压 payload、asset_sha256 和 token_count 逐字一致。固定样例 token_count 为 16，摘要为 `2b4e6b19385fa959536c265848e30f21ae6fec175a59c162a7b8e6d112dfb0ff`。

完整资产解码按正文规模设置集中预算，覆盖超限、截断、尾随数据、资源错配、越界／重叠、漏字与错误词性；允许原有空白间隙及零跨度。输入是本地可信生成资产，不增加外部分析包导入。

## 验证

- 目标后端测试 62 项通过；独立审查未发现阻塞问题。
- `just test`：后端 315 项、前端 206 项通过。
- `just lint`：Ruff、Pyright、Biome、TypeScript 及原型语法检查通过。
- `just gen-api`：OpenAPI 和生成客户端无差异。
- `just build`、`just check-docs`、`git diff --check` 通过。构建仍有既有单 bundle 超过 500 kB 的体积提示，不阻止构建。

没有 UI 改动，本切片未做浏览器操作。现有重复 spine 的章节响应会返回重复资源条目，新增回归明确保留该语义；B2 统计按资源身份独立去重，不借 B1 改显示行为。没有新增依赖、数据库变更或 TBD。
