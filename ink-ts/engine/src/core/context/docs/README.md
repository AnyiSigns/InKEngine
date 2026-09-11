# context/（core/context — 上下文调配器）

上下文融合输入的确定性调配：源值对象（ContextSource）+ 预算分配器
（加权分档：高权重整保/中权重截断/低权重丢弃）+ 组装器（按优先级序拼接、
预算硬上界）+ 窗口压缩策略（按模型档案窗口动态阈值）+ 域窗口投影 + LLM
融合钩子门面（fail-open）。budget 单位 = 字符（无分词器的确定性近似）。

## 文件（本目录无 index barrel，消费方按文件直连）
- `context_types.ts` — ContextSource（构造期 RangeError 校验/score=weight×
  relevance/is_expired）、SourceAllocation/SourceInclusion/DroppedSource、
  AssembledContext、常量（DEFAULT_BUDGET_CHARS=4000、KEEP_FULL_THRESHOLD=0.8、
  TRUNCATE_MIN_SCORE=0.15、MIN_TRUNCATE_CHARS=100、MODE_* 三档）、Clock。
- `context_allocator.ts` — BudgetAllocator 接口（一一对应/确定性/预算硬
  上界）+ dedup_sources（同 dedup_key 保优先级最高）+ WeightedBudgetAllocator
  五规则默认实现（过期/空源剔除→去重→高权整保→水塘份额截断→低分丢弃；
  时钟注入缺省 0）。
- `context_assembler.ts` — ContextAssembler：去重 + 分配 + 按「分配优先级
  序」拼接（非输入序，防低优截断源挤占高优整保源）；块开销计账
  （标题 len+3、分隔 2，注释自述原 +2 少算 1 已修）；allocator 协议运行期
  校验（TypeError 提前暴露）。
- `context_compression.ts` — 压缩策略：窗口占比 0.8（档案缺失 200k 兜底）、
  工具结果回填 0.05（下限 4000）、CompressionPolicy 接口 +
  ThresholdCompressionPolicy（min_messages 30 + min_chars 双阈值，预算
  8000；from_context_window 动态推算）、compress_message_history（非破坏性
  视图：system 头恒留 + keep_recent 10 + 中段折叠为带「历史上下文压缩
  摘要」前缀的摘要 user 消息）、archive_digest/message_text/tool_round_spans。
- `context_window.ts` — 域上下文窗口投影（用户消息全留 + 本域最近工具轮
  8 + 最近完成性回复 + 归档摘要锚点；轮内任一工具属本域则整轮保留——
  宁多勿少防上下文撕裂）；iter_tool_rounds 反向扫描配对（轮内 tool 序
  已修，注释自述允许偏离 Python parity）。
- `context_mixer.ts` — ContextMixer 门面：确定性组装 + 可选 LLM 融合钩子
  （返回 null/抛错回退确定性组装，fail-open）；FusionRegistry 按名注册。

## 依赖
- 上游：`kernel/llm/messages`（message_role/Message/user）。
- 下游：`core/assembly`（已随 W7-B 退役，曾三文件复用 allocator/assembler/types）、
  `kernel/runtime`（ContextMixer/CompressionPolicy/ContextSource 装配）、
  `kernel/executor`（ContextSource type）、`kernel/llm/guard`
  （context_compression）、`core/knowledge_set`/`core/knowledge_signals`
  （ContextSource/Clock）；公共面零导出（grep 核对）；
  `test/core/context/`（4 文件）。
