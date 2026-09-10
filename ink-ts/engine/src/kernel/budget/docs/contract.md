# kernel/budget — 执行预算（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

执行预算检查钩子（`budget.py` 移植）：引擎定义预算检查点（节点完成/边选择
前调用已注册策略），策略由业务/宿主注册（步骤上限/轮数上限/字符预算等，
全局/书籍级）。策略抛 `BudgetExceededError` → 引擎终止本轮并记录终止原因
budget_exceeded（入轨迹与审计）。附余量只读预检（`query_remaining` +
`can_afford`，评审决议下沉的预检语义）。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `budget_types.ts` | `BudgetPolicy`（`check(ctx)` 终止式硬检查，超限抛 `BudgetExceededError`）；`BudgetQuery`（可选第二协议：`remaining(ctx) → BudgetRemaining \| null`，不抛异常）；`BudgetRemaining`（policy=维度名 / limit=上限（0 = 不可用维度）/ used / remaining=limit-used / unavailable=查询故障或无余量概念——fail-closed 余量视为 0） |
| `budget.ts` | `BudgetExceededError`（kind/limit/current/detail；消息 `执行预算超限[kind]: current >= limit`，detail 并入原始异常）；`BudgetManager`（`policies` 注册表 + `register` + `check` 顺序执行全部策略——策略自身异常包装为 `kind=policy_error:<运行时类型名>`、limit/current=0、`Error.cause` 保留原异常（镜像 raise from）；`query_remaining` 只对实现 `remaining` 的策略取值，查询故障 → unavailable=true 维度）；`can_afford(results, cost)`：无维度 → 放行 / 任一 unavailable → 拒绝 / `cost ≤ min(remaining)` → 放行 |
| `contract.ts` | `budget_contract: MechanismContract`：id `'budget'`、effects `[]`（纯内存策略注册表，不自持 IO——维度读取与计数在策略实现与引擎检查点接线侧）、depends `[]` |

## 对外契约面

公共面「恢复/中断/预算」组（`src/index.ts` 具名导出，逐名核对 6 名）：
`BudgetExceededError` `BudgetManager` `BudgetRemaining` `can_afford` +
类型 `BudgetPolicy` `BudgetQuery`——均从 `./kernel/budget/budget.js` 直取
（`BudgetRemaining` 真源 `budget_types.ts` 经 `budget.ts` 转出；目录无
barrel）。机制契约 `budget_contract` 经 `kernel/registry/contracts.ts` 入
全量注册表（34 机制）。

## 数据形态

- 策略双协议：`BudgetPolicy.check`（终止式，必实现）+ `BudgetQuery.remaining`
  （只读预检，可选——`query_remaining` 以鸭子探测 `(policy as
  Partial<BudgetQuery>).remaining` 识别）。
- `BudgetRemaining`：readonly 五字段；`limit=0` 语义 = 不可用维度；
  `unavailable=true` = 查询故障/维度无余量概念。
- `BudgetExceededError`：`kind` 区分「预算超限」与「策略执行故障」
  （`policy_error:<TypeName>`），detail 携带原始异常消息，异常链经
  `Error.cause` 保留。

## Seam 与 IO 边界

机制契约 effects 空、depends 空：纯内存策略注册表；判定输入 `ctx` 为调用
方透传的运行态形状，本机制不消费存储/模型/执行/回合端口，也不自持 IO；
无时间/随机 seam。预算的真实计数与读取在策略实现（宿主/业务侧）与引擎
检查点接线（executor）侧。

## 装配与消费

- 引擎检查点：`kernel/executor/_engine_parallel` 捕获 `BudgetExceededError`
  收口并行成员终止（`TerminateReason.BUDGET_EXCEEDED` 语义族）；`RunOptions.
  budget: BudgetManager | null`（`core/run_result`）为注入口（null = 不检查）。
- 策略装配示例：`kernel/path_assembler/canary` 每次试跑 `new BudgetManager()`
  并注册 `BudgetPolicy` 实现；`kernel/multipath` 以 `BudgetManager`/
  `BudgetRemaining` 类型接线支流预算。
- hosts：公共面无直接 import（`budget_remaining` 等经事件/日志数据面读取，
  `bridge/pool.ts` 从日志行取值）。
- 机制契约经 `kernel/registry/contracts.ts` 汇总；`runtime_contract` depends
  含 budget。

## 不变式与门禁

- `check` fail-closed：任一策略抛错（含策略自身故障）即终止——策略异常
  包装为 `BudgetExceededError`（kind=policy_error:*，cause 保留原异常），
  不拖垮主流程也不静默放行。
- 预检 fail-closed：`query_remaining` 不抛异常（预检不得影响执行）；查询
  故障维度 → unavailable=true；`can_afford` 对不可用维度拒绝放行（无法
  确认余量 = 不得放行）。
- 注册 = 插拔：新增预算维度 = 注册新策略，引擎核心零改动。

## 测试

镜像测试 `test/kernel/budget/budget.test.ts`（2 组）：执行预算机制（策略
注册/节点边界检查/异常包装 fail-closed）、预算余量只读查询（预检
fail-closed）。

## 疑点与不一致

1. 模块头注释自述「BudgetExceededError 暂居本模块——收敛至 errors.ts
   （EngineError 继承面）待办」：该类当前直接 `extends Error`（非
   EngineError 族）、仍居本模块并上公共面，注释所述收敛未落地（源注释
   自认的未完成项）。
2. `query_remaining` 故障维度的 `policy` 名取 `runtimeTypeName(policy)`
   （策略对象构造器类名或 'object'），非注册维度名——同一策略类多实例时
   审计可读性口径未见显式说明。
3. `can_afford` 的 `cost` 语义（计量单位与维度对齐方式）由调用方约定，
   机制层未见统一单位说明。
