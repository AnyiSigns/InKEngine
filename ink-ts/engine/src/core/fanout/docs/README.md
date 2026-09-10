# fanout/（core/fanout — fan_out 并行原语）

并发执行一组任务的引擎统一原语（替代裸 Promise.all）：有界并发池调度 +
部分失败剔除（成功保序回流、失败留痕剔除）+ 控制流异常传播（propagate
名单命中即取消全部未完成兄弟任务后上抛）。kernel/executor 的 spawn/
simulate 与 kernel/multipath 支流执行均经此收敛并行容错语义。

## 文件
- `fanout.ts` — `fan_out(tasks, limit, {propagate?})`：哨兵区分「未成功」
  与合法 null/undefined 成功值；`FanOutResult`（successes/success_indices/
  failures/all_succeeded）、`FanOutFailure`、`FanOutTask`（第二参注入共享
  AbortSignal 供协作退出）、`ErrorClass` 传播名单。

## 依赖
- 上游：无 import（零依赖纯原语，仅用全局 AbortController/Symbol）。
- 下游：`kernel/executor/_engine_spawn.ts`、`kernel/executor/_engine_simulate.ts`
  （spawn 实例与推演分支并行）、`kernel/multipath/_runner_base.ts`（支流
  并行 + 中断提升为父图挂起卡）；公共面零导出；`test/core/fanout/fanout.test.ts`。
