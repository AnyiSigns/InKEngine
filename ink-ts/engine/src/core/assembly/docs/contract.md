# core/assembly — 输入调配管线（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

多源统一预算调配（`assembly.py` 移植）：上下文/知识/工具/记忆/证据五类源
在调用点统一分配总预算 → 组装 → 激活留痕——「能全量则全量，放不下才裁
剪」。把 core/context 的分配器/组装器从组件接线为执行语义；本模块只做组
装与留痕（薄管线），不碰业务，零 IO。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `assembly_config.ts` | 源类别常量 `SOURCE_CONTEXT/KNOWLEDGE/TOOL/MEMORY/EVIDENCE` + `_SOURCE_TYPES` 白名单 + `_ROLLBACK_PRIORITY`（evidence 0 < memory 1 < tool 2 < knowledge 3 < context 4，数值大 = 更晚丢）；`DEFAULT_TOTAL_BUDGET`=8000、五项占比默认（0.5/0.3/0.1/0.05/0.05，合计 1.0）、`DEFAULT_ASSEMBLY_BUDGET`、`MODE_COMPRESSED`；`AssemblyConfig`（构造期校验：预算为正/占比 ∈[0,1]/合计 ≤1 防超分/max_tools ≥1，非法抛 `GraphDefinitionError`）+ `ratio_for`/`pool_for`（总预算 × 占比向下取整）/`to_dict`/`from_dict` |
| `assembly_types.ts` | `SourceActivation`（source_type/title/weight/relevance/char_limit/mode/entry_ref/note——激活模式留痕；note 空省略）；`ActivationRecord`（total_budget/assembled_chars/sources/version_snapshot/truncated_chars/created_at 缺省 0——时间 seam 确定性）；`InputAssemblyResult`（text + record）与兼容别名 `AssemblyResult`（ENG9a-24：与 path_assembler.PathAssemblyResult 同包同名异义已消除）；`EntryCompressor`（源 + 预算 → 摘要视图，空串 = 不压缩走默认截断） |
| `_helpers.ts` | 私有辅助（index 不转出）：`group_sources`（未知类别显式拒绝）、`limit_tools`（按分配分 weight × relevance 取前 N）、`source_with_content`（压缩视图克隆，meta 标 compressed + original_chars）、`entry_ref_of`（meta.entry_id）、`tool_cap_note`、`rollback_priority`、`activation_for`（源公共字段 + 档位 extra） |
| `input_assembler.ts` | `InputAssembler.assemble(sources, {total_budget?, version_snapshot?})`：全量路径（总字符 ≤ 预算 → `_keep_all` 分配器门槛归零整包激活；工具超 `max_tools` 独立裁剪、被裁工具留痕 drop）与裁剪路径（分级池两遍分配：无源池预算按占比回拨 → 逐池组装 → 组装期条目内压缩 → 粘合开销按源块边界回退丢整块 → 单块超预算硬截断兜底 → 空装配保底最高分源 `fallback_keep`）；留痕同步喂聚合器；enabled=False 时 assemble 抛错（调用点应走旧路径） |
| `activation_aggregator.ts` | `ActivationAggregator`（`DEFAULT_OVERHEATED_RATE`=0.8/`DEFAULT_COLD_WINDOW`=10，构造期校验）：`record()` 逐源累积（丢弃/零分配源与无 entry_ref 源不计激活）；`snapshot() → ActivationSummary`（过热 = 窗口 ≥2 次调用且激活率 ≥ 阈值；过冷 = 调用数 > 冷窗且 `last_activated_call` 落窗外——归档候选；per_entry 按 entry_ref 排序稳定）；`EntryActivationStats`/`ActivationSummary` 数据往返 |
| `index.ts` | 目录 barrel（snake_case 镜像 Python assembly.__all__，34 名；含跨目录 `DEFAULT_MAX_TOOLS` 转出；`_SOURCE_TYPES`/`_ROLLBACK_PRIORITY` 不转出） |

## 对外契约面

公共面零导出（逐名 grep `src/index.ts`：无 `AssemblyConfig`/`InputAssembler`/
`SOURCE_*`/`ActivationRecord`/`ActivationSummary`/`DEFAULT_TOTAL_BUDGET`/
`DEFAULT_MAX_TOOLS` 等任何本目录名；`_` 私件按纪律不外泄）——本目录仅引擎
内部消费。目录 barrel（`index.ts`）34 名为内部收敛面：值 25（13 配置常量 +
`AssemblyConfig` + `DEFAULT_MAX_TOOLS` + 2 聚合常量 + `ActivationRecord`/
`AssemblyResult`/`InputAssemblyResult`/`SourceActivation` + `ActivationAggregator`/
`ActivationSummary`/`EntryActivationStats` + `InputAssembler`）+ 类型 9。
机制端口：纯 core 组件目录，无 contract.ts、不属机制注册表（区别于 kernel
机制件）。任务提示中「环境装配」导出组（index.ts「环境装配」）真源为
`core/environments`（EnvironmentSpec/Provider 面），与本目录无关。

## 数据形态

- 源类别五类（分组键白名单）：context（对话/回合上下文）、knowledge（知识
  集注入）、tool（工具定义裁剪）、memory（记忆召回）、evidence（证据组装）。
- `AssemblyConfig`：enabled 开关（False = 装配禁用回退旧路径）+ total_budget
  （默认 8000）+ 五项分级占比（合计 ≤1）+ max_tools（默认
  `DEFAULT_MAX_TOOLS`，与工具调配器同源单点）。
- 激活留痕 `mode` 档位：keep_full/truncate（真源 core/context 分配器）、
  drop（`MODE_DROP`）、compressed（`MODE_COMPRESSED`）、fallback_keep（字面
  量）；char_limit=0 = 本调用未纳入。
- 留痕最小式：记录组装决定（源/权重/预算/档位）+ 知识集版本快照——全量
  原文由快照重建，合起来满足「模型可见皆可从日志重建」。

## Seam 与 IO 边界

纯函数目录，无 IO 声明。注入面：`allocator`（`WeightedBudgetAllocator`——
组装器与留痕共用同一实例，「一次分配语义」：分配决定 = 组装决定，留痕即
事实）、`compressor`（非破坏性条目内摘要，原文不动）、`aggregator`（留痕
同步喂聚合，空 = 不聚合）；`version_snapshot` 按副本留存（外部改写不污染
留痕）；`created_at` 时间 seam 缺省 0（确定性）。零日志；开关关闭 = 抛错
回退旧路径而非静默直通。

## 装配与消费

- `kernel/executor/_engine_base` 构造 `InputAssembler`：每次 LLM 调用/节点
  执行前多源统一调配；`kernel/executor/_node_context`/`_internals` 以
  `AssemblyResult` 类型承载预装配结果（节点内 assemble 复用预装配、不重复
  留痕——`RunOptions.assembly_sources` 口径）。
- `kernel/runtime`：`_types`/`_runtime_engine` 持 `AssemblyConfig`（配方
  `RunOptions.assembly` 注入链）、`_runtime_mechanisms`/`_runtime_contexts`
  以 `SOURCE_KNOWLEDGE`/`SOURCE_EVIDENCE` 组装证据/知识源；`RunOptions.
  assembly_aggregator`（ENG12 接线 4）把聚合器挂入 InputAssembler。
- `core/run_result`：`RunOptions.assembly`/`assembly_aggregator` 字段类型
  引用。hosts 零消费（grep 核验）；测试 `test/core/assembly`。

## 不变式与门禁

- 「能全量则全量，放不下才裁剪」：总字符 ≤ 预算整包激活（集小无稀疏必要）。
- 一次分配语义：分配器同时驱动组装与留痕，换策略即换产物、留痕与实际一致。
- 工具激活上限独立护栏：超限工具按分配分裁剪、被裁工具同留痕（drop + 归
  因 note），每轮 3-14 个经验框架。
- 裁剪路径防线链：无源池预算不闲置（两遍分配回拨）→ 压缩非破坏（原文不
  动）→ 粘合开销按源块边界回退丢整块（回退优先级尾部先丢 = evidence/memory
  先牺牲、context 最后；被丢块留痕改写 drop + 归因，截断量入记录）→ 单块
  超预算硬截断兜底 → 空装配保底（最高分源截断片段，保底留痕追加、原 drop
  记录保留——审计可见丢什么 + 谁保底）。
- 未知源类别显式拒绝（类别是预算分级键，不得漂移）；聚合只观测不新增裁剪
  机制；丢弃源不计激活（防预算丢弃反向推高过热判定）。

## 测试

镜像测试 `test/core/assembly/`（3 测试 + helpers）：`assembly.test.ts`
（统一预算分配 / 激活留痕与开关 / 组装期条目内压缩）、`assembly_budget.
test.ts`（注入分配器 / 全量保留 / 留痕归因 + ENG9a-13/14）、
`assembly_aggregator.test.ts`（激活利用率聚合）。

## 疑点与不一致

1. `DEFAULT_ASSEMBLY_BUDGET` 与 `DEFAULT_TOTAL_BUDGET` 同值双名（前者为后者
   的别名赋值，`assembly_config.ts` 两名均经 barrel 导出）——双名并存口径
   未见显式说明。
2. 目录 barrel 从 `core/tool_orchestrator/_types.js`（`_` 前缀私件）转出
   `DEFAULT_MAX_TOOLS`——他目录私件常量经本目录公开面透出（注释自述「装配
   层与调配层同口径」；core 内合法，但 barrel 面含他目录私件名）。
3. `AssemblyResult` 旧名兼容别名与 `InputAssemblyResult` 同类双名（ENG9a-24
   注释自述旧名供既有消费方沿用；kernel/executor 两文件仍用旧名）——新旧
   名并存未见收敛口径。
4. 激活留痕 `mode` 档位词表分散：keep_full/truncate 真源在 core/context 分
   配器、`MODE_DROP` 在 core/context、`MODE_COMPRESSED` 在本目录、
   `fallback_keep` 为 `input_assembler.ts` 字面量——档位词表无单一常量定义
   处（五档名见于本目录注释）。
