# core/plan — 运行时重规划原语（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

运行时重规划（`__plan__`）的数据面：节点返回下一跳计划清单（顺序节点组/
并行组/条件门/spawn 子图实例项），引擎按清单续跑、执行一段后再规划——
图拓扑成为可改写数据。计划是 checkpoint 快照字段（随版本链落盘与回滚），
因此全部模型为纯数据、可 JSON 序列化。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `plan.ts` | 协议常量（`PLAN_KEY`/`KIND_*`/`DEFAULT_MAX_PLAN_STEPS`）、`PlanStep`/`Plan` 冻结数据模型与 `toDict`/`fromDict` 往返、`Plan.parse` 解析校验（工作流约束域/严格序/spawn 项） |

## 对外契约面

目录导出 7 名：

- 常量：`PLAN_KEY`（`'__plan__'`）、`KIND_NODES`（`'nodes'`）、
  `KIND_PARALLEL`（`'parallel'`）、`KIND_SPAWNS`（`'spawns'`）、
  `DEFAULT_MAX_PLAN_STEPS`（32）。
- 类：`PlanStep`（`kind`/`nodes`/`spawns`/`condition`）、`Plan`
  （`steps`/`index`、`remaining` getter、静态 `parse`）。

公共面（逐名核对）：`src/index.ts` 无任何来自 `./core/plan/plan.js` 的
导出（grep 核验；公共面 `plan_evolution` 等名真源为
`core/controlled_evolution/apply_plan.ts`，与本目录无关）——本目录仅
引擎内部消费。`kernel/executor/_engine_parallel.ts` 有
`export type { PlanStep }` 转出，但 `_` 前缀私有文件不入公共面。

## 数据形态

- 计划步骤三形态，一步须恰好声明其一（`requireExactlyOneKind`）：
  `nodes` 顺序节点组（`parse` 把多节点步展开为单节点步——checkpoint
  粒度）、`parallel` 并行组（保持单步）、`spawns` spawn 步
  （`[{subgraph, state, index}]` 清单，`subgraph` 为 `Graph` 实例时经
  `to_dict()` 归一为数据形态）；可选 `condition` 条件门名。
- 计划快照 `{steps, index}`：`Plan.fromDict` 校验 `steps` 清单存在与
  游标越界（0..步数）；`Plan.parse` 接受裸步骤列表或 `{steps: [...]}`
  信封，游标缺省 0。
- 与 `__spawn__` 的关系（模块 docstring）：计划 = 流的结构（下一跳
  编排），spawn = 流的展开（并行子图实例），计划步骤可携带 spawn 清单，
  展开共用执行器实例展开路径。

## Seam 与 IO 边界

纯函数，无 IO 声明。解析注入面均由调用方传入：`graph`（图约束）、
`edge_registry`（条件注册表 seam，`EdgeConditionRegistryLike`）、
`workflow`（工作流约束域 `WorkflowSpec`）；校验失败统一抛 `core/errors`
`GraphDefinitionError`。

## 装配与消费

`Plan.parse` 校验序（源码事实）：空清单/步数超限（`max_steps`，0 = 不
校验）→ 逐步 `PlanStep.fromDict` → 节点名域校验（有 `workflow`：须落在
workflow 节点集且在当前图；无：须在当前图）→ `condition` 非 null 须已
注册（`edge_registry` 缺失即拒）→ spawn 项校验（`subgraph` 必填、
`state` 须 dict、`index` 须可数值化）→ `nodes` 多节点步展开、`spawns`
子图归一 → `policy` 校验（`'strict'` 走相邻步边关联
`validateStrictOrder`，未知策略拒绝，`'loose'` 缺省）。

消费方：`kernel/executor`（`_engine_plan`/`_engine_parallel`/
`_engine_loop_front`/`_engine_execute`/`_loop_types`/`_internals`——
计划推进、并行组、`PLAN_KEY` 出栈、`_node_in_plan_steps`）、
`core/harness/registry.ts`（`Plan.parse` 解析 `definition.default_plan`）、
`kernel/self_proposal/proposal_validator.ts`（提案计划校验）、
`core/run_result/run_result.ts`（`DEFAULT_MAX_PLAN_STEPS` 作
`max_plan_steps` 默认值）。hosts 无直接 import。

## 不变式与门禁

- 纯数据不变式：节点/条件以注册名引用，`Graph` 入计划前序列化为数据
  （「函数不是数据」）；`PlanStep`/`Plan` 构造即 `Object.freeze`
  （含内部数组）。
- 计划版本化：计划随 checkpoint 快照落盘，回溯决策点时计划与状态一起
  回到当时版本（模块 docstring 硬性要求）。
- core 纪律：禁 `node:*` 与第三方 import、禁反向依赖 `adapters/`、禁
  宿主词（架构门禁随 vitest 强制）。

## 测试

镜像测试（`test/core/plan/`）：`plan.test.ts`（构造/类型/不可变/往返
序列化/`fromDict` 校验/常量值）、`plan_parse.test.ts`（基础校验/未知
节点/条件未注册/顺序组展开/严格序）、`plan_workflow.test.ts`（工作流
约束域/信封形态/策略/spawn 项）。执行路径侧：`test/kernel/executor/
executor_plan.test.ts` 以 `PLAN_KEY` 覆盖；`test/core/run_result/
run_result.test.ts` 断言 `DEFAULT_MAX_PLAN_STEPS = 32`。

## 疑点与不一致

1. `WorkflowEdgeSpec`/`WorkflowNodeSpec` 经值 import 引入（`plan.ts`
   import 行）但全文件无引用（grep 仅命中 import 行本身）；实际只消费
   `WorkflowSpec`。
2. 严格序校验中 spawns 步的 `stepTails`/`stepHeads` 返回空表：作为前步
   整段跳过校验，作为后步因无 heads 必判「无边关联」拒绝；三个镜像
   测试均未见覆盖该场景。
3. `plan.test.ts` 头注释称「当前 TS 执行器尚未移植」并列出 28 项未迁移
   联跑用例；现状 `kernel/executor` 已存在、`Engine` 经公共面导出
   （`src/index.ts`「执行器入口」组）、executor 侧 `PLAN_KEY` 用例已在
   `test/kernel/executor/executor_plan.test.ts` 落地——注释与代码现状
   不符。
4. `PLAN_KEY`/`KIND_*` 为手写模块常量，`engine/schemas/` 真源 grep 无
   `__plan__` 条目；其是否属 AGENTS.md「枚举……一律经 contracts
   generated」收编范围未见显式说明。
