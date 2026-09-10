# kernel/interrupt — 挂起/注入重入原语（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` +
> `engine/AGENTS.md`

## 定位

中断即一等控制流（弹卡审批的机制底座）：节点内 interrupt() 声明中断点 →
引擎捕获 InterruptSignal 持久化 checkpoint（挂起卡不丢弃，打断重定向）→
外部注入值后从该节点重入。不做「节点内任意点」中断（需保存协程剩余逻辑，
自述复杂无必要）——只有节点边界粒度。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `interrupt.ts` | `interrupt_base_key` / `interrupt_key_matches`（宽容命中）/ `InterruptCoordinator`（inject/consume/has_inject/consume_review/next_gate_key/reset_thread_gate_count）；本文件合并导出 = Python 模块公共面 |
| `interrupt_types.ts` | `GATE_KEY_PREFIX`('gate:') / `FINGERPRINT_SEP`('#') / `InterruptSignal` / `InterruptState`（to_dict/from_dict 序列化往返） |
| `contract.ts` | `interrupt_contract`：effects=[] / depends=[] |

## 对外契约面

- `InterruptCoordinator`（执行器内部持有）：`inject(values)`（覆盖式挂载，
  对齐 dict.update）、`consume(key)`（一次性弹出，无注入抛 InterruptError）、
  `consume_review(review_key)`（基底精确命中 → 指纹键插入序前缀命中，无
  注入返回 null 走新中断）、`next_gate_key(thread, base)`（首次原键，之后
  `base#N`；消费不推进——同次中断保持同键）、`reset_thread_gate_count`
  （新回合入口复位）。
- 数据形态：`InterruptSignal{key, payload}`（非错误语义的 Error 子类，
  引擎按控制流捕获）、`InterruptState{key, payload, node, graph_path}`
  （from_dict 缺省回落，isFalsy 口径）。
- 公共面：`src/index.ts:220` `export * from './kernel/interrupt/interrupt.js'`。
- 机制注册：`interrupt_contract` 入 ALL_MECHANISM_CONTRACTS。

## 数据形态（gate 发卡键指纹）

同轮同工具第二次审批若复用同键，前端按 key 去重会丢第二张卡、续跑命中旧
中断——协调器按 (thread, base) 单调发卡计数：首次保持原键（兼容既有续跑/
断言），后续掺 `#<序号>`；后缀只作卡身份（注入消费/负载读取按基底宽容
匹配），基底键仍是判定面。指纹作用域 = 回合内（新回合复位）。

## Seam 与 IO 边界

零端口、零机制依赖（effects=[]/depends=[]）：纯内存实例态状态机，无全局
状态、零 IO；持久化/恢复由 executor（checkpoint 写 InterruptState）与
adapters/storage（sqlite 行还原 InterruptState.from_dict）接线。

## 装配与消费

消费面最广的原语目录之一：executor 13 个分层文件（协调器持有于
_engine_base、信号捕获贯穿 loop_front/loop_back/plan/parallel/spawn/
simulate/multipath/run_subgraph）、core/storage/storage_records
（CheckpointRecord.interrupt 字段）、core/run_result（type 形态）、
multipath runner、adapters/storage（sqlite_checkpoints 行→InterruptState）。

## 不变式与门禁

- 注入一次性：consume 即弹出；已注入决策的审批视为放弃（防门控绕过）。
- 发卡计数只在「真正发卡」推进；同一次中断的决议注入与重入消费保持同一键。
- InterruptState 构造即冻结；graph_path 防御拷贝；payload 引用透传
  （与 Python 一致，内容可变——自述口径）。

## 疑点与不一致

1. **from_dict 错误面不统一**：非 dict 抛 `TypeError`、缺 key 抛裸
   `Error`、graph_path 非法抛裸 `Error`——未接入 EngineError 族
   （GraphDefinitionError 等），与 core 校验惯例不一致。
2. **Python 侧 `__all__` 缺陷的移植决策**：interrupt_types.ts 头注自述
   Python 源常量为私有 `_FINGERPRINT_SEP` 而 `__all__` 声明
   `FINGERPRINT_SEP`（import * 会 AttributeError），TS 按声明意图导出——
   忠实记录的移植决策，但意味着 TS 导出名在 Python 源码中无直接对应实现。
3. **InterruptSignal 继承 Error 的代价**：头注自述 Python 侧继承
   BaseException（不记日志）；TS 无该层级，以 Error 子类承载——若消费方
   以 `instanceof Error` 兜底捕获会把控制流信号当错误（executor 侧以
   精确类型捕获规避，跨宿主复用时需注意；代码未提供运行时守卫）。
4. **payload isFalsy 回落**：`from_dict` 对 falsy payload（0/''/[]/{}) 一律
   回落 `{}`——合法的 falsy 负载（如空数组负载）与缺失不可区分（对齐
   Python `dict.get(...) or 缺省` 口径，属移植保真而非缺陷，但语义上
   payload=0 与缺省同形）。
5. 目录无 impl.ts、无同目录测试（镜像在 test/kernel/interrupt/）——与
   engine/AGENTS.md 目录形态口径不符（同 registry/builder/recovery 发现）。

## 测试

`test/kernel/interrupt/interrupt.test.ts`（协调器注入/消费/发卡计数/宽容
命中/InterruptState 序列化往返）。
