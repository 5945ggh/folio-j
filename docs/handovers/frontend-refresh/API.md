# 前端调整 API 契约

> 2026-10-04 已核对 catalog_schemas.py、api/catalog.py、服务层及生成客户端；目录与状态契约已实现，本轮综合及浏览器验收已完成，支持范围见 [ACCEPTANCE.md](ACCEPTANCE.md)。

| 接口 | 请求／响应 |
| --- | --- |
| GET /api/materials | type=book、source_id、q、status、sort=title／created_at／last_opened_at、order、page、page_size 默认 50 上限 100；返回 items,total,page,page_size |
| GET /api/catalog/sources | q、sort=title／created_at／updated_at、order、page、page_size；项目为旧 SourceResponse 加 material_count、segment_count、analysis_count |
| GET /api/sources/{id}/catalog/segments | q；sort=created_at／updated_at，默认 created_at 降序；分页返回旧 SegmentResponse |
| GET /api/sources/{id}/catalog/analyses | q；sort=title／created_at／updated_at，默认 title 升序；分页项目为旧 AnalysisListItem 加 segment_excerpt，携带所属 Segment 与 current_revision_id |
| GET /api/materials/{id}/usage | material_id,status,revision,last_opened_at,updated_at |
| POST /api/materials/{id}/opened | action_id,expected_revision；过时 409，不覆盖较新手工状态；幂等重试返回真实当前状态 |
| PUT /api/materials/{id}/usage | status,expected_revision |
| GET /api/materials/{id}/cover | 受控 cover_url；静态 PNG／JPEG；404 回标题占位；no-store、nosniff |

MaterialCatalogItem 为旧 MaterialSummary 加平铺字段 type:'book'、source_title、cover_url|null、status、usage_revision、last_opened_at；不使用嵌套 usage。标题采用 NFC 后 SQLite BINARY 确定序，同值以 ID 升序排序，不承诺自然卷序／拼音序。排序完整结果后分页，空打开时间始终置后；所有新路径遵守 Source 删除门禁。前端不得手写服务端 DTO。


## 实际持久化与兼容

增量迁移为 `0008_material_usage`，接续 `0007_materials`；新增 material_usage 与 material_covers，不重建已有材料表。旧位置须 revision > 0 且版本、章、part、资源及文字／图片锚点有效才初始化进行中；否则未开始。所有历史 last_opened_at 留空。usage 保存 last_action_id 做最近打开动作的有限去重，同 action 重试返回真实当前状态；其他陈旧 revision 返回 409，不自动重放。

保留旧 Source／Segment／Material 列表接口与响应形状。SourceCatalogItem 的 segment_count 继承 SourceResponse，新增 material_count、analysis_count。封面按 EPUB3 cover-image 或 EPUB2 meta name=cover 声明读取；最多 4 MiB、1600 万像素，PNG 校验结构／CRC 并拒绝 APNG，JPEG 校验头部尺寸。GIF／WebP／SVG／缺失及异常均占位。提取在首次受控封面请求中后台线程执行并缓存成功或失败，列表不解压原书；不改字节、编译包或材料版本。
