# AnkiConnect 接口参考

Folio-J 的[阅读器单向导出提案](../../docs/handovers/anki/READER_EXPORT.md)采用 FooSoft/anki-connect 提交 `d9165b4c563ee01ceb3f7c4daaa034eefaabffc6` 作为协议参考。这是可复查的上游版本。用户本机安装的协议和方法由连接时探测、实机验收确认。

| 要查什么 | 固定版本原文 |
|---|---|
| 安装、运行条件、协议选择 | [上游 README](https://github.com/FooSoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/README.md) |
| v1 的会话、错误、卡组、笔记与复习 | [v1 方法参考](https://github.com/FooSoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/API_V1.md) · [JSON Schema](https://github.com/FooSoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/api-v1.schema.json) |
| legacy v6 的请求、返回、首字段判重与复习记录 | [legacy 方法参考](https://github.com/FooSoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/API_LEGACY.md) |
| 插件执行方式、接口测试与兼容策略 | [上游架构](https://github.com/FooSoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/ARCHITECTURE.md) · [开发与测试说明](https://github.com/FooSoft/anki-connect/blob/d9165b4c563ee01ceb3f7c4daaa034eefaabffc6/CONTRIBUTING.md) |

本机副本保存在仓库相对目录 `references/anki-connect/upstream/d9165b4/`。Git 跟踪本索引和版本号，忽略 `upstream/` 下的原文。公共文档可链接本索引或固定版本原文。持有副本的读者可在本机直接打开对应文件。应用运行和文档检查均无需下载副本。

在仓库根目录用以下命令可重建离线参考（sh／zsh）。换版时另建目录，并在采用新契约时更新索引。

```sh
anki_ref=d9165b4c563ee01ceb3f7c4daaa034eefaabffc6
anki_ref_dir=references/anki-connect/upstream/d9165b4
mkdir -p "$anki_ref_dir"
for anki_ref_file in README.md API_V1.md API_LEGACY.md api-v1.schema.json ARCHITECTURE.md CONTRIBUTING.md
do
  curl -fL "https://raw.githubusercontent.com/FooSoft/anki-connect/$anki_ref/$anki_ref_file" \
    -o "$anki_ref_dir/$anki_ref_file" || exit 1
done
```
