# budget（kernel/budget）

执行预算检查的注册表 + fail-closed 终止式检查 + 只读预检：预算维度 = 可插
拔策略（业务/宿主注册），引擎在节点边界调用 `check`，超限抛
`BudgetExceededError` 终止本轮并记录终止原因 budget_exceeded。

## 文件
- `budget_types.ts` — `BudgetPolicy`（终止式硬检查 `check`）、`BudgetQuery`（可选第二协议：余量只读 `remaining`）、`BudgetRemaining`（单维度余量只读结果：policy/limit/used/remaining/unavailable）。
- `budget.ts` — `BudgetExceededError`（kind/limit/current/detail）、`BudgetManager`（策略注册表 + `check` 终止式 + `query_remaining` 只读预检）、`can_afford`（fail-closed 预检：够付才放行）。
- `contract.ts` — 机制契约：id `budget`、effects 空（纯内存注册表，策略经注入注册）、depends 空。

## 依赖
- 上游（本目录实际 import）：`budget_types.js`（同目录数据面）、`kernel/registry/contract_types`。
- 下游（实际 import 本目录）：`src/index.ts` 公共面（「恢复/中断/预算」组具名 6 名）；`kernel/executor`（`_engine_parallel` 捕获 `BudgetExceededError`）、`kernel/multipath`（BudgetManager/BudgetRemaining 类型）、`core/run_result`（`RunOptions.budget` 类型引用）、`kernel/registry/contracts`；`kernel/path_assembler/canary` 试跑消费已随组装链路退役删除（W7-B）；公共面无 hosts 直接 import（budget_remaining 经事件/日志数据面读取）；测试 `test/kernel/budget`。
