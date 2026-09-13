# plan（model/plan）

运行时重规划原语的数据面：`__plan__` 保留键、计划清单模型（`Plan`/`PlanStep`）
与解析校验——节点返回下一跳计划清单、引擎按清单续跑，图拓扑成为可改写数据。

## 文件
- `plan.ts` — 协议常量（`PLAN_KEY`/`KIND_NODES`/`KIND_PARALLEL`/`KIND_SPAWNS`/
  `DEFAULT_MAX_PLAN_STEPS`）、`PlanStep`/`Plan` 冻结数据模型与
  `toDict`/`fromDict` 往返、`Plan.parse` 解析校验（工作流约束域/严格序/
  spawn 项）。

## 依赖
- 上游（本目录实际 import）：`model/errors`（`GraphDefinitionError`）、
  `model/graph`（`Graph` + `EdgeConditionRegistryLike`）、`model/json`
  （`isRecord`/`typeName`）、`model/workflow`（`WorkflowSpec` 等）。
- 下游（实际 import 本目录）：`graph/executor`（`_engine_plan`/
  `_engine_parallel`/`_engine_loop_front`/`_engine_execute`/`_loop_types`/
  `_internals`）、`evolve/legacy/self_proposal`、`core/harness`（`registry.ts`
  解析 `default_plan`）、`core/run_result`（值引
  `DEFAULT_MAX_PLAN_STEPS`）；公共面 `src/index.ts` 无本目录导出；hosts
  无直接 import；测试 `test/model/plan`、`test/graph/executor`、
  `test/core/run_result`。
