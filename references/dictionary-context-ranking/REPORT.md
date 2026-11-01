# 日语查词结果的语境排序：小模型可行性调查

调查及讨论日期：2026-10-28。调查范围为日语原文到日语／中文释义，排除生成式 LLM 路线。本次核查公开模型、论文与部署资料，并只读分析用户提供的词典；没有运行模型、训练或测量本机推理性能。下方记录后续讨论确认的方向，第 1–7 节保留模型研究依据；这些内容尚未实施，未修改当前交付范围、技术依赖或 TBD。

**后续优先建立不依赖 definitions 的卡片重排基线。** Yomitan 的内容结构不统一，明镜样本的可抽取性不足以支撑通用义项适配。先复用已有 Sudachi 结果提升有明确词元对应关系的卡片；整卡语义重排随后评估，卡片内部义项理解作为较低优先级的独立研究方向。

**模型研究结论：现成预训练模型可作为实验起点，尚无证据需要从头预训练。** 进入义项研究时，可尝试“小型日语 cross-encoder + 目标词典义项排序后训练”。用户提供的双解词典保留日文定义，可先用日语判断义项，再展示对应中文。最大的待验证项是细粒度义项质量、目标词定位和低置信回退，模型文件大小已有几十 MB 的候选。

**尚未找到同时满足“小型、日语目标词消歧、任意导入词典义项、直接部署”的现成成品。** 通用检索重排模型可以立即作为实验基线；公开 WSD 模型则绑定特定词义体系和训练语料。两者都不能仅凭模型名称或通用榜单证明优于用户当前的 Yomitan 查词体验。

2026-10-31 首轮采用[即时查词阶段计划](../../docs/handovers/archived/epub-reading/DICTIONARY_PLAN.md)的长匹配优先规则。下节记录此前的备选顺序。

## 后续讨论确认的卡片级方向

用户确认先考虑以下基线，尚未开始功能开发：

1. **不依赖 definitions。** 保留卡片内部内容，先不抽取或重排其中义项，也不为补齐词性而解析异构正文。
2. **两路召回。** 查询鼠标所在的完整 Sudachi 词元，同时保留从原始鼠标位置开始的有界扫描查询，合并去重。这样鼠标落在词中部时，仍能召回完整词元；用户主动选定文本时以明确选区为准。
3. **对应词元的候选置前。** 将能确认与目标词元完整对应的卡片提升，其余卡片沿既定顺序接续；第一版两组内部也保持原顺序。
4. **对应关系核对原文位置与词形。** 此处对象为具体 token，不是抽象 lexeme。保留候选的原文匹配范围与还原路径；不能只比较词头字符串，也不能要求活用表层等于词典原形。不能确认对应关系的情况留在普通组。
5. **重排可开关。** 用户接受 A 粒度短词卡片可能排在正确长表达之前的取舍，长表达候选仍然保留。关闭重排恢复基线顺序；默认开关状态尚未确定。
6. **高亮与实际匹配一致。** 选中或展示短词候选时，高亮不得继续沿用其他长候选的范围。

Sudachi 提供部分候选的排序证据，不限定全部候选的召回。项目已有词元位置、表层、读音、词典形、规范形、六项词性和 OOV 标记，可复用。Yomitan 的规则字段是反活用校验信息，不是统一 POS；词典标签缺失时保持中性，私有 score 不直接跨词典比较。

本轮核查 Yomitan 源码确认，其查询会对扫描文本逐步缩短前缀并反活用，再分组和排序；扫描范围与上下文句界分别处理。后续实现只借鉴候选保留思路，不要求复刻全部行为。[查询逻辑](https://github.com/yomidevs/yomitan/blob/master/ext/js/language/translator.js)、[扫描逻辑](https://github.com/yomidevs/yomitan/blob/master/ext/js/language/text-scanner.js)

这条基线优先评估：多少查询能得到明确提升、正确卡片向前移动多少次，以及错误提升短词导致长表达后移多少次。整卡语义排序可以在此后独立比较；无需先解决内部义项边界。

## 1. 实际需要排序的对象

一次查词至少有三层歧义：原文匹配范围／活用还原、词条及读音、词条内部义项。前两层的候选没有召回，义项排序再好也无法修复。应保留原文目标的确切字符范围，让模型比较每个候选的表记、读音、词性和单个释义。

建议实验任务为：

    原句及必要前后文 + 目标字符范围 + 候选义项集合
        → 每项匹配分数 + 可接受的候选集合
        → 展示词条，并突出其中最贴合语境的义项

例如“人気”的 にんき／ひとけ／じんき、“上手”的 じょうず／うわて／かみて，兼有读音和词义差异。“掛ける”即使只召回一个词条，内部仍有许多不同用法。只排列整张词条卡片，不能处理后一类问题。

有些语境没有唯一读音答案，例如“明日”的 あした／あす／みょうにち；语体能提供倾向，但不能总能恢复作者心中的唯一读法。“開く”的两个读音也有语义重合。原书 ruby、音频或明确语法线索可以提供证据；已有 Sudachi 自动读音适合作为特征，不应提前删除所有其他候选。

Yomitan 的现行格式和设置支持静态条目分数、词频排序等机制。因此应在相同候选集合上，与用户实际词典优先级、词频配置和原始排序比较，而非与随机顺序比较。[格式定义](https://github.com/yomidevs/yomitan/blob/master/ext/data/schemas/dictionary-term-bank-v3-schema.json)、[排序设置](https://github.com/yomidevs/yomitan/blob/master/ext/settings.html)

## 2. 用户提供的词典揭示了什么

样本：temp/明镜日汉双解词典_Yomitan 1.4.3.zip。内部标题“明鏡日汉双解辞典”，format=3，revision=MeikyouShuangjie_20240624_1.4.3，sourceLanguage=ja、targetLanguage=zh。以下数字由本地脚本读取全部 28 个 term bank 得出，详细记录见 [dictionary-stats.json](dictionary-stats.json)，复现脚本见 [inspect_dictionary.py](inspect_dictionary.py)。

| 项目 | 本地观察 | 对设计的影响 |
| --- | ---: | --- |
| ZIP / 解压内容合计 | 16,156,321 / 317,695,123 字节 | 压缩包体积不能代表导入后体积或解析内存 |
| 8 字段记录 | 139,462 条 | 多个检索入口可能指向同一词条 |
| 不同 sequence | 61,259 个 | 本样本同 sequence 的释义内容哈希全部相同，可去重 |
| 不同表记 | 122,374 个，其中 9,432 个对应多个 sequence | 表记本身不构成词条身份 |
| def1 / def2 结构节点 | 91,377 / 88,146 | 是转换器结构计数，尚不能直接称为确切可排序义项数 |
| 中文 dfcn 节点 | 87,671，覆盖 60,470 个 sequence | 中日释义通常在同一个定义节点内，可直接关联 |
| exam 节点 | 68,526，覆盖 32,983 个 sequence | 可提供弱监督；不是同等数量的合格自然句金标 |
| 条目 score | 全部为 0 | 本文件没有可直接利用的非零静态分数 |

本样本用 structured-content 的 data.class 标记 head、def1、def2、dfcn、exam、exjp、excn。日文定义与中文解释共存，例句也有中日对应。**显示中文不要求模型必须跨语言理解中文定义。** 对这本词典，先按日文义项打分，是最直接的减负方式。

但 format 3 本身并不规定 def2 就是统一义项类型；它允许字符串、图片和结构化内容，data 是通用属性。这里的 class 是该词典转换器的约定。通用导入可以保留原渲染内容；义项抽取需要按词典适配器进行，对无法拆分的词典回退到词条级排序，明确能力差别。[官方 schema](https://github.com/yomidevs/yomitan/blob/master/ext/data/schemas/dictionary-term-bank-v3-schema.json)

建议派生义项键使用“词典版本 + sequence + 定义树路径”，同时保留父级词性、父级限定、原文节点位置和中文对应位置。不能将 sequence 当跨词典通用 sense ID，也不能仅靠圈号切分：圈号可能分层、重复，引用和语法说明也可能夹在正文中。词典更新后需重新核对节点身份。

例句中的“～”、词干加活用符号、可替换方括号、片语和省略，不能统一用字符串替换就视作自然句。还要处理仅有参照链接的定义、跨父级继承的限定、同一例句对应多个合理义项。

压缩包只有 index 和 term bank，未附许可文件。本次保留统计与结构分析，不复制词典正文。若进入后训练或分发阶段，需要另行核实词典内容、训练用途与产物分发的授权范围；持有这份文件不能单独证明这些权限。

## 3. 优先比较哪些模型

下表大小为单份主权重／ONNX 文件，均按十进制 MB；不包含完整运行时、tokenizer、索引，也不等于 RAM。许可为所链接模型卡声明。

| 模型 | 定位与规模 | 已核实主文件 | 本项目用途 |
| --- | --- | --- | --- |
| [japanese-reranker-xsmall-v2](https://huggingface.co/hotchpotch/japanese-reranker-xsmall-v2) | 日语 cross-encoder，36.8M，MIT | FP32 147 MB；[INT8 ONNX 37.4 MB](https://huggingface.co/hotchpotch/japanese-reranker-xsmall-v2/tree/main/onnx) | **首选起点**；比较上下文与单个日语释义，随后做义项排序后训练 |
| [ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m) | 日语 bi-encoder，36.7M，256 维，Apache-2.0 | [FP32 147 MB](https://huggingface.co/cl-nagoya/ruri-v3-30m/tree/main) | 速度与缓存对照；候选释义向量可预计算 |
| [bert-base-japanese-v3](https://huggingface.co/tohoku-nlp/bert-base-japanese-v3) | 日语 BERT，约 111M，Apache-2.0 | [PyTorch 447 MB](https://huggingface.co/tohoku-nlp/bert-base-japanese-v3/tree/main) | 有标注后复现 GlossBERT 类方法的基线；原模型没有训练好的排序头 |
| [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) | 多语 bi-encoder，约 118M，384 维，MIT | [ONNX FP32 470 / INT8 118 MB](https://huggingface.co/intfloat/multilingual-e5-small/tree/main/onnx) | 纯中文释义词典的首个跨语基线；遵守 query: / passage: 输入约定 |
| [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) | 50 语言相似度模型，约 118M，384 维，Apache-2.0 | [ONNX FP32 470 / INT8 118 MB](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/main/onnx) | 次级对照；默认句长上限 128，不能因名称有 MiniLM 就当成约 20M 的英文小模型 |
| [gte-multilingual-reranker-base](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base) | 多语 cross-encoder，306M，Apache-2.0 | [FP16 约 612 MB](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base/tree/main) | 日中联合理解的较大参照，优先用于离线比较，不作为最轻部署起点 |

若后续启动模型实验，首轮只需要 xsmall-v2、ruri-v3-30m 和非神经基线。等确认实际需要支持“只有中文释义”的词典，再加入 e5-small 与 GTE。直接同时引入全部模型，会扩大下载和评测负担；当前优先的卡片级基线不引入这些模型。

xsmall-v2 已经学过日语句对相关性，且提供 ARM64／AVX2／AVX512／VNNI 的现成量化文件；其公开任务仍是检索重排，未证明会区分同词的相邻义项。Ruri 和 E5 的整句 embedding 也可能更关心句子整体主题，忽略被点击的那一个词。因此输入必须突出目标位置，并以真实消歧评测判断是否需要后训练。

其 ModernBERT-Ja 基座使用 SentencePiece，无需 MeCab 预分词；作者也提醒子词边界不总与形态素对齐，span extraction 等任务有局限。本任务可以由阅读器传入确切 span，让模型只负责句对排序。[基座说明](https://huggingface.co/sbintuitions/modernbert-ja-30m)

Tohoku BERT 的前处理则需要 MeCab + UniDic。它可作独立研究对照，但与项目当前采用 Sudachi、明确不选 UniDic／MeCab 的决定不同，不应直接加入生产依赖。GTE 的官方加载还涉及自定义模型代码，浏览器部署要额外核查导出与算子支持。[Tohoku 模型卡](https://huggingface.co/tohoku-nlp/bert-base-japanese-v3)、[GTE 模型卡](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base)

### 现成 WSD 权重能省多少工作

[GlossBERT](https://aclanthology.org/D19-1355/)及其[官方 checkpoint](https://github.com/HSLCY/GlossBERT)把目标上下文与候选释义配对，并比较目标词标记等输入方式。它证明了这类训练结构可用，但公开实验基于英语 SemCor／WordNet。可以移植方法，不能把其英文权重当作现成日语消歧器。

[BERT-WSD](https://aclanthology.org/2020.findings-emnlp.4/)把同一词的候选释义作为选择目标，并加入词典例句；[gloss-informed bi-encoder](https://github.com/facebookresearch/wsd-biencoders)则将目标上下文和释义分别编码。它们分别支持本报告的两条算法路线，不提供当前双解词典的现成标签。

[XL-WSD](https://github.com/SapienzaNLP/xl-wsd-code)确实提供 mBERT／XLM-R 的跨语 WSD checkpoint。其词义体系为 WordNet／BabelNet，项目标明非商用许可；任意用户词典与这些 ID 的映射仍需解决。本次确认发布链接，未下载验证权重可用性。

还有直接日语证据：2021 年一项[日语词典释义 WSD 研究](https://www.thinkmind.org/articles/eknow_2021_2_40_60028.pdf)在 SemEval 的 50 个目标词上结合岩波释义、例句与 NWJC-BERT，最高报告约 79.68%。这是小模型日语路线的可行性证据，测试粒度、词汇范围和词典都不同于当前产品，不能换算为本项目准确率。

## 4. 成本：已知数字与仍需实测的部分

### 磁盘、下载和索引

权重理论大小为“参数量 × 每参数位数 ÷ 8”。但部分层不量化、图结构和量化元数据都会改变实际文件大小，应优先取上表的现成 artifact。量化名称也不保证大小关系：同一 [MiniLM 的 JS 导出目录](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/tree/main/onnx)中 q4 为 399 MB、q4f16 为 205 MB，q8 为 118 MB，不能直接假设 q4 最省空间。

小模型仍有 tokenizer 成本。例如 E5 的仓库列有约 17.1 MB tokenizer.json；应按选定运行时需要的文件打包，避免把同一 tokenizer 的不同表示、所有精度模型一起下载。[文件目录](https://huggingface.co/intfloat/multilingual-e5-small/tree/main/onnx)

若有效下载速度为 10 MB/s，37.4 MB 与 118 MB 主模型的纯传输时间约 3.7 秒与 11.8 秒；这是算术示例，未包含 tokenizer、连接、校验和初始化。首次安装下载应与每次查词延迟分开。

cross-encoder 不要求存储全词典向量。bi-encoder 可缓存每个义项向量，原始空间为“义项数 × 维度 × 每维字节数”。假设本样本的 88,146 个 def2 节点最终各对应一个向量，则：

| 向量格式 | 256 维 | 384 维 |
| --- | ---: | ---: |
| FP32 | 90.3 MB | 135.4 MB |
| FP16 | 45.1 MB | 67.7 MB |
| INT8 | 22.6 MB | 33.8 MB |

这是按结构节点数计算的容量示例，未包含文本、ID、量化 scale 等开销。权重量化和输出向量量化是独立决定。查词已召回十几项候选时，只需读取这些向量做点积，无需为此建设全词典近邻搜索服务。

### RAM

**37.4 MB 是模型文件大小，不能据此声称运行只用 37.4 MB 内存。** 需要计入运行时、tokenizer、模型／预打包副本、激活、工作区、arena、输入输出和应用本身。ORT 的 arena 等分配策略也会影响峰值与释放行为。[ORT API](https://onnxruntime.ai/docs/api/python/api_summary.html)

本轮未找到针对“这些模型 + 查词长度 + 少量候选”的可靠进程总内存数据，也没有本机测量。可在原型阶段先设工程预算：xsmall-v2 常驻 ONNX CPU，模型加载和排序带来的峰值进程内存增量不超过 512 MiB；测量基线为依赖已导入、尚未加载模型。**这是建议的验收上限，尚未证明能达到。** 产品总内存还要加词典存储、缓存和既有应用占用。

### TTFT 与响应速度

encoder 一次前向输出分数或向量，没有自回归“首 token”。应分别报告：

1. 首次下载；文件已缓存时的冷进程初始化和首批排序；
2. 常驻模型下端到端 warm p50／p95，包括 tokenize、推理、读取候选和排序；
3. 候选数 N、batch B、合并后的 token 长度 L、线程数和并发；
4. 后端测量与浏览器展示时间，并记录 CPU、运行时和 artifact revision。

作者给 xsmall-v2 的[吞吐报告](https://huggingface.co/hotchpotch/japanese-reranker-xsmall-v2#推論速度)是约 15 万 pairs：M4 Max CPU 2,300 秒、MPS 303 秒、RTX5090 6.5 秒，排除 tokenize。其[脚本](https://gist.github.com/hotchpotch/bab03c7d4399aa13beb2702600ad9371)使用 CPU FP32、batch=128，MPS FP16、batch 最大 1024，CUDA FP16、batch=4096；按批动态 padding，最大长度 512。

这能说明作者做过批量部署测试，**不能将总时间除以 15 万后当作单次查词延迟**。脚本未显式同步 GPU／MPS 后再停止计时，且未给线程数、峰值内存及 p95；这些数字只能按作者报告的口径参考。尤其不能拿这组 PyTorch FP32 CPU 数据预测 INT8 ONNX 的固定加速倍数。

两条路线的成本不同：

    cross-encoder ≈ N 份句对前处理 + ceil(N/B) 次批推理 + 排序
    缓存 bi-encoder ≈ 1 份目标上下文编码 + 候选向量读取 + O(Nd) 点积

cross-encoder 让上下文和释义在注意力层交互，适合细义项比较；它的候选部分不能独立缓存成向量来替代联合推理。bi-encoder 可以节省每次候选推理，但目标语义与细微用法可能损失，需要用任务数据检验。

建议首轮设置以下**体验目标，非性能预测**：本地 CPU、常驻单例、INT8、并发 1、句对不超过 256 tokens 时，N≤8 的 warm p95≤150 ms，N≤16 时≤200 ms。单独测冷启动。若达不到，再依证据选择更短窗口、减少候选、缓存双编码器，或更浅的 tiny 学生模型，而不是直接扩大超时。

## 5. 为什么先放本地后端

项目当前本来就是 FastAPI 本地 Web 应用。将小模型作为后端常驻单例，可以复用现有本地运行方式，先确认质量，避免一开始承担浏览器下载、算子兼容和 Worker 生命周期问题。实验包可以使用成熟 Python 工具，最终分发包不必携带完整训练依赖。

浏览器部署技术上可行，但仍需逐模型验证：

- ORT Web 的 WASM 多线程需要 crossOriginIsolated；官方性能指南建议 WASM 尝试 uint8，避免把 fp16 当 CPU 优化。[线程配置](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)、[性能指南](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)
- WebGPU 能在支持的设备上加速，但需要核查图与算子覆盖、精度、首次编译和缓冲区成本；Transformers.js v4 的新运行时不自动保证某个现有 ONNX 图可用。[v4 发布说明](https://huggingface.co/blog/transformersjs-v4)
- 浏览器 JS heap 不等于总内存，WASM memory 与 GPU buffer 需要另外测。不要只读取 performance.memory 就宣布满足内存预算。

量化也要比较排序质量：先尝试官方 ARM64／x86 对应 artifact，核对 FP32 与 INT8 在困难样本上的 top-1 改变和置信回退行为。动态量化无需校准集，但可能引入额外在线计算，效果与速度取决于实际图和硬件。[ORT 量化说明](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)

## 6. 后训练需要什么数据

公开语料适合迁移学习和附加评测；当前词典的真实语境标注最接近产品目标。

| 资源 | 已确认内容 | 使用价值与限制 |
| --- | --- | --- |
| [SemEval-2010 Task 16](https://aclanthology.org/S10-1012.pdf) | 日语任务为 **16**；50 目标词，目标词训练／测试各 2,500 条，完整训练另含更多词，共 31,611 sense tags | 岩波义项，中层粒度；需按官方流程联系获取和签版权协议；训练测试还有源文档重叠，不能据此制定产品切分方式 |
| [Jsemcor](https://github.com/bond-lab/jsemcor) | 官方报约 14,000 句、58,000 义项标注；日译 SemCor | 与 Japanese WordNet 同许可，官方仓库已有 XML；可作为迁移数据，但翻译语料与当前词典标签不同。[规模说明](https://bond-lab.github.io/wnja/eng/downloads.html) |
| [Japanese WordNet](https://bond-lab.github.io/wnja/eng/downloads.html) | 日语 synset、定义、例句；当前下载页列 2.1 | [NICT 许可](https://bond-lab.github.io/wnja/license.txt)允许免费用于任何目的并有保留声明要求；词义划分、翻译和条目质量仍需检查 |
| [BCCWJ-WLSP-AUX-OT](https://github.com/masayu-a/BCCWJ-WLSP-AUX-OT) | 真实日语的 WLSP 语义分类标注 | CC BY-NC-SA 3.0；公开附件遮罩词头、读音、POS、表记等，需有授权的 BCCWJ 原文补全；分类粒度不等于细义项 |
| [XL-WSD](https://sapienzanlp.github.io/xl-wsd/) | 日语 23,217 银标训练、1,901 dev、7,602 test | 非商用；评测来自 Japanese WordNet 例句，不能再把同一批词典例句用于训练。[论文表 1](https://sapienzanlp.github.io/xl-wsd/assets/paper/xl-wsd-aaai2021.pdf) |
| [JMdict](https://www.edrdg.org/wiki/Main_Page.html) | 结构化表记、读音、词性与义项限制 | 适合候选生成；并非完整日日／日中定义与上下文标注资源；使用须遵守相应语言内容的[许可](https://www.edrdg.org/edrdg/licence.html) |
| [Tomoshi 开放词典层](https://github.com/tomoshi-app/tomoshi-dict-data) | 约 217k JMdict 条目，有中文及日文释义，部分为模型生成 | 可作另一 inventory 候选，开放版剔除例句；逐表[许可](https://github.com/tomoshi-app/tomoshi-dict-data/blob/main/LICENSE.md)分别核查，不能作为人工 WSD 金标 |

BCCWJ 的获取成本对个人开发者并不轻：官网目前列非商用一般利用税前 20 万日元，学术学生 2.5 万、其他学术 5 万；商业最低档 40 万／2 年／10 人，申请通常需 1–2 月。即使购买原文，也不自动解除附加标注的非商用限制。因此不建议将购买、映射 BCCWJ 作为这个想法的前置条件。[价格](https://clrd.ninjal.ac.jp/bccwj/fee.html)、[申请](https://clrd.ninjal.ac.jp/bccwj/subscription.html)

建议先做 500–1,000 条真实阅读查询金标，以目标词典直接标注，区分“唯一正确”“多个都可”“文脉不足”“候选全错”。初学者的实际困惑适合收集查询，但困难样本最好由日语熟练者复核；不要将用户被迫点击第一项自动当作正确标签。

训练可先清洗 5k–20k 条词典例句作为弱监督，加一批独立的真实阅读标注，再比较增量收益。这些数字是实验规模建议，不保证达到某个准确率；实际需求取决于词义覆盖和难例分布。

模型形式为“带目标标记的上下文 + 单个候选释义 → 分数”，训练目标采用同次查词候选内排序。优先使用同词条兄弟义项、同表记异读、同读异表记、相近含义作困难负例。不能主要依赖不相干词条作负例，否则任务会过于容易。多个合理候选用多正例或等价集合，避免强造唯一答案。

目标标记也须验证：未微调模型未必理解新造的特殊 token；新增专用标记需要随任务一起训练。训练同时保留父级释义和词性，截断围绕目标词，而非简单取长段落前 256 tokens。

对于约 37M 的模型，可以先尝试普通监督微调；LoRA／蒸馏是优化选项，不是开始实验的必要条件。只计算 FP32 Adam 参数、梯度和两个动量，就约为参数量 ×16 字节，即约 0.59 GB；还需激活与框架开销。这是理论核算，未给出训练显存、时长的实测保证。用小 batch、梯度累积和短句对做学习曲线，优先花精力改数据；没有证据需要新增大规模预训练。

## 7. 如何判定它真的有差异化价值

评测必须拆开候选召回与排序。至少报告候选召回率、正确项存在时 top-1、端到端 top-1、MRR／Recall@3，并按多读词、细义项、罕义、惯用语和候选数分层。另报按词宏平均，避免大量高频单义词掩盖真正困难样本。

先确定切分协议，再展开中日文本、表记变体与候选 pairs。已见词测试按源文档和例句近重复簇隔离，允许词条重叠；未见词测试额外按规范词条／lemma 及其表记、读音变体整组隔离；跨词典测试固定词典边界，并清除近重复。词典例句既作为训练输入又作为候选示例时，尤其要防止测试句直接出现在模型看到的候选内容中。

置信回退在独立验证集校准，测“自动置顶覆盖率—正确率”曲线。softmax 总会给某项最高分，不能据此把分数称为真实正确概率；“文脉不足”和“全部候选错误”应分别处理。

产品交互可以做成用户可开关的“按语境推荐”：先迅速显示普通查词结果，再在可靠时标注推荐义项；保留其他读音与释义，并能恢复原排序。用户正在阅读或操作时，不应突然移动整张卡片，推荐义项可先用局部强调表达。这样即使模型暂时无把握，基础查词仍然有用。

推荐在词条里说明“当前更可能是第几义”，比只把整个词条移到最上方更能帮助初学者。对于多解保留并列，不制造确定性。是否整体替代 Yomitan，还须另行验收活用还原、候选覆盖、多词典呈现及基础交互；本调查只验证消歧的差异化潜力。

## 8. 建议的下一步与本轮验证边界

后续开始功能设计时，先按上方已确认方向建立不依赖 definitions 的卡片重排基线，用真实查询比较提升收益与错误置顶。内部义项抽取与小模型后训练不作为这一步的前置条件。

若另行启动义项研究，再固定当前双解词典版本，完成义项抽取审查和独立金标，对比“原排序／词频与词性规则、xsmall-v2、ruri-v3-30m”。确认通用模型的错误类型后，才投入目标词典的排序后训练。纯中文释义路线随后加入 E5 与 GTE。

性能实验固定模型 revision、运行时、CPU、线程和精度，覆盖 N={1,8,16,32}、L={64,128,256}，记录 warm p50／p95、缓存文件下冷启动、峰值 RSS 和 INT8 排名质量变化。GPU 计时需要显式同步。只有这些实测完成后，才能承诺具体设备的响应速度与内存。

本轮已完成公开来源核查、全词典结构统计和重复内容核对；没有验证模型在该词典上的准确率、吞吐、RAM、冷启动或训练时间。统计脚本不访问网络、不调用模型、不修改输入 ZIP，结果不含词典释义正文。长期产品规范和 TBD 未变更。

复现结构统计：

    python3 references/dictionary-context-ranking/inspect_dictionary.py \
      'temp/明镜日汉双解词典_Yomitan 1.4.3.zip'

原始 ZIP 是用户本机临时资产，不随本研究材料分发；复现需提供 SHA-256 与统计文件一致的输入。公开网页与模型仓库可能更新，后续实验应固定 commit／revision，而不是仅使用 main。
