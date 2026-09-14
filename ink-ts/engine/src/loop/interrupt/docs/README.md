# interrupt/（loop/interrupt — 挂起/注入重入原语）

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
- 上游：`model/errors`（InterruptError）、`model/json`（isRecord）。
- 下游：`graph/executor`（InterruptCoordinator 持有于 _engine_base、
  InterruptSignal 捕获于 _engine_execute_helpers、InterruptState 进
  _internals/_node_context/run_subgraph、interrupt_key_matches 于
  _node_context——原 loop/plan/spawn/simulate/parallel/multipath 捕获面与
  `kernel/multipath/_runner_base` 消费已随 P8+S1 展开段退役删除）、
  `model/storage`（`interrupt_state.ts`/`storage_records.ts`：InterruptState 进
  CheckpointRecord）、`core/run_result`（type）、
  `plugins/ports/storage/sqlite_checkpoints（S2 端口提供方）`（InterruptState 还原）、
  `dock/registry/contracts.ts`；公共面经 `dock/index.ts` `export * from
  '../loop/interrupt/interrupt.js'` 收口（`src/index.ts` 只转发 dock）。
