# core/fanout — fan_out 并行原语（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

并行容错在引擎层统一：并发执行任务组、部分失败剔除（普通失败剔除、成功
保留）、控制流异常传播（propagate 命中 = 取消全部未完成兄弟任务后上抛——
防父流程已收尾、兄弟任务仍滞留后台写链/写事件的泄漏与存储竞态）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `fanout.ts` | `fan_out<T>(tasks, limit, options)` 单函数原语 + `FanOutResult`/`FanOutFailure`/`FanOutTask`/`FanOutOptions`/`ErrorClass` 形态 |

## 对外契约面

- `fan_out(tasks, limit, {propagate?}) → Promise<FanOutResult<T>>`：
  - 有界并发池（同时至多 limit 项在途，完成一项启动下一项，与 Python
    Semaphore FIFO 让位次序一致）；
  - `limit <= 0` 抛 RangeError（镜像 Python ValueError 移植口径）；空任务
    列表直接成功返回；
  - successes 保持输入下标顺序、success_indices 对齐原始下标、failures 按
    index 升序含剔除原因；
  - `all_succeeded` 便捷判定。
- **公共面零导出**（src/index.ts grep 核对）——引擎内部原语。

## 数据形态

- 哨兵 `UNSET`（Symbol）区分「未成功（剔除/未跑）」与合法返回
  null/undefined——成功值一律保留，直接按空值过滤会静默吞掉 None 结果。
- `FanOutTask<T> = (index, signal: AbortSignal) => Promise<T>`：任务序号 =
  任务列表位置注入；signal 为共享 AbortController 的协作退出面。

## Seam 与 IO 边界

零依赖纯原语（无 import）；取消语义边界：JS 无 BaseException/运行时注入
CancelledError——剔除边界以 propagate 名单为准（名单外一律普通失败剔除，
等价 Python `except Exception` 消化面）；不监听 signal 的任务无法被强行
中断，其迟滞完成/失败一律丢弃不记录；logger.warning 留痕属可观测性副作用，
TS core 零 IO 不落。

## 装配与消费

- `kernel/executor/_engine_spawn.ts`（spawn 实例并行，成功按 index 升序
  回流）与 `_engine_simulate.ts`（推演分支并行，失败索引换算真实分支序号）；
- `kernel/multipath/_runner_base.ts`（支流并行；支流内中断经 propagate
  提升为父图挂起卡；嵌套多径深度护栏在 fan_out 整体包裹期间 +1/复位）。

## 不变式与门禁

- 传播即中止调度：abort 共享信号 → 丢弃其余在途/未启动兄弟的结果 → 原样
  上抛（已剔除结果不回填）。
- 已知边界（自述）：中断收口场景在途兄弟事件可能落后于终态 checkpoint，
  resume 重放集为超集是合法语义（消费方幂等；与 kernel/recovery 边界
  呼应）。

## 疑点与不一致

1. **头注移植叙述**：fanout.ts 头注含「fanout.py 移植」「类比 asyncio」
   等对账叙述与「Python 侧实际行为为准」的表述——移植期口径保留于注释，
   未见收敛（同 events 的 Python 口径辅助函数先例）。
2. **`FanOutResult` 字段可变**：successes/failures/success_indices 为公开
   可变字段（buildResult 原位赋值），与目录内「结果形态」不可变惯例
   （如 ResumeResolution frozen）不一致，调用方误改无守卫。
3. **propagate 名单的 `instanceof` 判定**：以 `err instanceof cls` 比对，
   跨包/转译场景下类身份失配时传播会静默退化为剔除（未见运行时告警）。
4. **errorText 非 Error 值**：throw 非 Error 值（字符串/对象）按
   String(err) 留痕，propagate 名单对其不生效（isPropagateError 先判
   instanceof Error）——名单语义对非 Error 抛出值失效，代码未说明。

## 测试

`test/core/fanout/fanout.test.ts`（全部成功/部分失败剔除/空列表与参数边界/
并发护栏/propagate 传播与兄弟取消）。
