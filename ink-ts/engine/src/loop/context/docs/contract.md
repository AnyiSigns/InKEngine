# core/context — 上下文调配器（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

多源上下文输入的确定性调配底座：预算单位 = 字符（引擎无分词器，字符数是
对 token 的确定性近似，宿主按模型上下文窗换算）。确定性层（分配/组装）
与增强层（LLM 融合、窗口压缩）分层，策略全部可注入（换策略不改装配）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `context_types.ts` | ContextSource 值对象（type/content/title/weight/relevance/priority/ttl/max_chars/dedup_key/meta/created_at + clock 注入；构造期 RangeError 校验）、SourceAllocation（三档位 + 理由留痕）、SourceInclusion/DroppedSource（审计「喂了什么/丢了什么」）、AssembledContext（text ≤ total_chars 硬上界 + fused 标记）、档位/阈值常量、Clock |
| `context_allocator.ts` | BudgetAllocator 接口契约（等长一一对应/确定性/预算硬上界）、dedup_sources、WeightedBudgetAllocator（score=weight×relevance 分档五规则；水塘填充防「截断到比自己还短」） |
| `context_assembler.ts` | ContextAssembler：分配结果按优先级序重排拼接（只动拼接序不动分配结果）、块格式【标题】\n文本、块开销计账（标题 len+3/分隔 2）、预算耗尽/截断为空丢弃留痕、超界内容截断保留（高优源必在场）、兜底整串硬截断 |
| `context_compression.ts` | 按模型档案的窗口压缩：全局占比旋钮 0.8/兜底 200k、工具结果回填 0.05+floor 4000、CompressionPolicy 判定+预算分层钩子、ThresholdCompressionPolicy（双阈值与；from_context_window 动态推算）、compress_message_history 非破坏性折叠视图、archive_digest/message_text/tool_round_spans 共享原语 |
| `context_window.ts` | 域窗口投影：GroupResolver 工具→域归属（null=公共集）、iter_tool_rounds 反向配对（工具轮轮内任一工具属本域则整轮保留）、DEFAULT_MAX_TOOL_ROUNDS=8/DIGEST_MAX_CHARS=800；多域开关默认 OFF |
| `context_mixer.ts` | ContextMixer 门面（融合 fail-open 回退确定性）、FusionHook 接口（返回 null=显式拒绝；抛错由调用方捕获回退）、FusionRegistry（同名覆盖注册） |

## 对外契约面

- 核心执行面：`WeightedBudgetAllocator.allocate` / `ContextAssembler.assemble`
  / `compress_message_history` / `ContextMixer.mix`。
- **公共面零导出**（src/index.ts grep 核对）——纯引擎内部面；消费方按文件
  直连 import（本目录无 barrel）。
- 校验错误面：RangeError（数值域）/TypeError（allocator 协议不满足）——
  未接 EngineError 族（core/errors 的 GraphDefinitionError 惯例在此目录
  不适用，与 core/state 裸 Error 同类口径）。

## 数据形态

- 档位词表：keep_full/truncate/drop（本目录真源；assembly 侧扩展档
  compressed/fallback_keep 已随 core/assembly 退役，W7-B）。
- 预算链：DEFAULT_BUDGET_CHARS 4000（单次组装默认）→ 压缩预算 8000
  （策略默认；core/assembly 的多源总预算 DEFAULT_TOTAL_BUDGET 已随机制退役）。
- 时间：Clock.now 注入、缺省 0（纯函数可复现；头注自述与 Python
  time.time 行为不同——要求宿主显式注入）。

## Seam 与 IO 边界

纯函数目录无 IO；注入面：BudgetAllocator（策略替换装配零改动）、
CompressionPolicy（判定+预算分层）、FusionHook（LLM 融合增强，按需注入）、
Clock（created_at/is_expired/压缩判定）。

## 装配与消费

- `core/assembly`（已随 W7-B 组装链路退役；曾以 InputAssembler 复用
  WeightedBudgetAllocator + ContextAssembler + ContextSource 接线输入调配）。
- `kernel/runtime`：_runtime_engine（ThresholdCompressionPolicy 压缩链）、
  _runtime_mechanisms/_runtime_contexts（ContextMixer/ContextSource 装配）、
  _runtime_base/_types（type 形态）。
- `kernel/llm/guard.ts`（压缩阈值/工具结果截断常量供 LLM 守卫链）。
- `core/knowledge_set`/`core/knowledge_signals`（ContextSource/Clock 形态）。

## 不变式与门禁

- 预算硬上界：输出永不超 total_chars（分配层 + 块开销计账 + 兜底硬截断
  三重保证）。
- 非破坏性：压缩/融合返回视图，原始消息流与源对象不修改。
- 确定性：同一输入同一输出（含时间注入化）；融合失败 fail-open 不阻断
  主流程。

## 疑点与不一致

1. **`context_window.ts` 孤儿**：全仓 src 零消费方（仅镜像测试）；头注
   自述「机制就绪 / 宿主接线点待定——多域开关默认 OFF，当前引擎无多域
   配方消费方」（与 builder/workflow 同款状态；且头注含「状态标注」字样，
   与 CODING §3 边界未见说明）。
2. **FusionRegistry「真实消费方」表述失准**：context_mixer.ts 头注称
   「注册表有真实消费方，多策略注册经名称选择参与融合」——实际 src 内
   FusionRegistry 仅被 ContextMixer 可选参数消费，无任何按名注册的生产
   调用方（grep 核验）。
3. **iter_tool_rounds 偏离 parity 的决策叙述**：头注含「与 Python parity
   同病……拍板已定引擎侧先行修复，允许偏离 parity」——保留决策叙事与
   Python 对账语境（移植期措辞，同 fanout/events 先例）。
4. **错误面与 core 惯例不一致**：本目录校验抛 RangeError/TypeError 裸
   原生错误，未用 core/errors 的 GraphDefinitionError/EngineError 族
   （与 core/state、kernel/interrupt 同类口径分歧，跨目录不成体系）。
5. **无 barrel**：6 文件无 index.ts 收敛者，消费方按文件直连（与多数
   core 目录形态不一致；对 workflow 同款发现，此处为大面积版本——
   11 个 src 消费文件、20+ 条 import 均直连具体文件）。
6. **`context_assembler.ts` 内联修复留痕**：块开销注释「原 +2 少算 1」
   保留历史 bug 叙述（现值正确性由测试保证；注释属修复考古而非当前
   语义说明）。

## 测试

`test/core/context/`：context_source_allocator.test.ts（分配五规则/去重/
阈值边界）、context_assembler.test.ts（拼接序/块开销/预算硬上界）、
context_mixer_registry.test.ts（FusionRegistry/融合回退）、
context_window.test.ts（域投影/工具轮配对——孤儿模块的行为钉住）。
