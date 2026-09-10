# interrupt/（kernel/interrupt — 挂起/注入重入原语）

弹卡审批的一等控制流：节点内 `ctx.interrupt(key, payload)` 声明中断点，
引擎捕获 `InterruptSignal` 持久化 checkpoint 后本轮挂起；外部注入决议后从
该节点重入，同一调用返回注入值。本目录只承载纯逻辑（键运算 + 注入协调
状态机）与数据形态；checkpoint 持久化/恢复由引擎接线，本模块不感知存储。

## 文件
- `interrupt.ts` — `interrupt_base_key`（剥离 `#N` 指纹后缀）、
  `interrupt_key_matches`（宽容命中：相等或 gate 基底 `base#N` 前缀）、
  `InterruptCoordinator`（注入挂载/一次性消费/重入判定 + gate 发卡键
  (thread, base) 单调计数与回合复位）；再导出数据面。
- `interrupt_types.ts` — `GATE_KEY_PREFIX`/`FINGERPRINT_SEP` 键常量、
  `InterruptSignal`（控制流信号，Error 子类承载）、`InterruptState`
  （frozen，随 checkpoint 持久化的重入锚点）。
- `contract.ts` — 机制契约：effects=[]、depends=[]（原语提供方，零端口）。

## 依赖
- 上游：`core/errors`（InterruptError）、`core/json`（isRecord）。
- 下游：`kernel/executor`（13 处：InterruptCoordinator 持有于 _engine_base、
  InterruptSignal 捕获于 loop/plan/spawn/simulate/parallel/multipath、
  InterruptState 进 checkpoint/_loop_types/_internals/_node_context、
  interrupt_key_matches 于 _node_context）、`core/storage/storage_records`
  （InterruptState 进 CheckpointRecord）、`core/run_result`（type）、
  `kernel/multipath/_runner_base`、`adapters/storage/sqlite_checkpoints`
  （InterruptState 还原）、`kernel/registry/contracts.ts`；公共面
  `export * from './kernel/interrupt/interrupt.js'`。
