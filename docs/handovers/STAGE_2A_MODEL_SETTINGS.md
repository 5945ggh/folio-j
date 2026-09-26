# 第二阶段 2A：设置与模型接入

状态：实现与设置界面打磨已完成，保留在功能分支待集成。承接 PRD F1；2B/2C 的学习片段讨论、原文锁定与线程历史不在本次交付范围。

## 交付与边界

- 设置入口提供学习背景、命名讲解预设与默认预设、Provider、模型、三种用途默认值及新线程默认权限维护。
- Provider 默认协议为 `chat_completions` 或 `responses`，模型可覆盖；模型列表尝试获取并可刷新，也始终允许手动登记模型 ID。刷新失败保留缓存与手动模型；列表消失不删除已登记模型。
- 按需分别验证普通文本和流式文本；验证使用固定且带版本的短 prompt，结果和错误可重开查看。列表可访问不等于文本可用，文本可用不等于结构化输出或工具能力已验证。
- 模型验证在本地后台执行，页面刷新／关闭不重复调用或取消任务。此阶段以 Run 管理单次验证；多步骤 Job 与线程轮次留到 2B，不提前建设通用 Agent 循环。
- 设置分为模型接入与学习偏好。Provider 顶部可点击折叠，启停操作直接展示，编辑和更新 API Key 使用弹窗；模型使用紧凑表格，窄屏按行展开。发现列表可勾选未登记模型，部分失败保留已登记结果并允许重试；手动登记继续可用。
- 模型行的“可用性验证”下拉支持单项或两项重新验证，并说明调用次数。行内状态自动更新，失败原因对应具体能力的 Run。结构化输出尚未开放验证，汇总仅统计两项文本验证，不宣称 Provider 整体健康。
- 用户提供的真实验收来源为 DeepSeek 官方，两个配置名 `deepseek-chat`、`deepseek-response`，模型均为 `deepseek-flash`。此为验收数据，不是产品硬编码或默认 Provider。

## 持久化与凭据

- 配置、模型、学习背景、预设、用途默认值及 Run 使用当前 SQLite；增加一份后续迁移，保留已有来源与片段。
- 凭据独立保存在数据库旁的 `<数据库文件名>.secrets/`，目录 0700、文件 0600，文件名使用内部生成身份；SQLite 只保存凭据引用。API Key 输入使用 UTF-8 文本并 strip；请求省略 `api_key` 表示保留，提供空串表示清除。普通响应只含 `has_api_key`，不返回密钥或凭据文件路径。无密钥配置允许本地无鉴权服务。
- 凭据是本机明文文件，依靠文件权限保护，不声称已加密；密钥不进入模型消息、Run、错误信息、浏览器存储或 Git。服务端校验错误也不得回显包含密钥的请求输入。
- 更新凭据创建新引用；已接受验证固定原有引用与非敏感配置快照，不重新使用最新默认值。历史 Run 不保存凭据内容。旧凭据保留供已接受任务完成，物理清理后续按明确引用策略处理。
- Provider 可停用（只阻止新验证与选择，仍可手动拉取模型列表），停用不改变已接受快照；存在 queued/running 验证时删除 Provider 返回 409，否则逻辑删除，历史 Run 保留。不能自动改用其他 Provider 或模型。
- 地址允许 http/https，禁止 URL 用户信息、查询和片段，防止凭据混入地址；不限制正常本地无鉴权地址。

## API 契约

新 schema 单独放 `settings_schemas.py`，配置 ORM 可放 `settings_models.py`；不要把所有新增内容堆入现有 Source 文件。

| API | 用途 |
|---|---|
| `GET /api/settings` | `SettingsResponse {profile, styles, defaults}` |
| `PUT /api/settings/profile` | `ProfileInput {native_language, explain_language, level_note}` → ProfileResponse |
| `POST /api/settings/styles` | `StyleInput {name, body_md}` → 201 StyleResponse |
| `PUT /api/settings/styles/{style_id}` | 同上，更新预设 |
| `DELETE /api/settings/styles/{style_id}` | 204；当前默认预设不能删除，返回409 |
| `PUT /api/settings/defaults` | `DefaultsInput {analysis_model_id, chat_model_id, extraction_model_id, style_id, permission_mode}`；前三项为登记模型记录ID或null，权限为 `review`/`full_access` |
| `GET/POST /api/providers` | 列出／创建 Provider |
| `GET/PATCH/DELETE /api/providers/{provider_id}` | 读取／部分修改／逻辑删除 |
| `POST /api/providers/{provider_id}/refresh-models` | 尝试刷新发现列表，响应 ProviderResponse；错误状态持久保存，仍返回缓存 |
| `POST /api/providers/{provider_id}/models` | 手动登记模型 → 201 ModelResponse |
| `PATCH /api/provider-models/{model_id}` | 修改协议覆盖、参数或启用状态 |
| `POST /api/provider-models/{model_id}/verifications` | `{stream:boolean}` → 202 RunResponse；每个请求一次调用，界面的双项验证显式提交两个请求，不自动遍历模型 |
| `GET /api/runs` | 最近验证记录；默认50条，支持 `limit`（1–50）与 `offset` 分页，无敏感字段 |
| `GET /api/runs/{run_id}` | 持久状态、非敏感快照、文本及错误，前端在 queued/running 时轮询 |

ProviderInput：`name`、`base_url`、`protocol`、可选 `api_key`、`enabled`（默认true）。ProviderResponse：`id,name,base_url,protocol,enabled,has_api_key,models,discovered_models,discovery_status,discovery_error,last_discovered_at,revision,created_at,updated_at`。发现状态 `never/succeeded/failed`；发现模型为 ID 字符串数组。

ModelInput：`model_id`（上游 ID）、`protocol_override`（null 表示继承）、`enabled`、`temperature`（可空）、`max_output_tokens`（可空）、`reasoning_effort`（可空，或none/low/medium/high）。ModelResponse 另含内部 `id,provider_id,effective_protocol,revision,text_status,stream_status`；能力状态为 `unknown/succeeded/failed`，基于当前配置版本，修改 Provider 接入配置／凭据或模型参数后旧验证不冒充当前结果。删除/停用配置使原默认模型失效，显示明确状态，不自动切换。

ModelResponse 还返回 `text_verification`／`stream_verification`，为空或 `{id,status,created_at,finished_at,error}`。摘要按 Provider 与模型内部身份及当前修订筛选，再按创建时间和 ID 取最近接受的 Run；不依赖全局最近50条记录。前端在有 queued/running 摘要时轮询 Provider；终态可直接从模型行查看。较早接受的同能力 Run 即使较晚结束，也不覆盖较新验证的能力状态。仅改名、启停或原样保存不使能力失效；实际接入配置／参数变化或显式凭据替换才更新修订。Provider、Run 及摘要的时间统一返回带时区的 UTC。

RunResponse 至少含 `id,provider_id,provider_name,model_id,protocol,stream,status,output_text,error,usage,prompt_version,created_at,started_at,finished_at`。`model_id` 为上游模型 ID；status 为 `queued/running/succeeded/failed/interrupted`。使用量统一输入／输出／总token，可为空；不得用未知用量冒充0。

所有输入拒绝未知字段，文本有长度上限；PATCH 可省略，只有契约中明确可空的覆盖值允许null。默认设置由服务层确定性初始化；默认讲解预设基于既有 v0.1 风格模板，按当前PRD整理而不恢复旧流水线。前端只消费生成类型，Provider凭据保存成功后清空输入。

## 执行与接入

- 使用技术栈已选定的 `openai`、`Jinja2`，本切片按需安装并锁定。无新 Agent 框架，前端无新依赖。
- 所有出站请求经 `llm/`，普通／流式两种协议分别适配，生产文本验证使用同一层；模型列表请求不是生成调用，但记录发现状态。
- 每次实际生成调用有一条 Run；SDK 自动重试设为0，本次按需验证一轮一次，超时限制60秒，最大并发2，杜绝多层重试。验证的请求、输出、用量、实际协议与prompt版本留存。非流式保留脱敏 SDK 响应；流式保留脱敏聚合正文、完成状态、用量和事件计数，不保存可跨块重组密钥的原始 delta 碎片。
- 持久化 accepted Run 后由 lifespan 管理后台执行；每次结束及时提交。重启将原 queued/running 标为 interrupted，不自动重放真实请求。测试可关闭 worker 或注入离线 adapter；接口和worker必须复用同一接受/执行服务。
- 验证 prompt 固定短文本，参数仍遵守用户模型设置；可设置 token 上限及 reasoning_effort，不对所有模型强加温度或推理参数。流式累积可见正文，不把 reasoning 内容冒充正文；完成标记缺失、incomplete/failed、空输出不能记为成功。流式进展通过持久 Run 文本与轮询可见，后续讨论 SSE 不依赖单个共享消费队列。
- 不发起 Provider 远端后台任务；本地执行不依赖页面或远端会话ID。普通错误不触发协议、模型或Provider切换。

## 验收

- 离线测试：配置／预设／默认值、密钥strip/保密/文件权限、无鉴权、列表缓存失败保留、模型覆盖、能力失效、任务快照、两协议普通与流式解析、异常/超时/不完整、重启中断、前端生成契约。
- 浏览器：设置入口、保存重开、隐藏密钥、两个Provider及手动模型、选择默认模型、分别启动普通/流式验证、刷新查看、错误反馈与窄屏。
- `just lint`、`just test`、`just gen-api`、构建及文档检查。pytest 不联网；用户此次明确授权使用本机密钥做少量实际验收，独立于pytest，不生成伪造录制文件。真实验收先各拉一次列表，再同模型各一次普通与流式验证；初始最多4次生成，失败先诊断，不无界重试。
- 不覆盖用户已有设置；通过正常服务入口创建两份明确命名配置。真实密钥文件位于用户提供的已忽略路径，读取不打印内容，调用只发往该用户授权的 DeepSeek 官方端点。

## 参考与后续

- [OpenAI 流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)：两协议事件形状分别处理。
- [DeepSeek Chat](https://api-docs.deepseek.com/api/create-chat-completion/)、[Responses 指南](https://api-docs.deepseek.com/guides/responses_api/)：DeepSeek思考默认开启；真实文本对照配置显式选择 `reasoning_effort=none`，模型固定 deepseek-flash，协议身份单独记录。
- 触及 TBD-16 的单次执行预算与保存核实基础，尚不完成工具写入/恢复契约；TBD-17 组合审核仍待写入阶段。2B接入片段上下文、Job和原文锁定，2C持续讨论；不将2A验证界面作为学习对话入口。

## 验证记录

- Python 3.11.14：42 项离线后端测试通过；测试子代理独立复核了并发初始化、配置快照、最大并发、重启中断、无鉴权请求头、流式终止及跨块凭据脱敏。
- 真实 DeepSeek 官方验收（2026-09-26）：两个 Provider 均成功获取模型列表，列表含 deepseek-flash 与 deepseek-v4-pro；生成仅使用用户指定的 deepseek-flash。

| 协议 | 模式 | 结果 | 输入／输出／总 token |
|---|---|---|---|
| Chat Completions | 普通 | succeeded | 24 / 21 / 45 |
| Chat Completions | 流式 | succeeded | 24 / 22 / 46 |
| Responses | 普通 | succeeded | 24 / 15 / 39 |
| Responses | 流式 | succeeded | 24 / 27 / 51 |

四次短调用合计181 token，实际结果保存在本机 Run 中；这证明该配置的文本接入可用，不证明教学质量、结构化输出或工具兼容性。没有自动遍历或验证其他模型。

- 首轮主代理完成 `just check`：Ruff、pyright、Biome、TypeScript、42项pytest、生产构建和19份文档／58个本地链接均通过；API类型已重生成。
- 使用实际密钥的只读边界检查通过：Git候选文件、SQLite普通记录及公开API响应均不含密钥，凭据目录／文件权限为0700／0600。
- 前一轮浏览器已验证学习背景和预设创建、默认预设切换、刷新持久化，并看到真实 Provider 的成功状态及 Run 历史；当时删除确认和窄屏验证受浏览器连接问题阻碍。
- 本轮界面验收使用独立临时数据库与明确标注的离线假适配器，阻断出站连接；已补验删除确认居中／取消、发现模型登记、行内验证开始与成功／失败、对应失败原因、运行中刷新及窄屏。未重新调用真实模型或修改用户 Provider 数据。
- 当前检查通过：48 项后端测试、2 项前端纯逻辑测试、Ruff／pyright／Biome／TypeScript、生产构建和文档链接检查。摘要已随 OpenAPI 重生成前端类型；没有新增依赖或数据库迁移。
- 当前保留在 `codex/model-settings`，尚未并入 main，暂不归档。凭据仍为本机文件，旧凭据暂不自动清理；全局多步骤任务、工具审核、结构化验证与模型删除接口仍未实现。跨标签页同时登记同一模型的数据库唯一约束仍待补充，本轮未改变数据库 schema。
