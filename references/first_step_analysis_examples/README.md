# 初步解析示例

这里保存用于参考日语解析风格的示例。每个示例包含输入材料 `source.md`、解析结果，以及生成解析时使用的 `prompt-template.md`。解析结果可以是 Markdown 或 JSON，具体格式见索引。

## 索引

| 版本／实验目录 | Prompt 版本 | 输出格式 | 示例数 | 目录 |
|---|---|---|---:|---|
| Markdown 解析 v0.1 | `v0.1` | Markdown | 1 | [查看目录](v0.1/) |
| JSON 输出测试 | `v0.1-json` | JSON | 1 | [查看目录](json-test-v0.1/) |

## 版本与目录

```text
v0.1/
├── prompt-template.md   # Markdown 输出格式的提示词模板，version: v0.1
├── 01/
│   ├── source.md        # 示例输入与解析范围
│   └── analysis.md      # Markdown 解析结果
└── 02/ ...              # 同一版本下的其他示例

json-test-v0.1/
├── prompt-template.md   # JSON 输出格式的提示词模板，version: v0.1-json
└── 01/
    ├── source.md        # 示例输入与解析范围
    └── analysis.json    # JSON 解析结果
```

根索引按版本或实验目录登记，不逐条列出例句。索引中的 Prompt 版本取自对应模板文件 front matter 的 `version` 字段；目录名用于区分材料所在的版本或实验目录，两者不要求相同。当前 `json-test-v0.1` 是 JSON 输出格式的测试目录，不代表 `v0.1` 的后续正式版本。每个版本目录内以编号子目录保存多条例句。

## 添加示例

- 每个示例使用稳定编号目录，保存 `source.md` 和对应解析结果（如 `analysis.md` 或 `analysis.json`）。
- 在 `source.md` 中保留作品／素材、唯一解析范围，以及判断语境所需的前后文；前后文不是解析范围时要明确标出。
- 新增版本或实验目录时，在根索引中登记目录名、Prompt 版本、输出格式和示例数量；例句的作品／素材、解析范围及文件链接由版本目录内的材料体现，不重复登记在根索引。
- 原始语料与解析正文分别以各自文件为准，索引只保留便于查找的信息。
