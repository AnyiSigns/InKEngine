# round_steps（kernel/round_steps）

回合步骤序列累积器（RoundSteps）：纯内存、零 IO，把回合内事件发射顺序录制成 `step_id` 稳定的步骤序列（thinking/plan/工具/节点/组装/回复分段/用户/记忆命中/审批卡/建议/错误），快照落库与传输由宿主承接。

## 文件
- `round_steps.ts` — `RoundSteps` 主类：读取（`steps`/`lastStep`/`lastStepId`/`stepLabel`）+ 十类方法族，按子机制委托到各文件（经 ctx 工厂解耦）
- `round_steps_types.ts` — 协议常量与类型：`STEP_ID_MAX_CHARS`/`COUNTED_KINDS`/`REPLY_COUNT_KEY`/`REPLY_JOIN_SEPARATOR`/`MEMORY_ATTACH_KINDS`、`StepRecord`/`NodeProgress`/`NodeExtra`
- `round_steps_internals.ts` — 状态闭包原语（`buildState` 种子恢复、`restoreCounts` 计数反推、`buildRoundStepsState` 的 `append`/`update`/`popLast`/`toolPending` 等）与六个子机制 ctx 工厂
- `round_steps_cards.ts` — thinking/plan 流式卡（start/token/end + 共用收尾 `endStreamingCard`：空卡丢弃）
- `round_steps_reply.ts` — `replyToken` 分段累积 + `setFinalReply` 终态校准（前缀/切段/另起段三情形）
- `round_steps_tools.ts` — 工具卡 start/end（同 `tool_call_id` 复用、无 id 回退计数、收尾只认末步）
- `round_steps_nodes.ts` — 节点卡：`node_step_id`（带序号分卡）/`nodeProgressFrom` 进度内嵌/start/stream/end/fail
- `round_steps_assembly.ts` — 组装阶段折叠为固定单步（`assemblyStart`/`assemblyEnd` + 墙钟回拨不写负耗时）
- `round_steps_misc.ts` — `user`（幂等回合边界）/`memoryHit`（挂最近 plan/thinking 卡）/`reviewCard`/`suggestions`/`error`
- `contract.ts` — 机制契约声明 `round_steps_contract`（id=`round_steps`，effects=[]，depends=[]）
- `index.ts` — 目录汇出口：`RoundSteps` + 5 个协议常量 + 3 个类型（不进 `src/index.ts` 公共面的部分经此对仓内可达）

## 依赖
- 上游（本目录实际 import）：
  - `core/json.ts`（`Json`/`JsonRecord` 类型、`isRecord`）
  - `kernel/registry/contract_types.ts`（`MechanismContract` 类型，经 contract.ts）
  - 目录内：`round_steps_types.ts` ← 各子机制；`round_steps_internals.ts` ← 六个子机制的 ctx 类型；`round_steps.ts` ← internals + 六个子机制
- 下游（实际 import 本目录）：
  - `src/index.ts:247`（公共面仅 `export type { StepRecord }`）
  - `kernel/runtime/runtime.ts`、`kernel/runtime/_round_steps_recorder.ts`（均仅 type import `StepRecord`，不入 runtime depends）
  - `kernel/registry/contracts.ts:72`（`round_steps_contract` 入 34 项全量契约清单）
  - `test/kernel/round_steps/`（`round_steps_basic.test.ts`、`round_steps_extra.test.ts`，经 index.js 值 import `RoundSteps`）
  - hosts 侧无直接 import
