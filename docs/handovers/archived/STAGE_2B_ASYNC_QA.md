# 第二阶段 2B：片段后台异步问答

状态：2B实现与离线验收通过，已归档；随本轮以快进方式集成到main。长期行为以 [PRD](../../PRD.md) F1、F2、F7–F9 为准，领域身份见 [GLOSSARY](../../GLOSSARY.md)，实现原则见 [ARCHITECTURE](../../ARCHITECTURE.md)。本文件固定2B的局部技术选择，不宣称整个MVP或TBD-16已经完成。

## 1. 交付范围与局部选择

从已保存的 Segment 创建独立线程、提问和持续追问；接受后在本机后台执行，刷新／离开／关闭浏览器不取消或重发，重开可见持久历史。支持本轮停止及明确的失败／中断反馈。普通问答只保存讨论与Run，不创建Analysis或Occurrence。

- 同一片段可有多个独立线程；线程不绑定唯一讲解。2B不实现线程重命名、单独删除、历史消息编辑或分支；列表用首条问题的前40个码点作展示摘要，空线程显示“新对话”，不增加自动命名模型调用。
- 当前没有Analysis／Occurrence的生产表与读取工具；2B实际输入为现有Source／Segment、本线程成功历史、背景与预设。以后接入片段内持久资料时必须记录内容／不可变版本与出处，不预建空工具或把其他线程聊天当共享资料。
- 使用现有两种文本协议；问答默认流式，可显式选择普通文本。只调用所选配置，不自动切换协议、Provider或模型。unknown／failed验证状态提示用户，但不代替本次调用结果，也不要求先付费验证才能发送；停用、删除或未选模型则不能接受。
- 2B使用轮询观察持久化的聚合正文，暂不增加SSE。流式是在后台接收并持久保存文本，页面每秒读取最新状态。后续SSE必须为每个观察者独立分发，不使用共享消费队列。
- 新线程复制新线程默认权限；review／full_access均只执行本阶段的文本问答，没有工具可审批，不展示无效审核按钮。线程空闲时可切换权限，运行时禁止；不借此提前确定TBD-17。

## 2. 身份、数据与约束

新增实体放 `chat_models.py`／`chat_schemas.py`，业务放 `services/chat.py` 与 `services/context.py`，任务领取和监督放 `jobs/`。所有新身份为ULID；时间为带时区UTC。以下契约已落实到实现，前端类型由OpenAPI生成。Job实体的物理表名为chat_jobs。

| 实体 | 2B字段及关系 | 约束 |
|---|---|---|
| ChatThread | id、segment_id、create_request_id、create_request_payload、selected_model_id?、permission_mode、revision、active_job_id?、created_at、updated_at、deleted_at? | (segment_id,create_request_id)唯一；revision从1起，接受新轮、修改选择／权限、停止或释放活动任务时递增；关联Segment不可变 |
| ChatMessage | id、thread_id、job_id、ordinal、role、status、content、created_at、updated_at、deleted_at? | role=user/assistant；status=complete/pending/streaming/failed/interrupted；user接受后complete，assistant占位pending；(thread_id,ordinal)唯一，(job_id,role)唯一 |
| Job | id、kind=chat_reply、thread_id、request_id、request_payload、status、input_snapshot、model_snapshot、credential_ref?、permission_mode、execution_token?、error_code?、error?、stop_requested_at?、created_at、started_at?、finished_at?、version、deleted_at? | (thread_id,request_id)唯一；每线程至多一个queued/running/stopping任务，用部分唯一索引保护；快照与请求接受后不可变 |
| Run（扩展） | 新增purpose=verification/chat、job_id?、messages?、deleted_at?；其余沿用2A配置、协议、输出、用量与时间字段 | 旧Run迁移为verification；2B一个Job至多一个Run，用job_id非空唯一索引；问答Run不更新模型验证状态 |
| Segment（扩展） | revision（初始1） | 用户编辑实际改变任一现有字段时递增；仅设置text_locked_at不递增，避免同片段独立线程互相冲突 |

`Thread.active_job_id`与Job的线程归属、活动状态必须在同一事务维护；终态释放时只清除仍指向本Job的指针，不能清掉后续轮次。Message的ordinal在接受事务内分配，每轮连续两个值，历史按ordinal排序而非完成时间。

JobResponse.run_id通过Run.job_id的唯一关联读取，不再在Job存储第二份调用指针。Job在接受时存在，Run在获得共享调用名额、准备实际调用时才创建；queued阶段停止或重启可以没有Run。创建Run不证明上游已收到请求，调用结果未知不能记为0 token。Run保留完整messages、实际配置、prompt版本和脱敏原始输出；Job快照不保存密钥内容，只有后端内部凭据引用。Run.messages对旧verification允许null，对chat必须为接受时固定的非空角色消息列表；purpose对迁移旧行和新建验证行均默认verification，chat显式赋值。`Run.prompt_text`保留旧验证语义，chat使用messages，旧字段写空串且不参与chat请求；不把整个对话扁平拼成一条user消息。

## 3. 线程配置与输入快照

### 模型和预设解析

- 创建线程：`model_id`省略或null时复制当时系统chat默认模型的登记ID；默认未选时允许创建空线程，发送前须明确选模型。复制到线程的指定ID即使失效也不自动换成新的系统默认。
- 发送：非空`model_id`覆盖线程选择，接受成功后成为该线程本轮及后续选择；省略或null沿用线程选择。接入字段在接受时完整复制，worker不重新解析默认值。接受失败不更改线程选择。
- 讲解预设不固化为线程永久绑定：发送`style_id`省略用接受时系统默认；null表示本轮不附加预设；字符串选择具体预设，失效返回409。发送前展示有效预设。每次明确覆盖均不修改全局默认。
- 学习背景使用接受时当前值；权限使用线程当前值。已有线程不受新线程默认权限变化影响。设置或预设在接受后改变／删除，不改变已接受快照。

model_snapshot必须包含Provider内部ID／显示名／revision／base_url、模型登记ID／上游model_id／revision、有效协议、temperature／max_output_tokens／reasoning_effort及stream。credential_ref单独作为Job内部字段保存；公开ModelSnapshotResponse省略base_url和凭据引用。

### input_snapshot v1

快照字段名及内容固定如下：

| 字段 | 保存的输入 |
|---|---|
| snapshot_version | `1` |
| source | id、title、description、updated_at |
| segment | id、source_id、revision、text、translation、context_before、context_after、transcription、source_ref |
| profile | native_language、explain_language、level_note |
| style | null或{id,name,body_md,updated_at} |
| question / additional_instructions | 本轮问题与补充要求；与目标原文、语境分别标记 |
| history | 本线程先前成功Job对应的完整user／assistant消息对，按ordinal排序；保存message_id、job_id、role和实际content |
| references | 2B为上述Source、Segment和历史消息身份；以后选入持久讲解须增加具体Revision／Section等身份和实际内容，不以动态“最新版本”引用替代快照 |
| messages / prompt_version | 按版本模板渲染出的确切角色消息列表及版本；发送前生成并随接受事务保存 |

Source.note和Segment.note是管理备注，2B不自动发送；用户需要补充可填写本轮要求。translation／transcription标为用户提供的译文／听写，不能当作正确答案；context_before／after只作语境，不扩大目标文本范围。

历史查询保留所有成功、失败和中断记录；后续模型输入只纳入已成功的完整轮次，不把失败／中断的残文或孤立问题冒充已完成对话。失败或中断后的“再次发送”将原问题及补充要求放回草稿，用户提交产生新request_id，并按当时配置／资料重新快照；不是重放旧Job。旧轮次不编辑、不删除、不复用身份。

不静默裁剪历史、不自动摘要或额外调用模型。渲染后messages所有content合计最多200000个Python码点，超限在接受前返回422，提示缩短本轮输入或新建线程；这只是本地资源上限，不声称等于上游token窗口。上游上下文超限仍按调用失败记录。所有可调上限集中在执行策略常量中。

`llm/adapters.py::CallSnapshot`现支持角色消息输入，分别转换为Chat Completions和Responses的对应消息结构，保持system／user／assistant边界。2A验证继续使用固定短prompt路径，不被问答消息重构改变；两协议均用离线请求断言检验完整角色／顺序，不使用远端会话ID代替本地历史。

模板放 `backend/prompts/chat/`，文件头声明版本；背景与预设只作适用的问答要求，不每次套完整解析格式。渲染时只使用已读取的快照值，禁止模板内重新查询最新数据。密钥不进入模板、messages、普通API或浏览器持久存储。接受时若本轮请求／快照包含当前凭据的字面或常见编码形式，返回422 credential_in_input，不回显输入并回滚，不替用户改写原文；凭据文件缺失仍按queued执行失败路径处理。

2026-09-27场景限定修复：当前组合版本为v2（`system_v2.j2` + `user_v1.j2`）。普通问答按需要充分解释，不强制整体概括、结构总览、逐块解析或二级标题；专题只覆盖指定范围，总体讲解和报告组织要求仅在本轮明确请求相应产物时适用。历史报告不使后续追问自动沿用报告模式，所选预设中的任务／格式命令不能替代本轮意图。当前没有Analysis／Occurrence成果工具，不得把文本草稿说成已保存成果。保留v1模板和既有Job／Run快照；初始化预设模板及数据库预设均不改动，现有配置由用户手动同步。本次只加强system，不实现快捷总体讲解、动态披露或内部生成子任务。

该修复由实现与测试子代理分工完成，并独立复核。新增4项离线回归覆盖默认／自定义／无预设时的实际消息组装，以及接受后修改预设、模拟未来模板版本且禁止执行期重载时，worker／Run仍使用接受时消息与v2版本。主代理执行 `UV_NO_SYNC=1 just check`：93项后端、5项前端、Ruff／pyright／Biome／TypeScript、生产构建及20份文档／68个链接通过。没有API或数据库schema变更、UI改动、新依赖或TBD定案；没有调用真实模型，测试证明指令加载及快照正确，不证明模型必然遵守场景。

## 4. 接受、幂等与编辑竞争

`POST /api/threads/{thread_id}/jobs` 是唯一接受一轮问答的入口；路由只委托服务。成功返回202，意味着任务和输入已经提交；未提交不能返回“已接受”。

接受事务使用SQLite `BEGIN IMMEDIATE`，顺序如下：

1. 验证请求schema；开启短写事务，检查Source／Segment／Thread存在且未删除。
2. 先按(thread_id,request_id)查已接受请求。规范化后的显式请求内容相同则返回原Job当前状态，包含原身份；即使它已终态或线程有后续任务，也不再检查旧expected_revision或重新解析默认值。同键不同内容返回409 `idempotency_conflict`。已删除对象始终404，不借重放接口读出已删除内容。
3. 对新request_id检查线程空闲、expected_thread_revision和expected_segment_revision与当前一致。冲突返回409，零Job／消息／Run、无原文锁定。客户端刷新当前资料后由用户再次发送，不能自动换键重发。
4. 解析并验证模型、预设、权限，读取Source／Segment、背景与本线程成功历史，构建并校验输入与模型快照。设置初始化须在此事务前完成；不得调用会在内部commit的现有ensure_settings，也不能在事务内发网络请求。
5. 新建queued Job、complete用户消息和pending助手占位；首次设置text_locked_at，更新线程选择／active_job_id／revision，统一commit。任一步失败全部回滚。
6. 提交后唤醒本机调度器。唤醒失败不撤销已接受数据；调度器周期扫描queued表。页面不负责持有执行任务。

幂等payload比较包含规范化后question、additional_instructions、model_id、style_id（区分省略与null）、stream、两个expected_revision；request_id自身不计入。保存完整规范化请求，不仅保存hash。作用域为线程，随记录保留，不设短期过期窗口。客户端一次点击生成一个request_id，响应丢失时保留它并查询／重试同请求；GET、窗口焦点、刷新均不触发新接受。跨浏览器不同request_id竞争时至多一轮被接受，其他409 `thread_busy`。

实现必须同步现有 `services/sources.py` 的update_source、create_segment、update_segment、delete_segment、delete_source的读判断写事务。特别是update_segment须在写锁内重新读text_locked_at，不能使用锁前ORM对象；create_segment须在插入事务里核对Source未删除。先编辑后接受时旧revision冲突，刷新后可接受新原文；先接受后编辑则改原文409，附带信息仍可维护，历史快照不变。相同原文的原样保存不解锁。

## 5. 执行与状态机

Job状态：`queued / running / stopping / succeeded / failed / interrupted`。线程的busy状态由active_job_id表达，不另建可漂移的线程状态枚举。2B不产生awaiting_review。

| 当前状态 | 触发／条件 | 事务结果 |
|---|---|---|
| queued | 获得共享调用名额，在短事务中确认可领取且凭据读取成功 | running，分配新的execution_token，创建running Run并绑定Job，助手streaming |
| queued | 获得名额后凭据读取失败 | Job failed，error_code=credential_unavailable，助手failed，释放线程，无Run |
| queued | 用户停止 | interrupted，error_code=user_stopped，助手interrupted，释放线程；不创建Run |
| running | 完整非空正文、有效完成标志，终态提交获胜 | Job／Run succeeded，助手complete，提交全文与用量，释放线程 |
| running | 异常、超时、空／不完整输出、上限触发 | Job／Run failed，助手failed，保存已有脱敏残文及原因，释放线程 |
| running | 停止事务先提交 | stopping，写stop_requested_at并撤销execution_token；保持线程busy，请求取消本机执行 |
| stopping | 执行退出或取消处理上限到达 | interrupted，Run及助手interrupted，保留停止前已提交残文，释放线程 |
| queued/running/stopping | 后台重启恢复 | interrupted，error_code=process_interrupted；关联未完成Run／消息同步中断，释放线程，零自动重放 |
| 任意终态 | 重复停止、迟到回调、重复领取 | 不改变终态；停止返回当前Job；回调不能写数据 |

每次进度、失败或成功写入都在短事务内检查：Job仍running、execution_token匹配、Thread.active_job_id仍指向本Job、Source／Segment／Thread未删除、关联Run仍running；不满足则丢弃结果。停止收尾事务单独按stopping和active_job_id匹配检查，不要求已撤销的token重新有效；删除／重启恢复亦使用各自明确的状态条件。Job.version每次可见更新递增，客户端丢弃较小version的迟到GET响应。最终Run、Job、助手消息与线程释放同事务提交，禁止先显示成功再异步保存正文。

执行只从持久表领取，按created_at/id排序；每Job最多一次生成，无SDK自动重试、无修复循环。问答与2A模型验证共享同一个进程级生成并发限制2，不能各自再开2个。等待调用名额的Job保持queued，不长期持数据库写锁；排队不占60秒调用预算。获得名额后开启短写事务并重新检查queued、线程及对象状态；在这个事务中读取已固定凭据引用，读取成功才分配token、切running并创建Run，提交后调用。读取失败则在同一事务将Job／助手标failed、释放线程，无Run；停止若先提交则领取不成立、零调用。文件读取是本机小文件操作，不在写事务内访问网络。进入SDK前再次检查本机取消状态；领取后但尚未开始请求即被停止时，不再进入SDK。已进入SDK的请求属于正在进行的调用，停止不承诺撤回上游已接收的请求。Provider／模型停用或配置变更不改已接受任务，旧凭据引用继续可用；删除Provider／模型必须同时检查其未完成chat Job，不能只查已有Run。

从准备调用开始到适配器结束的单次预算60秒；可见输出最多200000码点，超限中止并标failed `output_limit`。模型参数仍使用快照，不统一强塞temperature／token上限。输出／错误沿用2A脱敏，流式保留聚合正文与终止元数据，不保存可跨块重组凭据的delta原包。聚合进度最多每250ms提交一次，结束立即提交；普通文本也执行同样的完整性判定。未知用量为null；未得到上游确认不估算成0。

## 6. 停止、重启与运行所有权

实现中的chat_dispatch_lock在SDK入口和停止／来源／片段删除事务提交之间确定先后；入口持锁核对token和状态，确认进入适配器后放锁，不持锁等待网络。停止先提交则不再进入SDK；已进入SDK的调用再由取消和迟到保护处理。

停止按job_id定位，不能用“停止当前线程”误停已经开始的新轮。停止和成功都以数据库事务提交为判定点：成功先提交就保持成功；停止先提交则撤销token，之后的完成／异常／进度全部无权写入。queued停止直接终态；running先stopping，取消由生命周期管理器处理，浏览器关闭不影响处理。

取消处理最多等待2秒，然后以已持久撤销的token为边界完成本地停止并释放线程；已经发出的请求不能保证上游立即停止或不计费。尚未退出的适配器仍被跟踪并占用原生成名额直至退出，不能提前释放名额造成实际并发越限。停止后可提交新轮，但若名额仍被占用则排队；旧回调仍不能改新轮或恢复写入。停止不撤销停止前已提交数据；2B只有讨论残文，没有工具成果回滚。

同一数据库只允许一个后台执行进程，禁止Uvicorn多worker。应用启动须先取得数据库旁操作系统排他进程锁，再恢复中断任务、提供API并启动调度器；锁随进程退出释放。当前本地macOS／Linux使用标准库fcntl文件锁，无新依赖；无法获得锁则启动失败，不得先运行interrupt_unfinished影响另一个实例。数据库与锁路径先resolve，锁文件不保存密钥。其他平台适配与验证另行完成，不以删除“旧锁文件”绕过活进程锁。

重启不区分“可能尚未发出”和“可能已完成但未提交”来猜测成功：残留任务统一明确中断，保留已保存正文，等待用户再次发送。终态Job／Run不修改；2A残留验证仍按原契约中断，chat任务恢复需同时更新Job、Run、消息与线程，不能继续无差别调用旧interrupt_unfinished后遗漏关联状态。

## 7. 删除与诊断可见性

Source／Segment删除沿用逻辑删除且不提供恢复入口。2B增加来源删除影响中的thread_count、message_count、active_job_count，并提供片段删除影响接口；界面展示将删除讨论及中断任务，确认后提交。预览不是事务锁，最终删除按当时归属核对并执行，不按标题匹配。尚无Analysis／Occurrence时不伪造计数。

同一删除事务标记所属Thread、Message、Job及chat Run的deleted_at；未完成Job／Run变interrupted（reason=content_deleted）、撤销执行token、清除活动指针，提交后请求取消对应本机执行。正常列表、消息／Job详情、request_id查询和chat Run详情均返回404或排除已删除内容；2A独立验证记录不受Source／Segment删除影响。

逻辑删除可在SQLite中保留历史输入供内部诊断，不承诺物理擦除；不能通过通用Run API继续把已删除学习文本作为正常内容展示。物理清理与恢复工具不在2B。与删除同时发生的迟到结果不得重新创建消息、任务或可见内容。删除模型／Provider只影响新选择，其历史快照保留；存在queued/running/stopping chat Job时返回409。

## 8. API契约（已由Pydantic生成OpenAPI）

所有新输入extra=forbid；ID为26位ULID，revision为正整数，request_id为客户端UUID。question必须非空白，NFC后至多10000码点；additional_instructions默认为空，至多10000码点；保留正文内部空白。所有读取先校验当前归属与未删除状态。

| 方法／路径 | 请求与响应 |
|---|---|
| GET `/api/segments/{segment_id}/threads` | `ThreadPage {items,next_cursor}`，limit默认20、最大100；按created_at/id倒序，cursor为编码后的末项(created_at,id)，按二元组严格向后取页 |
| POST `/api/segments/{segment_id}/threads` | `{request_id,model_id?}` →201 ThreadResponse；同Segment创建request_id唯一，原样重放返回同一线程，异payload409；不调用模型、不锁原文 |
| GET `/api/threads/{thread_id}` | ThreadResponse |
| PATCH `/api/threads/{thread_id}` | `{expected_revision,model_id?,permission_mode?}` →ThreadResponse；空闲才可改，model_id非空时须可用，显式null清除；省略不改。陈旧revision或忙碌409 |
| GET `/api/threads/{thread_id}/messages` | `MessagePage {items,next_cursor}`，按ordinal升序，`after_ordinal`默认0，limit默认50、最大100；返回值next_cursor为本页最后ordinal或null；界面自动续取直到当前尾部 |
| POST `/api/threads/{thread_id}/jobs` | `{request_id,expected_thread_revision,expected_segment_revision,question,additional_instructions?,model_id?,style_id?,stream?}` →202 JobResponse，stream默认true |
| GET `/api/threads/{thread_id}/jobs/by-request/{request_id}` | 原已接受Job或404；只查询不发起任务，用于核实丢失响应 |
| GET `/api/jobs/{job_id}` | JobResponse及最新已提交助手正文；后台进度不会依赖此GET |
| POST `/api/jobs/{job_id}/stop` | 无请求体；200 JobResponse，可能为stopping或终态，重复调用无副作用；404已删除／不存在 |
| GET `/api/segments/{segment_id}/delete-impact` | `{segment_id,thread_count,message_count,active_job_count}`；Source既有影响接口增加同名计数 |

线程创建的幂等顺序同样是：先核对Segment／Source未删除，再查创建键并比较规范化的model_id输入（保留省略／null语义），原样重放优先于重新解析默认值或检查模型现在是否可用，返回同一身份的当前ThreadResponse（含后来合法修改的选择）；已删除线程404。新键创建才复制默认权限与模型，显式非空模型须可用，默认模型失效则保留该ID并在发送前提示选择。创建事务须与来源／片段删除串行，不得在其已删除后插入可见线程。

分页统一多取1项确定是否还有后页，next_cursor只有确有后页时非null；线程cursor解码失败或归属不一致返回422。游标携带segment_id及排序元组，仅用于该Segment；不能依靠ULID与created_at恰好同序。消息按`ordinal > after_ordinal`续取，after_ordinal须非负，越过尾部返回空页；既有消息正文的进行中更新通过Job轮询取得，不靠追加游标发现。

ThreadResponse：`{id,segment_id,display_title,selected_model_id,permission_mode,revision,active_job_id,created_at,updated_at}`。MessageResponse：`{id,thread_id,job_id,ordinal,role,status,content,created_at,updated_at}`。JobResponse：`{id,thread_id,request_id,status,version,user_message_id,assistant_message:MessageResponse,run_id,model:ModelSnapshotResponse,permission_mode,question,additional_instructions,error_code,error,created_at,started_at,finished_at,stop_requested_at}`。

ModelSnapshotResponse：`{provider_id,provider_name,provider_revision,provider_model_id,model_id,model_revision,protocol,temperature,max_output_tokens,reasoning_effort,stream}`；均为本次快照，数字参数可null。公开响应不含credential_ref、密钥文件路径；JobResponse不反复传完整input_snapshot／messages。

新聊天端点的领域错误为 `{detail:string,code:string}`，401/403不是本地鉴权分支；不存在／归属错误404，`thread_busy / stale_thread / stale_segment / model_unavailable / style_unavailable / idempotency_conflict`为409，输入和本地上下文上限为422。Pydantic验证错误保留现有脱敏422结构，前端不依赖其携带code。worker错误通过Job.error_code/error表达，如`provider_error / timeout / incomplete_output / output_limit / credential_unavailable / user_stopped / process_interrupted / content_deleted`；错误不回显SDK请求或密钥。

`GET /api/runs`继续默认只返回verification，保持2A设置历史语义；能力摘要所有查询及写回也必须按purpose=verification过滤。`GET /api/runs/{id}`可查询未删除chat Run，但新增purpose、job_id字段，chat详情不使用它推断模型验证状态。不把聊天Run混入“验证两项通过”的计数。

## 9. 界面行为与实现分工

片段工作台增加线程列表／新建、历史、输入框、实际模型和预设选择、可见权限、发送与停止。无需先有讲解。接受成功后立即展示已保存问题、排队状态和助手占位；运行中可编辑草稿但禁用发送与线程权限切换，不排队草稿。模型切换仅在空闲时提交或随下一次接受提交。

发送请求未确认时保留request_id与草稿，显示“正在核实提交”，GET按request_id查询；用户点重试只重发原请求，不偷偷产生新key。2B草稿与待确认请求只在页面内存保留；整页刷新后从服务端Thread.active_job_id和历史恢复，不承诺未提交草稿跨关闭保存，不因刷新自动重试POST。轮询使用TanStack Query，有活动任务时每秒读取Job；终态立即刷新线程和历史后停止轮询。多标签均看到同一已提交状态，不抢占输出。

实现可按以下文件所有权分派，集成者负责共享契约与最终检查：

1. 后端持久化／服务：迁移、新chat模型/schema、接受／查询／停止服务、sources事务和删除范围；先覆盖原子与幂等离线测试。
2. 后台／LLM：Job调度、共享并发、两协议messages适配、Run purpose隔离、生命周期锁与恢复；与服务通过明确的事务函数协作，不各自提交半个终态。
3. 前端：只使用生成类型，工作台、删除影响、轮询与草稿；后端schema确认后先`just gen-api`再接入。
4. 独立测试／复核：不复用实现者自述作为验收结论；强制交错验证并发，实际浏览器验证保存与停止。

实现从0003基线新增0004_chat_jobs迁移（不重写已使用的0001–0003），升级需保留现有来源、片段、配置及验证历史，旧Run新增purpose默认为verification，chat新增表为空。

## 10. 验收矩阵与停止条件

| 场景 | 必须证明的结果 |
|---|---|
| 接受与原文编辑两种提交顺序 | 接受先提交后原文409且快照一致；编辑先提交后旧revision409，刷新后使用新原文；接受事务失败不留下锁、Job或半条消息 |
| 同线程双发送、同键重放与异payload | 只一活跃Job；同键返回同身份、不再解析默认；异payload409；不同线程同片段可分别接受 |
| 接受后修改背景、预设、语境、Source、模型／协议／凭据 | worker严格使用已保存输入与旧凭据引用；其他线程消息不进入请求；不更改全局默认 |
| 停止×领取／进度／成功／新轮 | 两种顺序均可确定终态；撤销token后旧回调无写入权；停止处理完成才可新发；迟到旧轮不能清除新active_job_id |
| queued/running/stopping重启 | 统一可见中断且无真实请求重放；终态历史保持；第二后台实例拿不到锁且不扰动第一实例 |
| 失败与资源预算 | 两协议普通／流式空、缺完成标志、异常、超时、输出过大均不成功；最多一次调用；chat与验证总并发≤2，未知用量为null |
| 删除与创建／接受／执行竞争 | 不恢复已删除Source／Segment／线程；聊天Job、消息与Run不从公开接口漏出；模型／Provider删除拒绝尚未完成chat任务 |
| 历史与2A兼容 | 历史排序与分页稳定，成功轮次可追问，失败残文可见但不自动输入；chat Run不影响验证摘要／列表；0003→head与空库可建且旧数据保留 |
| 浏览器与多观察者 | 保存提问后刷新／离开／重开可找回，轮询不生成调用；模型与权限反馈、停止后发送、重复点击／响应丢失、失败原因、删除范围及窄屏可用 |

实现完成须取得 `just gen-api`、`just check`、空库与增量迁移及浏览器证据；测试禁止真实网络或模型。正文数量和调用成功不证明教学质量。TBD-16在本阶段只落实问答接受／保存核实／单次预算，成果工具、修复循环与TBD-17混合审核仍待其切片；线程命名／单独删除和资料工具不由本契约提前扩展。

## 11. 实现前的契约复核记录

主代理编写，后端审查与测试设计子代理独立复核；已补齐创建线程的持久幂等字段、稳定分页、角色消息适配，以及凭据读取／领取／Run创建顺序。当前未发现阻塞2B开工的契约矛盾，功能仍待实现。

本轮仅修改文档，没有后端schema或产品界面改动，因此未生成占位API类型、未迁移数据库、未作2B浏览器或真实模型验收。`just check-docs`最初因uv尝试重建本地包时无法访问PyPI失败；随后使用已有环境执行`UV_NO_SYNC=1 just check`，55项后端、2项前端、lint／类型检查、生产构建及20份文档／66个本地链接全部通过，`git diff --check`通过。现有测试通过仅证明基线未受文档修改影响，不代表2B并发与停止行为已经实现或测试通过。


## 12. 实现与收口验证

实现由后端持久化、后台执行、前端工作台三个原生子代理按文件所有权分工；主代理集成并编写接口／运行器／协议／迁移测试，独立审查与测试代理复核竞争窗口和恢复，浏览器由未参与前端开发的代理验收。

- 已实现线程创建与选择、后台问答／追问、实际输入和模型快照、同事务原文锁定、持久消息、停止／迟到保护、重启中断与单实例执行锁。
- 新增0004_chat_jobs增量迁移；Run以purpose隔离chat与verification，聊天不会改变2A能力状态。来源／片段删除影响包含线程、消息和活动任务，删除后相应历史与Run不从公开API重新出现。
- 前端通过TanStack Query轮询持久任务；线程先结束而Job尚未读到终态时也刷新历史。接受请求未确认或服务端5xx时保留同一request_id核实；收到接受确认只清除仍等于提交内容的草稿，不擦除用户新输入。

验收中关闭的缺陷：

| 触发与影响 | 修复与证据 |
|---|---|
| Job与消息同时flush导致外键顺序错误 | 先持久Job再写两条消息，统一事务；API接受与回滚测试通过 |
| SQLite读回naive时间后分页游标被自身校验拒绝 | 编码前恢复UTC，分页与跨页新建测试通过 |
| 停止在最后状态检查后先提交，旧执行仍能进入SDK | 调用握手与停止／删除提交共用chat_dispatch_lock；强制交错证明停止不能插入检查与SDK入口之间，停止／删除先赢时SDK调用数为0 |
| 忽略取消的旧适配器可能提前释放调用名额，或超长残文落库 | 跟踪真实任务、取消只发一次、旧任务退出才释放名额；超限残文截断，超限result/raw不落库；共享并发及输出上限测试通过 |
| 当前凭据误粘贴进问题／原文后可复制入Job和Run | 接受前拒绝含本次凭据的冻结输入，不改原文，422不回显且不留任务／消息／锁；参数化回归通过 |
| 前端先观察到线程空闲，历史却停留在生成中；确认接受时擦掉新草稿 | 独立监听线程revision／active_job_id，保留与已提交内容不同的草稿；3项新增前端纯逻辑测试覆盖，包括5xx核实策略 |

新鲜自动化证据：Python3.11.14；`UV_NO_SYNC=1 just gen-api`与`UV_NO_SYNC=1 just check`通过，包含86项后端、5项前端、Ruff／pyright／Biome／TypeScript、生产构建及文档链接。测试含两协议×普通／流式共4项实际SDK内存HTTP请求形状验证；独立8项强制交错／恢复测试与独立3项阻塞修复复核通过。所有测试离线，没有新的真实模型调用或伪造录制文件。使用已有环境是因为前轮已确认uv依赖同步受PyPI访问限制，本轮未添加或升级依赖。

本机迁移在确认无未完成Run并取得执行锁后运行，升级前保留了SQLite备份；0003→0004后原有8张业务表原字段内容摘要一致，完整性和外键检查通过。临时库还验证了空库重建与旧验证Run迁移为verification。Git候选文件与SQLite普通记录不含本机实际凭据及所检查的常见编码，凭据目录／文件权限仍为0700／0600。

剩余边界：2B只实现文本问答，未交付成果保存工具、Section编辑、Occurrence、混合审核或自动修复；TBD-16只收口单次问答部分，TBD-17保持未决。历史过长不自动裁剪／摘要，达到本地上限明确拒绝；未提交草稿不承诺跨整页刷新保存。当前进程锁使用macOS／Linux的fcntl，其他平台尚未适配验证。停止不能保证上游已接收请求立即停费，仍遵守旧任务不再落地和共享名额不提前释放的本地保证。


实际浏览器：原控制入口不可用且原生连接挂起后，改用Codex已捆绑的Playwright启动系统Chrome无头浏览器，不安装仓库依赖；使用独立临时SQLite与明确的离线适配器。首问成功、原文锁定／编辑409、刷新找回历史且验证Run列表不混入chat、成功追问、失败原因及问题／补充要求双字段回填、运行中可编辑草稿但不能发送、刷新后停止及停止后再次发送、同片段独立线程、片段删除影响预览与取消均通过。390×844视口的clientWidth与scrollWidth均为390，无横向溢出；页面console与pageerror均为空。截图已检查，临时Chrome与服务已关闭，未修改用户Provider或调用真实模型。

覆盖界限：本轮没有在浏览器模拟响应丢失、后台重启、多标签同时操作和来源删除确认；这些边界由对应API／竞态／前端纯逻辑测试支持，不描述为浏览器已全部实测。真实模型的教学质量与多轮使用效果仍需实际使用评估；此前DeepSeek四次文本验证不是2B真实多轮验收。

结论：本阶段识别的阻塞问题已修复并独立复核，2B离线验收通过。保留所有既有提交，以后端、前端和验收记录分批提交并快进集成；不自动推送远端。下一切片需先细化成果保存、讲解修订与工具审核契约，不能因2B文本问答可用而认定工具能力已验证。

## 13. A.3视觉对照修正（2026-09-27）

用户指出2B首版没有落实当时的 A.3 对话列表原型截图。此前的浏览器验收证明了功能可用及窄屏无溢出，未充分对照视觉参考的布局和信息密度，不能据此声称已符合A.3。该原型于2026-10-25完成历史使命后移除，旧截图可从 Git 历史查阅。

本轮只调整前端呈现：移除目录式大标题／原文卡片与下方讨论表单的堆叠，采用56px图标栏、54px工具栏、左阅读右对话的专注工作台；右栏在列表和详情间切换，助手正文保持轻量，输入位于栏底，补充要求可折叠，当前权限始终可见。收起对话把宽度还给阅读；原文编辑和删除进入顶部菜单。没有引入未实现的讲解、学习条目或审核界面，没有修改后端、schema、模型调用或TBD边界。

独立Chrome离线验收：1440×900桌面文档尺寸等于视口，右栏约418px；列表／详情与收起／展开均保留问题及补充草稿，运行中切换视图不取消，停止后草稿保留且可再次发送。菜单Escape关闭、原文编辑弹窗和删除影响确认／取消通过。390px窄屏无横向溢出。主代理及未参与实现的视觉复核代理均逐张对照A.3列表／详情参考与最终桌面／手机截图，未发现遮挡或视觉阻塞。

`UV_NO_SYNC=1 just check`通过：86项后端、5项前端、lint／类型检查、生产构建及文档链接。未新增依赖或真实模型调用，临时验收数据与用户数据库隔离。当前列表显示真实首问标题、状态和时间，尚无原型中的最近内容两行摘要；后续可按真实数据补充，不伪造摘要以凑齐外观。
