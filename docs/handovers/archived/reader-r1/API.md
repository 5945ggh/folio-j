# Reader R1.1 实际 API 与存储契约

> 历史阶段资料（2026-10-20 归档）。现行规则见[PRD](../../../PRD.md)与[架构](../../../ARCHITECTURE.md)，当前交付和未完成验收见[实施基线](../../MVP_IMPLEMENTATION_BASELINE.md)。

Reader 的搜索与图库读取不可变编译包，不重新导入 EPUB，不修改原始字节、规范化正文、版本或产物 hash，不创建 Run，也不写 usage 或 reading_positions。服务端 DTO 见 `backend/src/app/material_schemas.py`；OpenAPI 位于 `backend/openapi.json`，前端消费生成的 `frontend/src/api/schema.d.ts`。

## 搜索

`GET /api/materials/{material_id}/search?version_id=…&q=…&offset=0&limit=40`

operationId 为 `searchMaterial`。`version_id` 必填；`q` 默认空，输入最多 160 个 Unicode 码点，服务中去首尾空白并 NFC；`offset` 非负；`limit` 默认 40，范围 1–100。空白查询返回空页，不解压扫描。

`MaterialSearchResponse` 含 `material_id`、`version_id`、规范化 `query`、完整范围的 `total`、`offset`、`limit`、`items`。`MaterialSearchItem` 含 `chapter_id`、`chapter_title`、`part_index`、`spine_index`、`resource_id`、资源局部码点半开范围 `start` / `end`，以及纯文本 `before` / `match` / `after`（前后各至多 40 码点）。不得将 `start` 当作摘录偏移或 JS UTF-16 索引。

按章和 part 阅读顺序字面扫描 canonical text，支持重复和重叠命中；相同资源在不同 spine 出现时保留各次结果。章内同资源、同 spine、首尾连续的 part 范围合并扫描；命中归属于 start 所在 part，end 可以跨到下一连续 part。不同章、资源或 spine 出现位置不拼接。rt/rp 不进入编译器 canonical text，UI 标题不加入搜索范围。只保留当前结果页并统计全部命中，不保留全量命中数组。

## 图库

`GET /api/materials/{material_id}/illustrations?version_id=…&offset=0&limit=40`

operationId 为 `getMaterialIllustrations`。分页参数同搜索。`MaterialIllustrationsResponse` 含材料、版本、完整 `total`、分页及 `items`。`MaterialIllustrationItem` 含版本内从零开始的 `ordinal`、`chapter_id`、`chapter_title`、`part_index`、`spine_index`、`resource_id`、编译器 `image_id`、原始 `alt`（允许空）和 `content_url`。清单按已清洗 part HTML 的图片出现顺序构建，保留重复图片和纯图片章，不返回 base64 图像或虚构宽高。

`GET /api/materials/{material_id}/illustrations/{ordinal}/content?version_id=…`

operationId 为 `getMaterialIllustrationContent`。ordinal 是版本内出现顺序，不能作为跨版本引用身份。导航使用完整章 / part / resource / image_id，并沿用旧图片位置 body 的 image_progress。

只读取编译包内带 data-epub-image 的受控 PNG / JPEG / GIF / WebP base64 图片；不提供 URL 代理、路径或任意 ZIP 成员读取，不返回 SVG。按编译安全预算 `MAX_PRODUCT_BYTES`（64 MiB）检查编码大小和字节大小，未套用封面专用 4 MiB 上限。解码失败或 MIME 文件签名不符为 422，编码超过安全预算为 413；文件签名核对不是完整图片解码验证，浏览器仍可能呈现单项解码失败。响应 MIME 与识别类型一致，包含 `X-Content-Type-Options: nosniff` 和 `Cache-Control: private, no-store`。不存在的出现项为 404。

## 共同门禁及执行

每请求先检查材料及所属 Source 存活，不可见或缺失为 404，请求版本不符为 409，参数无效为 422。旧位置接口的版本 / 范围错误仍为 422，未改变该契约。解压、正文扫描、HTML 解析与图片 base64 解码通过 asyncio.to_thread 离开事件循环。目前没有派生缓存或持久搜索索引；每次非空查询 / 图库请求仍解析有界编译包，轻量响应不等于完全不解析全书。

## 阅读位置和浏览器偏好

位置 API 沿用 `PUT /api/materials/{material_id}/reading-position`：文字使用资源局部码点 offset；图片使用 image_id / image_progress；expected_revision 串行乐观写入。spine_index 用于 UI 核验，未加入严格位置 body。原三项设置 font_size（12–40）、line_height（1–3）、writing_mode（horizontal-tb / vertical-rl）仍按材料随位置保存。

2026-10-11 章节记忆扩展：`MaterialResponse.chapter_positions` 返回按章序排列的已有 `ReadingPositionResponse`，未记录的章不返回占位项。`ReadingPositionResponse.progress` 为 0–1 的正文位置比例或 null，既用于全书最后位置，也用于章节记录和 PUT 响应；纯图片章返回 null。PUT 请求保持不变，同一材料级 revision 校验及事务更新全书和当前章；其他章位置保留。正文比例和迁移规则由[架构](../../../ARCHITECTURE.md#31-实体)维护。

新增浏览器全局 UI 偏好使用 `folio-reader-ui-v1`，保存 theme（system / white / black）和 focus（布尔值）。逐材料版本偏好使用 `folio-reader-book-ui-v1:<encodeURIComponent(material_id)>:<encodeURIComponent(version_id)>`，保存 font（mincho / gothic）、ruby（show / dim / on-demand / hide）、width（有限数值 560–1040）。默认 system / focus=true，mincho / ruby=dim / width=760。读取损坏值逐字段回默认，旧 soft 主题兼容为 white；Storage 不可用或写失败时内存状态继续可读，不承诺跨设备同步。

搜索、目录或图库显式导航建立会话原点，图库单纯浏览不改正文位置；返回原点按当前排版恢复，不以重新搜索同句猜测位置。主题、专注和新增 UI 偏好不产生材料版本、位置 revision 或 opened 动作。opened 与手动 usage 仍走既有接口和 revision 保护。

## 本机只读查询成本记录

2026-10-05，在 macOS 26.3 arm64、Python 3.11.14 的独立验收库，对两本用户本机真实材料各执行一次 `scan_search(q=ああ, offset=0, limit=40)` 与 `scan_illustrations(offset=0, limit=40)`。计时包含编译包解压、模型验证及扫描，响应大小为 UTF-8 JSON 字节数；计时不包含 JSON 序列化、HTTP 传输或浏览器解码。过程使用 SQLite 只读连接，不启动应用、不访问网络、不改状态。私有证据保存于本机 `temp/reader-r1-acceptance/evidence/read-query-cost.json`，不提交书籍正文。

| 材料 | 编译包压缩 / 展开字节 | 搜索耗时 / 响应字节 | 图库清单耗时 / 响应字节 |
| --- | --- | --- | --- |
| 安達としまむら8 | 8,538,047 / 16,203,298 | 30.383 ms / 7,796 | 99.313 ms / 4,918 |
| 安達としまむら | 21,907,333 / 38,362,081 | 73.640 ms / 5,259 | 199.878 ms / 6,708 |

上述为暖进程各一次观测，不代表 p95、并发性能、冷启动或网络体验。搜索分别完整统计 18 / 12 项，图库分别统计 17 / 24 项；轻量 JSON 没有携带图片 bytes，但服务端仍需解压全书编译包，不能把轻量清单理解为无全书解析成本。尚未测量实际图片传输量、浏览器图片解码峰值内存或并发查询内存；无缩略图生成，图片请求仍按需读取原图。

最终只读 hash 复核确认 6 本验收材料的版本、原始字节、编译包、产物和资源正文 hash 与导入基线一致；Run 保持 0，5 本的 usage 和阅读位置已因浏览器操作改变，这两类变化不属于不可变字段核对失败。

2026-10-16 章末位置扩展：位置请求及响应增加 `at_chapter_end`，默认 false；旧记录缺字段时按 false 读取。当前 `progress` 在实际内容末端进入可读区域时为 1（包括纯图片章），不要求滚过尾部留白；未到末尾的正文位置最高为 0.99，图片处按该图前正文计算，纯图片章仍为 null。标志与原锚点通过既有材料级 CAS 一起保存，回看可清除。导航恢复与普通重排的区别见[架构](../../../ARCHITECTURE.md#31-实体)，证据见[章末进度验收](../epub-reading/CHAPTER_MEMORY_ACCEPTANCE.md#2026-10-16-真实书复核与口径调整)。
