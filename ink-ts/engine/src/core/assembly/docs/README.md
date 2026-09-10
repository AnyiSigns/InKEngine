# assembly（core/assembly）

输入调配管线：多源（上下文/知识/工具/记忆/证据）统一预算分级分配 → 组装 →
激活留痕——把 core/context 从「组件」接线为「执行语义」，每次 LLM 调用/
节点执行前统一调配；本模块只做组装与留痕（薄管线），不碰业务。

## 文件
- `assembly_config.ts` — 源类别常量（SOURCE_*）与回退优先级、`DEFAULT_TOTAL_BUDGET`=8000 与五项分级占比默认、`MODE_COMPRESSED`、`AssemblyConfig`（统一预算 + 占比合计 ≤1 校验 + max_tools）与 `ratio_for`/`pool_for`。
- `assembly_types.ts` — 激活留痕数据面：`SourceActivation`（源+强度+分配档位）/`ActivationRecord`（本次激活了什么+版本快照）/`InputAssemblyResult`（组装文本+留痕；旧名 `AssemblyResult` 兼容别名）/`EntryCompressor`。
- `_helpers.ts` — InputAssembler 私有辅助：`group_sources`（未知类别拒绝）/`limit_tools`（按分配分取前 N）/`source_with_content`（压缩视图克隆）/`entry_ref_of`/`activation_for`/`rollback_priority`（仅目录内使用，index 不转出）。
- `input_assembler.ts` — `InputAssembler.execute 主体`：`assemble` 全量路径（能全量则全量 + 工具上限独立护栏）与裁剪路径（分级池两遍分配 + 组装期条目内压缩 + 源块边界回退 + 空装配保底）。
- `activation_aggregator.ts` — `ActivationAggregator` 利用率聚合（MoE 辅助损失借鉴）：逐轮留痕 → 过热/过冷提示 + 逐条目明细（`ActivationSummary`/`EntryActivationStats`）。
- `index.ts` — 目录 barrel（snake_case 镜像 Python assembly.__all__；含跨目录 `DEFAULT_MAX_TOOLS` 转出）。

## 依赖
- 上游（本目录实际 import）：`core/context`（`ContextSource`/`ContextAssembler`/`WeightedBudgetAllocator`/`MODE_DROP`——分配器同时驱动组装与留痕）、`core/errors`、`core/json`、`core/tool_orchestrator/_types`（`DEFAULT_MAX_TOOLS`）。
- 下游（实际 import 本目录）：`kernel/executor`（`_engine_base` 构造 `InputAssembler`；`_node_context`/`_internals` 用 `AssemblyResult` 类型）、`kernel/runtime`（`_types`/`_runtime_engine` 用 `AssemblyConfig`、`_runtime_mechanisms`/`_runtime_contexts` 用 `SOURCE_*`，均经目录 barrel）、`core/run_result`（`RunOptions.assembly`/`assembly_aggregator` 类型）；公共面 `src/index.ts` 零导出（grep 核验）；hosts 零消费；测试 `test/core/assembly`（3 测试 + helpers）。
