# 阅读器 R1.1 工程验收

2026-10-05。本记录仅证明当前生产实现的实际检查，不继承交接原型、A.1、S2 或旧 EPUB 验收的测试数量。起始变更与文件边界见 [PLAN](PLAN.md)，数据与偏好契约见 [API](API.md)。

## 实际改动

`MaterialReader.tsx` 接入独立阅读外壳、几何变更恢复、明确出现位置导航和单个跳转原点；新增 ReaderControls／ReaderPanels、focus／preferences／presentation／highlight 及相应测试。旧 reader-refresh.css 仅移除 Reader 规则，保留工作台与设置样式。后端新增 reader_queries 服务及三个只读API，正式Pydantic schema生成OpenAPI客户端。Books仅替换公共封面占位分支；没有改变A.1／S2布局、数据模型或原始编译产物。

长期规范定向更新 PRD、ARCHITECTURE、INFORMATION_ARCHITECTURE、TECH_STACK，阶段索引和MVP基线增加本轮入口；既有S2修改保留。本轮未新增TBD决定，未提交或推送Git变更，便于与原工作区改动一起审阅。

## 环境与入口

- 分支 `codex/reader-r1`，起始 HEAD `079b56f80d09e4d2abc66c1844f53d18713ffaa6`，完整保留既有 S2 未提交变更；未 push／发布。
- 浏览器为 Codex 内置 Chromium；真实 `frontend/dist` 生产构建、FastAPI、SQLite。视口覆盖 320×720、390×844、1024×768、1440×900；不代表物理触屏或全部浏览器。
- 本轮唯一写入的验收数据库：`/Users/ningcc/Products/folio-j/temp/reader-r1-acceptance/app.db`；空库迁移至 `0009_cover_rules`。所有材料重新导入此独立库，不改日常库、材料旧身份或原文。
- 测试书 6 本：新的重叠搜索／图文／重复 spine 合成书、无图无 ruby 合成书、仓库两本合成 fixture、本地用户已提供的两本真实 EPUB。旧固定版式 fixture 仍按原契约 422 拒绝。
- 本地入口：`http://127.0.0.1:8767/materials`。合成主书：`/materials/01M4688KYTVF2YFJ9XE1G7C0M2`；无图书：`/materials/01M4688KZ7EJQHDE6KXQJERJVA`。
- 复现启动：先设置 `FOLIO_J_DATABASE_PATH=/Users/ningcc/Products/folio-j/temp/reader-r1-acceptance/app.db`，运行 `just migrate`、`just build`，再以同一环境运行 `UV_CACHE_DIR=.cache/uv uv run --project backend python -m uvicorn app.main:app --host 127.0.0.1 --port 8767`。不得省略数据库环境变量后拿日常库练习迁移。

证据均保存在本机 gitignored `temp/reader-r1-acceptance/evidence/`；样书、原文截图和数据库不纳入提交。材料清单与初始 hash 位于同目录 `manifest/hash-baseline.json`。

## 实际结果

| 项目 | 方法与观察 | 证据 | 状态 |
| --- | --- | --- | --- |
| 基线和原型 | 实际打开修订原型，体验横排／竖排、设置、搜索命中／返回与图库；正式实现保留 sandbox iframe／CSP | PLAN；本轮代码差异 | 通过 |
| 独立阅读空间 | 正文、加载、材料缺失、章节失败均无主导航；章节失败静置超过3秒仍有返回和重试 | material-missing.jpg、chapter-failure.jpg | 通过 |
| 静置和普通点击 | 首次无按键3秒自动隐藏；同点两次普通单击350ms后状态分别false／true；显隐前后视口749×538一致 | 自动focus测试；浏览器DOM观察 | 通过 |
| 键盘 | 隐藏时Down使正文scrollTop从1864到1944，工具保持false；阅读视口内Tab显示工具并实际聚焦“返回素材库”；初始body分支另有自动测试 | 浏览器DOM观察；focus.test.ts | 通过 |
| 选择与触屏意图 | 桌面真实iframe双击选词，3秒后工具保持显示；折叠选区350ms后仍显示。自动测试另覆盖选区接口、1px／5px坐标、触屏pointerout、双击取消、注入控件、失焦和卸载 | focus.test.ts、presentation.test.ts | 通过 |
| 主题与排版 | 白／黑／系统三个选项；黑色正文和ruby可辨，图片未反色；真实书横竖排／字体、字号12与40／行距1与3／宽度560实际操作 | settings-black-vertical.jpg、settings-320.jpg | 通过 |
| 四种原书ruby | 真实iframe内切淡化／显示／按需／隐藏，rt透明度分别0.48／1／0／0，base矩形始终44×22，原文本保留 | 浏览器DOM测量，settings-1024.jpg | 通过 |
| 新增偏好 | 枚举／边界验证、损坏及异常Storage退回内存，逐材料版本与全局键分离，原API仅三项设置 | preferences.test.ts；API | 通过 |
| 长文稳定恢复 | 真实书chapter-2／part1／resource p-004，切排版前offset480，改字体竖排后458，极值／重置刷新后412，均在同一正文附近；服务重启后和320／390缩放仍恢复该段 | real-reflow-*.json、real-book-restored.jpg、real-reader-390.jpg | 通过 |
| 图片 | 合成竖600×1000、横1000×480、行内小图、多part、重复spine与纯图片章；两本真实书开篇及图库完整等比；图像尺寸每次从作者声明与外层视口计算 | image-viewer-320.jpg；presentation.test.ts | 通过 |
| 搜索真实数据 | 合成书“ああ”共290处；首批40、继续加载80；第54条高亮该句第二处重叠命中；返回跳转前回原章附近 | search-exact-overlap.jpg；test_reader_queries.py | 通过 |
| Unicode与范围 | 服务测试覆盖跨叶子／连续part、NFC、补充平面字符、全角、字面正则、原ruby读音排除、重复spine；前端Range测试核验不改定位叶子 | highlight.test.ts、test_reader_queries.py | 通过 |
| 慢查询隔离 | 将搜索延迟2秒；关闭“ああ”面板后重开输入“境界”，结果为145处且40条mark均为境界，旧结果未串入 | search-late-query-isolated-1440.jpg | 通过 |
| 搜索失败重试 | 显式503后保留“しまむら”，不显示零结果；解除故障重试返回100处真实命中 | search-failure-390.jpg | 通过 |
| 图库／大图 | 合成5项，真实书17／24项；缩放、前后、首尾禁用、Esc先关大图再关图库；浏览前后正文x=-51.5不变；明确前往才导航并建立原点 | 浏览器截图／DOM；image-viewer-320.jpg | 通过 |
| 图片定位和保存 | 图库前往纯图章后保存chapter-1／part0／resource only／image_id0／image_progress0，正文点击直接打开第5/5项 | 独立库reading_positions revision10 | 通过 |
| 图库失败／空态 | 清单503有重试；单图503有独立重试，解除后真实图恢复；无图书显示“本书暂无可查看插图” | 浏览器操作 | 通过 |
| 按需图片请求 | 390px真实书图库有24个卡片，IO门禁下首屏仅8个带src的img，其余无图片请求；每页最多40，未建立缩略处理服务 | 浏览器DOM计数；ReaderPanels | 通过 |
| 保存失败 | 位置PUT503后工具已隐藏，错误与“重新打开”仍可见；解除故障重开可读 | position-failure-persists.jpg | 通过 |
| 门禁／只读 | 缺失、删Source、错误版本、非法分页／query、跨材料出现项、损坏图片有自动覆盖；6本原始bytes／hash／version／bundle／resource text全部与初始一致；Run=0 | hash-check.json；test_reader_queries.py | 通过 |
| A.1／S2 | 三斜线占位与真实封面共存；55×77概览卡只保留纹样；素材库q与排序往返保留；S2 overview和view=materials&expanded=book&q=無画像精确恢复 | library-shared-covers-1440.jpg、source-overview-compact-cover.jpg | 通过 |
| 旧功能回归 | 原position／viewport／persistence／usage、目录、chat／analysis／settings、EPUB编译与材料测试继续执行 | 下方综合命令 | 通过 |

## 综合检查

| 命令 | 实际结果 | 状态 |
| --- | --- | --- |
| `just gen-api` | 后端OpenAPI导出并生成schema.d.ts成功 | 通过 |
| `just lint` | ruff／88文件格式／pyright 0错误、Biome 86文件、tsc、实验脚本语法 | 通过 |
| `just test` | 后端248、前端74、EPUB定位实验4，共326项；0失败 | 通过 |
| `just build` | 生产构建成功，JS主包652.64kB（gzip194.66kB）；保留大于500kB提示 | 通过 |
| `just check-docs` | 46份文档、399个本地链接有效 | 通过 |
| `git diff --check` | 无空白错误 | 通过 |

原始输出：`evidence/just-lint.log`、`just-test.log`、`just-build.log`。未新增依赖；不是对真实模型或全部浏览器的认证。

## 明确未验证与限制

- Yomitan用户扩展配置、扫描／ruby弹窗／复制的本轮实测：**未执行**。保留无脚本同源frame，测试注入控件事件隔离，但不能因此宣称扩展兼容。
- 物理触屏长按／滑动、多点触控及屏幕阅读器：**未执行**；本轮为桌面浏览器加手势状态自动测试。
- 操作系统实时深浅切换：**未执行**；选择值解析与监听逻辑有自动／静态验证，实际白黑切换已操作。
- Safari／Firefox、复杂多层原书ruby和全部出版物作者CSS：**未执行**。两本真实样书不代表全部EPUB。
- 字体／图片异常慢加载的全部并发排列、浏览器解码峰值内存和长期阅读压力：**未执行**；旧布局恢复竞态自动测试继续通过。服务单次样本计时见API，非p95。
- 工作台真实模型、审核／停止／历史讲解的本轮手动浏览器全流程：**未执行**；既有离线自动回归执行，未调用真实模型。
- 封面解码故障后重试、卡片140／280尺寸以及超40图片分页的全套浏览器组合：**未执行**；既有封面／目录与新增分页服务测试保留。
- 临时跳转原点只在本次会话中保留；查询不跨资源／章节拼接、不搜索读音、不自动注音；新增UI偏好不跨设备同步。没有新增领域表、依赖、模型任务或TBD决定。

浏览器验收工具日志曾报告无源码位置的 `MutationObserver.observe` 参数错误；当前生产源码没有使用 MutationObserver，尚未定位其注入来源，未将“控制台全部无错误”记为通过。浏览器核心功能及服务端／自动测试结果按上表独立记录。
