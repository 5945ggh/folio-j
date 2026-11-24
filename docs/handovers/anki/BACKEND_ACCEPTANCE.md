# Anki 单向导出后端交接与验收

2026-11-24，基于 `116c672f` 实施。阅读器界面可以独立施工，当前可通过 Folio-J 的本地 API 完成配置、探测、类型核对和单次发送。[产品范围](../../PRD.md#410-向-anki-单向导出) · [接口与持久化规则](../../ARCHITECTURE.md#anki-单向导出接口)

## 前端可以从哪里接入

1. 未连接 Anki 时即可读取 `GET /api/anki/builtins`、个人配置与连接设置。在当前会话保存填写内容。在配置设置接口中只提交字段定义和映射。
2. `POST /api/anki/probe` 测试连接。要测试尚未保存的地址或密钥，可传与保存连接设置相同的输入。恢复连接后读取 `GET /api/anki/catalog`，得到规范化端点、活动 profile、普通卡组和 Note 类型的名称及 ID。用 `POST /api/anki/note-type-fields` 读取实际字段。
3. 用 `POST /api/anki/export` 提交本次值。响应中的 `status` 区分已创建、字段错误、重复、需要安装、类型不兼容、目标变更、失败和写入结果未知。收到 `created` 才显示成功。发送到内置类型时携带列表中返回的类型 ID 与版本，用户确认后才能加 `install_builtin`。回执丢失时先提示到 Anki 核实。

下面是发送到已选的用户类型的请求体示例。名称和 ID 应来自当前目录。首期的接口不需要卡片页面、Source、Segment 或本地笔记 ID。

```json
{
  "endpoint": "http://127.0.0.1:8765",
  "profile": "Reading",
  "deck": "日语::阅读",
  "deck_id": "21",
  "note_type": "Basic",
  "note_type_id": "31",
  "fields": [
    {"id": "selection", "type": "text", "target_field": "Front", "required": true, "value": "灰汁"},
    {"id": "meaning", "type": "text", "target_field": "Back", "required": true, "value": "浮沫"}
  ]
}
```

制卡时的引用范围可继续用章节的 `segments`、`translations` 目录与精确选区比对。对每个相交的翻译出处，按 `identity_sha256` 读取材料翻译历史的各页和成功结果。只完成部分分页时，已取条数不能作为完整总数。布局、候选切换和草稿呈现交给阅读器设计。[接口类型](../../../frontend/src/api/schema.d.ts) · [生成契约](../../../backend/openapi.json)

## 隔离联调

在 macOS 上启动 Anki Desktop 26.09.2 的独立无界面进程。每轮使用新建的临时 Anki base、profile、单实例标识、回环端口、测试密钥和独立的 Folio-J 数据库，加载本机安装的 AnkiConnect 插件代码（插件号 2055492159）。发送通过实际 Folio-J ASGI 路由，结果从 Anki 读回。两轮结束后关闭对应进程并释放临时目录。

| 验收动作 | 观察结果 |
|---|---|
| 分别走 v1 和 legacy v6 | v1 直接连接。另一轮仅在探测层模拟 `/api/v1` 返回 404，v6 所有目录、创建、媒体和查询操作都访问插件实际的兼容端点。该结果覆盖本机版本，并不代表所有历史插件包。 |
| 导出到缺失的内置类型 | 首次返回需要确认，确认后创建词汇类型及一张词义回忆卡。另行安装例句类型并发送成功。读回的义项保留转义文本，卡背出处字段为“合成材料 · 第一章”。 |
| 同词两义与多张卡片 | 同一首字段第二次被 Anki 判重；明确允许本次重复后，另一义项成功创建。向现有双向类型发送一份笔记，回执带两个不同 Card ID。 |
| 附件 | 同一笔记包含合成 PNG、MP3、MP4。逐项核实 Anki 笔记字段中的媒体文件名和集合媒体目录中的文件。再次提交相同内容后仍使用相同文件名。未实测桌面音视频播放或移动端兼容性。 |

自动化覆盖空库与存量迁移、设置及凭据备份恢复、断线和未保存设置探测、v1／v6 协议、目标与字段变化、受控模板身份、多个卡片 ID、附件部分成功以及未知回执。测试替身不会访问真实 Anki。后端 wheel 已核实包含运行时内置模板。本轮未验收生产阅读器交互或重建后的 Windows 冻结包。[API 回归](../../../backend/tests/test_anki_api.py) · [协议回归](../../../backend/tests/test_anki_connect.py) · [导出回归](../../../backend/tests/test_anki_export.py) · [配置回归](../../../backend/tests/test_anki_settings.py)

本次 `just lint`、`just test` 和 `just check-docs` 通过。后端 1660 项通过、3 项跳过，前端现有逻辑测试 840 项通过。与本批之前的 OpenAPI 逐项对照，已有路径和数据结构均兼容。前端代码改动仅为重新生成的客户端类型。
