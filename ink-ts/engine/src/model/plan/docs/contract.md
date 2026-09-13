# model/plan — 运行时重规划原语（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

运行时重规划（`__plan__`）的数据面：计划清单模型与解析校验（步骤形态：顺序
节点组/并行组/条件门/spawn 子图实例项）——图拓扑成为可改写数据；执行侧
「引擎按清单续跑、执行一段后再规划」的展开推进已随 P8+S1 摘链退役。计划
曾是 checkpoint 快照字段（随版本链落盘与回滚），因此全部模型为纯数据、
可 JSON 序列化。

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

公共面（逐名核对）：`src/index.ts` 无任何来自 `./model/plan/plan.js` 的
导出（grep 核验；公共面 `plan_evolution` 等名真源为
`evolve/proposal/apply_plan.ts`，与本目录无关）——本目录仅引擎内部消费；
`graph/executor` `_` 前缀私有文件也不再转出 `PlanStep`（原
`_engine_parallel.ts` 的 `export type { PlanStep }` 已随 P8+S1 退役删除）。

## 数据形态

- 计划步骤三形态，一步须恰好声明其一（`requireExactlyOneKind`）：
  `nodes` 顺序节点组（`parse` 把多节点步展开为单节点步——checkpoint
  粒度）、`parallel` 并行组（保持单步）、`spawns` spawn 步
  （`[{subgraph, state, index}]` 清单，`subgraph` 为 `Graph` 实例时经
  `to_dict()` 归一为数据形态）；可选 `condition` 条件门名。
- 计划快照 `{steps, index}`：`Plan.fromDict` 校验 `steps` 清单存在与
  游标越界（0..步数）；`Plan.parse` 接受裸步骤列表或 `{steps: [...]}`
  信封，游标缺省 0。
- 与 `__spawn__` 的关系（模块 docstring 历史措辞）：计划 = 流的结构（下一跳
  编排），spawn = 流的展开（并行子图实例），计划步骤可携带 spawn 清单；
  spawn/实例展开执行段已随 P8+S1 退役，spawn 步骤项仅保留为数据形态。

## Seam 与 IO 边界

纯函数，无 IO 声明。解析注入面均由调用方传入：`graph`（图约束）、
`edge_registry`（条件注册表 seam，`EdgeConditionRegistryLike`）、
`workflow`（工作流约束域 `WorkflowSpec`）；校验失败统一抛 `model/errors`
`GraphDefinitionError`。

## 装配与消费

`Plan.parse` 校验序（源码事实）：空清单/步数超限（`max_steps`，0 = 不
校验）→ 逐步 `PlanStep.fromDict` → 节点名域校验（有 `workflow`：须落在
workflow 节点集且在当前图；无：须在当前图）→ `condition` 非 null 须已
注册（`edge_registry` 缺失即拒）→ spawn 项校验（`subgraph` 必填、
`state` 须 dict、`index` 须可数值化）→ `nodes` 多节点步展开、`spawns`
子图归一 → `policy` 校验（`'strict'` 走相邻步边关联
`validateStrictOrder`，未知策略拒绝，`'loose'` 缺省）。

消费方：`core/harness/registry.ts`（`Plan.parse` 解析 `definition.default_plan`）、
`evolve/legacy/self_proposal/proposal_validator.ts`（提案计划校验）。
`graph/executor` 的计划推进/并行组/`PLAN_KEY` 出栈/`_node_in_plan_steps`
全部消费已随 P8+S1 展开段退役删除；`RunOptions` 的 `max_plan_steps`/
`plan_policy`/`plan_workflow` 选项字段同步移除，`DEFAULT_MAX_PLAN_STEPS`
仅在本模块作 `Plan.parse` `max_steps` 缺省真源。hosts 无直接 import。

## 不变式与门禁

- 纯数据不变式：节点/条件以注册名引用，`Graph` 入计划前序列化为数据
  （「函数不是数据」）；`PlanStep`/`Plan` 构造即 `Object.freeze`
  （含内部数组）。
- 计划版本化：计划随 checkpoint 快照落盘，回溯决策点时计划与状态一起
  回到当时版本（模块 docstring 硬性要求）。
- core 纪律：禁 `node:*` 与第三方 import、禁反向依赖 `adapters/`、禁
  宿主词（架构门禁随 vitest 强制）。

## 测试

镜像测试（`test/model/plan/`）：`plan.test.ts`（构造/类型/不可变/往返
序列化/`fromDict` 校验/常量值，含 `DEFAULT_MAX_PLAN_STEPS = 32`）、
`plan_parse.test.ts`（基础校验/未知节点/条件未注册/顺序组展开/严格序）、
`plan_workflow.test.ts`（工作流约束域/信封形态/策略/spawn 项）。执行路径侧
用例（`test/graph/executor/executor_plan.test.ts`）已随 P8+S1 展开段退役
删除。

## 疑点与不一致

1. `WorkflowEdgeSpec`/`WorkflowNodeSpec` 经值 import 引入（`plan.ts`
   import 行）但全文件无引用（grep 仅命中 import 行本身）；实际只消费
   `WorkflowSpec`。
2. 严格序校验中 spawns 步的 `stepTails`/`stepHeads` 返回空表：作为前步
   整段跳过校验，作为后步因无 heads 必判「无边关联」拒绝；三个镜像
   测试均未见覆盖该场景。
3. `plan.test.ts` 头注释称「当前 TS 执行器尚未就绪」并列出 28 项未迁移
   联跑用例；执行路径侧已随 P8+S1 展开段退役，executor 侧 `PLAN_KEY`
   联跑用例（`test/graph/executor/executor_plan.test.ts`）亦随之删除，
   该批联跑用例不会再补齐——注释与现态语义待后续小波澄清。
4. `PLAN_KEY`/`KIND_*` 为手写模块常量，`engine/schemas/` 真源 grep 无
   `__plan__` 条目；其是否属 AGENTS.md「枚举……一律经 contracts
   generated」收编范围未见显式说明。
