# plan（model/plan）

运行时重规划原语的数据面：`__plan__` 保留键、计划清单模型（`Plan`/`PlanStep`）
与解析校验——图拓扑成为可改写数据。执行侧「节点返回下一跳计划清单、引擎按
清单续跑」的展开推进已随 P8+S1 摘链退役；数据面保留（harness `default_plan`
解析与演化提案计划校验的形态真源）。

## 文件
- `plan.ts` — 协议常量（`PLAN_KEY`/`KIND_NODES`/`KIND_PARALLEL`/`KIND_SPAWNS`/
  `DEFAULT_MAX_PLAN_STEPS`）、`PlanStep`/`Plan` 冻结数据模型与
  `toDict`/`fromDict` 往返、`Plan.parse` 解析校验（工作流约束域/严格序/
  spawn 项）。

## 依赖
- 上游（本目录实际 import）：`model/errors`（`GraphDefinitionError`）、
  `model/graph`（`Graph` + `EdgeConditionRegistryLike`）、`model/json`
  （`isRecord`/`typeName`）、`model/workflow`（`WorkflowSpec` 等）。
- 下游（实际 import 本目录）：`evolve/legacy/self_proposal`、`core/harness`
  （`registry.ts` 解析 `default_plan`）；`graph/executor` 消费
  （`_engine_plan`/`_engine_parallel` 计划推进、并行组）已随 P8+S1 展开段
  退役删除；公共面 `src/index.ts` 无本目录导出；hosts 无直接 import；测试
  `test/model/plan`。
