# executor.py 拆分方案与风险分析（#8）

> **历史决策文档（已归档）**：本文件是当时（拆分决策时点）的决策记录，
> 记录当时的现状与取舍理由；`executor.py` 此后继续增长，行号/测试数等
> 数据为当时快照，不代表当前结构。当前结构以代码为准。

## 结论

**仅做低风险子拆分**：结果契约/执行选项（`RunOptions` / `RunResult`）
独立为 `core/run_result.py`；**不做强拆**（图执行/节点上下文/计划/
展开/推演分模块）。

## 现状

`core/executor.py`（拆分前 2418 行）结构：

| 段 | 行域 | 内容 |
|---|---|---|
| RunOptions / RunResult | 93-173 | 执行选项 + 结果契约（纯数据） |
| _QueueTransport / _PlanAdvance / _PlanWorkOutcome | 176-223 | 内部辅助（队列传输 / 计划推进数据） |
| _NodeContextImpl | 225-410 | 节点上下文实现（与 Engine 双向引用） |
| 图推进辅助 | 412-471 | _select_next_node / _locate_next / 计划快照判定 |
| Engine | 472-2294 | 执行中枢（约 1820 行，含 _execute 630 行单方法） |
| run_subgraph | 2297-2415 | 嵌套图包装执行 |

## 已执行：低风险子拆分（RunOptions/RunResult → run_result.py）

- 纯数据契约，无执行语义；被 runtime.py（顶层 import）与测试（15+ 处
  `from ink_engine.core.executor import RunOptions`）消费。
- executor.py 顶部 re-export（`from .run_result import ...` + `__all__`
  不变）——外部 import 零改动，纯机械移动不改行为。
- 依赖面核查：run_result.py 只依赖 plan/simulation/storage/state/budget/
  events/registry/assembly/tuning/interrupt 契约模块，均不反向 import
  executor（executor 的外部 import 面仅 runtime.py 顶层 + graph.py 函数
  内延迟 import）——无循环 import 风险。
- 顺带清理 executor.py 移走后残留的 6 个仅 import 符号（ruff F401）。
- 回归：引擎全量 1213 passed（原数 1207 + 本次改动新增测试 6 项），ruff 零错。

## 不做强拆的理由（风险分析）

1. **`_execute` 单方法内联耦合**：630 行单方法顺序承载 17 个职责段
   （恢复/预算/调配/执行/展开/checkpoint/计划推进/下一步定位），各段
   共享同一方法作用域的局部变量（ctx/state/current/step 等）与顺序
   语义——拆出 = 每个子函数需回传 10+ 局部状态，机械搬移会改变
   checkpoint 时序与恢复语义，行为风险高、收益仅文件变小。
2. **Engine 内部私有状态横向耦合**：_plan_cursor / _event_counter /
   _latest_event_seq / _chain_advanced / _coordinator / _subgraph_engines
   等 20+ 私有字段被计划/展开/推演/恢复方法组交叉读写——拆为 mixin
   类只是把 self 引用换成另一个 self，模块边界不真实，反而引入类
   定义顺序与 import 环风险（test_plan.py 已直接引用模块级私有函数
   `_plan_snapshot_is_work_step`，说明测试与内部形态已绑定）。
3. **_NodeContextImpl 与 Engine 双向强引用**：上下文持有引擎引用
   （spawn/中断/传输链），run_subgraph 依赖 `parent._engine`——拆出
   必须引入回调/接口层，属于重构而非纯机械移动。
4. 任务约束「纯机械移动不改行为」：上述拆分均不满足「纯机械」前提，
   强拆需测试行为等价论证成本高于收益。

## 后续候选（如未来需继续减负）

- _NodeContextImpl 拆出为 `core/node_context.py`（待 NodeContext 协议
  稳定后，需要把 Engine 依赖收窄为接口）；
- _execute 大方法按段提炼私有方法（段间共享局部变量先收敛为显式
  参数，属行为等价重构，可分批做）。
