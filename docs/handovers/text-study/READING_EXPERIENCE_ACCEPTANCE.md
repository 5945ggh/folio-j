# 阅读体验调整验收

2026-10-22，实施起点 c389ca3，分支 codex/reading-experience。范围为自动语境整理、只读派生出处、正文外片段入口与全局显示偏好；继续使用 Segment，不新增子类型、依赖或 ORM 字段，未触及 TBD。

## 实现与独立审查

实施前编写[计划及精确样例](READING_EXPERIENCE_PLAN.md)，独立审查修正单资源 NFC 输入、空白行规则措辞与零宽字符精确输出后开始实施。自动语境先更新固定样例，旧实现 59 项中 20 项失败；实现后定向 70 项通过。出处展示先补失败回归，再实现 display，出处与按章分页相关测试 80 项通过。

独立交互审查发现并修复四项：作者容器裁剪及不可见文字仍可能产生入口、最后候选删除后的空面板状态、原生／React Escape 处理次序、重排完成后的入口几何刷新。复审相关五文件 34 项通过；后续补上面板退出后留白重测与无滚动重排回归。

自动预装使用 Unicode White_Space 整理两侧副本，保留原文分句和目标坐标。计费按整理后 NFC 码点；句间空白不产生假截断。固定输入与精确预期见 [C2_EXACT_CASES](C2_EXACT_CASES.md) 和 [JSON fixture](fixtures/c2-context-cases.json)。

出处由已有解析接口提供 display；正常为当前材料名、已验证章名与章内约 N%。分母是按 part／spine 顺序连接后整体 NFC 的章正文长度，重复 spine 每次计入；第一段起点前缀的 NFC 长度为分子，向下取整，非空目标为 0–99%。NFC 起点不可分时省略百分比；失败只显示可靠材料名和原状态。source_ref 独立保留为出处补充／出处说明。

正文片段点击命中和延迟竞争逻辑已删除。被动细线、真实留白中的 44px 页边入口、数量聚合与固定完整本章列表共用精确范围投影。新偏好 studySegmentUnderlines／studySegmentMargins 逐项优先，缺失项回退旧 studySegments，旧 false 不会被重新打开。

## 隔离环境与浏览器证据

数据库为 `/tmp/folio-reading-experience-qa/qa.db`，由 Alembic 从空库建立。服务仅监听 127.0.0.1:8017，验收启动器关闭两个模型 worker，Vite 为 5177；没有写日常数据库或真实模型调用。样书基于上轮原创 C2 EPUB，逻辑章含三个 part／spine（0:c1、1:c2、2:c1），包含原书 ruby、跨节点 NFC、非 BMP。通过正式 API 建立 108 条独立片段：105 条同出处、一个额外范围、重复 spine 和跨 part 目标；分页实测 100＋8，末页无游标。

| 检查 | 观察与证据 |
| --- | --- |
| 页边与密集同文 | 1280px 下，入口位于正文右侧真实留白，105 条同出处聚合为数量按钮，候选 DOM 含全部 105 项，以创建时间与完整 ID 区分。[桌面聚合](evidence/reading-experience/desktop-cluster.png) |
| 正文事件与面板生命周期 | 单击已划线正文没有新开片段，也不关闭已打开候选；滚动关闭贴句候选。固定本章列表在正文滚动后仍保留108项；原生拖选和键盘扩选同时保留列表及选区工具栏。复制得到所选日文原文；原书ruby的“漢”双击后只有选区工具栏，复制为“漢”。Escape 关闭列表后焦点回到“本章片段”。 |
| 隐藏与完整列表 | 两项都关闭后无页边入口，本章列表仍有108项，键盘候选可用。[隐藏标记后的列表](evidence/reading-experience/hidden-marks-list.png) |
| 偏好与同步 | 第二标签初始两项 false；第一标签只开启页边入口后，第二标签立即变为下划线 false、页边 true。刷新后保持；同浏览器另一份空白样书继承偏好。旧值兼容由纯逻辑回归覆盖。 |
| 横竖排、字号与窗口重排 | 在阅读设置切换竖排并调整字号后，正文旁线和横排列表正常；1280→390→1280 不需要滚动即可清除或重建页边入口。竖排使用可用底部留白，窄屏无足够留白时使用覆盖式列表。[竖排](evidence/reading-experience/vertical-list.png)、[390px窄屏](evidence/reading-experience/narrow-list.png) |
| 整理预算与草稿 | 新空白样书目标“学ぶ”，前侧大量换行与全角空白，前预算4仍精确得到“前の文。”；后2句得到 `甲。\n\n乙。`。编辑为“手写语境保留”后重新取文先出替换提案，当前字段保持原值；保留草稿后单击正文也不丢弃。[整理后的语境](evidence/reading-experience/tidied-context.png) |
| 保存和明确打开 | 保存仍留在原书，顶部提示“已保存学习片段／打开片段”；API核实前文为手写值、后文含一个空行。[保存后原文](evidence/reading-experience/saved-in-reader.png) |
| 只读出处与人工补充 | 片段页显示“C2 原创验收样书 · 验收长章 · 章内约 1%”及返回原文；已有人工出处补充保留，可在资料编辑中保存修改。[只读出处](evidence/reading-experience/origin.png) |
| 重复与跨 part | 第二次 c1 的同一“漢”显示51%，跨 part 目标显示49%，点击返回分别定位到第二次出现、第一段起点且全部原文范围保留旁线。[重复spine返回](evidence/reading-experience/repeated-spine-return.png)、[跨part返回](evidence/reading-experience/cross-part-return.png) |
| 改名与删除 | 隔离材料改名后自动更新显示名且位置为20%；删除材料后保留历史文字和手写语境，只显示可靠名称并明确无法返回，不补0%。[改名](evidence/reading-experience/renamed-origin.png)、[材料删除](evidence/reading-experience/deleted-origin.png) |
| 定位失败 | 在隔离库临时注入 exact 失配，页面显示可靠材料名和“快照不一致，无法精确定位”，不显示章名／百分比或返回链接；随后恢复原 payload。[失配降级](evidence/reading-experience/mismatched-origin.png) |
| 搜索 | 对“甲”搜索得到重复 spine 的两个结果，点击后回到相应原文并保留搜索高亮，未出现定位错误。[搜索](evidence/reading-experience/search.png) |

## 工程检查与提交

- `just lint` 通过：ruff 检查／格式、后端 strict pyright、Biome、前端 tsc 及原型语法检查均通过。
- `just test` 通过：后端 510 项、前端 356 项，0 失败；测试禁止真实网络／模型。
- `just build` 通过：511 个模块，主 JS 854.16kB（gzip 255.16kB），仍有超过500kB的包体积提示。
- `just gen-api` 通过，生成产物已纳入出处提交；`just check-docs` 检查74份文档、730个本地链接全部有效；`git diff --check` 通过。
- 原 reference 树与任务前备份逐文件比较一致。隔离库从空库执行现有0001–0005迁移，无ORM变更或新迁移。

| 提交 | 范围 |
| --- | --- |
| d06f3e6 | 自动语境副本整理、精确样例及实施计划 |
| 3301440 | 服务端只读出处展示、人工补充与生成客户端 |
| 84d6a4e | 正文外入口、完整列表、两项偏好和生命周期 |

本验收记录及截图另行提交；既有10份规范／交接文档的原改动与本轮局部对齐继续留在工作区，避免混入无关提交。

## 原有改动保护与限制

开始时10份规范／交接文档已修改，另有概念草案和 references/folio-reading-aids-v0.1 未跟踪目录。原始 diff、docs 与 references 备份在 `/tmp/folio-reading-adjustment-baseline/`。本轮仅在原文档上局部对齐本轮契约；这些文件保留在工作区，代码提交不混入原有规范修订。参考目录与概念草案保持原样，不进入本轮提交。历史验收文件保留当时事实。

未实际安装或运行 Yomitan 等第三方扩展，本轮只验证正文事件边界与原生选择／复制，不宣称扩展兼容验收通过。浏览器窄屏是视口模拟，未使用实体触屏设备。初始选择仍限单 iframe，跨 part 目标由结构化出处/API验证；本轮未扩大原生选择范围。生产构建若继续报告单个 bundle 超过500kB，仅记录现有包体积提示，不为此新增拆包范围。
