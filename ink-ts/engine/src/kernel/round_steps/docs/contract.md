# kernel/round_steps — 回合步骤序列累积器（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

纯内存、零 IO、零副作用的回合步骤累积原语（round_steps.py 移植）：回合/步骤/回合步骤序列是历史回放的单一事实来源，实时事件发射顺序 = 录制顺序 = 回放顺序。宿主把序列写入 checkpoint 通道（中断回合续流）并在回合完成时快照落库——落库与传输是宿主职责。`step_id` 回合内稳定唯一（前端渲染 key 与 SSE 配对更新依赖）。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `round_steps.ts` | `RoundSteps` 主类：`round_id` + 种子构造（`buildState` 恢复），读取访问器与 user/reply/thinking/plan/assembly/memoryHit/tool/node/reviewCard/suggestions/error 方法族（经 ctx 工厂委托子机制） |
| `round_steps_types.ts` | 协议常量与类型（见数据形态） |
| `round_steps_internals.ts` | `buildState`/`restoreCounts`/`buildRoundStepsState` 状态闭包（`append` 同 id 合并 payload、`clampStepId` 截断、`toolPending` 就地置 pending）+ `buildCardCtx` 等六个 ctx 工厂 |
| `round_steps_cards.ts` | thinking/plan 流式卡；`endStreamingCard`：内容非空置 completed、空卡 `popLast` 丢弃并返回原 step_id 供前端移除 |
| `round_steps_reply.ts` | `replyToken`（无打开段新建 `reply:<n>`）/`setFinalReply`（多段前缀替换末段、单段整段定型、已切段另起新段） |
| `round_steps_tools.ts` | `toolStart`/`toolEnd`：同 `tool_call_id` 复用并复位 running（审批 resume 不重复卡）；无 id 回退 `tool:<n>` 计数、收尾只认末步 |
| `round_steps_nodes.ts` | `node_step_id`（序号分卡 `node:<id>:<n>`，与 append 同口径截断）/`nodeProgressFrom`/`nodeStart`（同 id 复用保留首次标签）/`nodeStream`/`nodeEnd`/`nodeFail` |
| `round_steps_assembly.ts` | `assemblyStart`/`assemblyEnd`：固定 `assembly` 单步折叠，耗时收尾定型、墙钟回拨不写负耗时、缺 start 幂等空操作 |
| `round_steps_misc.ts` | `user` 幂等、`memoryHit`（按 `MEMORY_ATTACH_KINDS` 挂最近卡、同 id 幂等）、`reviewCard`（连带工具卡置 pending）、`suggestions`、`error` |
| `contract.ts` | 机制契约 `round_steps_contract`（见对外契约面） |
| `index.ts` | 目录汇出口：`RoundSteps` + 5 常量 + 3 类型 |

## 对外契约面

- 目录汇出口 `index.ts`：`RoundSteps`；常量 `COUNTED_KINDS`/`MEMORY_ATTACH_KINDS`/`REPLY_COUNT_KEY`/`REPLY_JOIN_SEPARATOR`/`STEP_ID_MAX_CHARS`；类型 `NodeExtra`/`NodeProgress`/`StepRecord`。
- 公共面（`src/index.ts:247`）逐名核对：**仅** `export type { StepRecord } from './kernel/round_steps/index.js'`——`RoundSteps` 主类、5 个常量、`NodeExtra`/`NodeProgress` 均不在 `@ink-ts/engine` 公共面。
- 机制端口契约：`round_steps_contract = { id: 'round_steps', contract: { effects: [] }, depends: [] }`——纯内存步骤累积数据面；经 `kernel/registry/contracts.ts:72` 收入 `ALL_MECHANISM_CONTRACTS`（34 项全量清单）。

## 数据形态

- `StepRecord = { step_id, type, payload: JsonRecord }`；`NodeProgress = { step: 'write', n, total }`；`NodeExtra = { chapter_index?, chapter_total? }`。
- step_id 规则：按类计数 `think:<n>`/`plan:<n>`/`card:<n>`/`memory:<n>`/`suggestions:<n>`/`error:<n>`；`tool:<tool_call_id>`（无 id 回退计数）；`node:<node_id>[:<序号>]`；`reply:<n>`（`REPLY_COUNT_KEY='reply'`，工具/审批/节点卡出现即切段）；`user` 固定单条；`assembly` 固定单步。
- 常量：`STEP_ID_MAX_CHARS = 200`（追加时统一截断）；`REPLY_JOIN_SEPARATOR = '\n\n'`（`setFinalReply` 剥离前缀连带剥离）；`COUNTED_KINDS = {thinking, plan, review_card, memory_hit, suggestions, error}`；`MEMORY_ATTACH_KINDS = ['plan', 'thinking']`。
- 主类可变状态经 `RoundStepsState` 闭包承载：`steps`/`index`（step_id→record）/`counts`（按类计数）/`replyOpen`。

## Seam 与 IO 边界

纯函数目录，无 IO 声明：`effects: []`，不读写任何存储 seam、不调用模型、不经 exec 信封、不消费回合端口；快照落库/传输由宿主承接。节点展示标签由宿主经 `node_labels` 注入（引擎不内置业务节点名/界面文案）。

## 装配与消费

- 契约装配：`kernel/registry/contracts.ts` 收入全量机制契约清单；`kernel/runtime/contract.ts` 注明 round_steps 仅 type import、不构成 runtime 装配期 value 依赖。
- 值面消费：src 内 `RoundSteps` 主类无值面消费方（公共面导出供外部，`test/kernel/round_steps/` 两测试直用）；`StepRecord` 类型被 `kernel/runtime/runtime.ts`（`round_steps(thread)` 返回 `StepRecord[]`）与 `_round_steps_recorder.ts` 引用——后者是 runtime 侧轻量内存记录器（`EngineTransport`，复用 StepRecord 公开形态、逐事件原样投影，与 RoundSteps 主类是两条记录路径）。
- 错误语义：种子含非 dict 脏数据跳过不崩溃；`from` 缺 start/无匹配返回 `''` 或空串；截断后唯一性由前缀 + 计数/调用 id 保证。

## 不变式与门禁

- 机制三键：依赖单向 DAG——`depends: []`，不依赖任何机制件；runtime depends 闭包——自足叶子（runtime 注明仅 type import 不入 depends）；零自持 IO——effects=[]，纯内存成立。
- gate 规则：11 文件仅相对 import 与 `core/json`，无 `node:*`/第三方/宿主词命中。
- 目录形态差异：`engine/AGENTS.md` 所述「contract.ts + impl.ts + *.test.ts」——无 impl.ts（实现拆分在 round_steps*.ts 八文件）、无同目录测试（见疑点 7）。

## 测试

`test/kernel/round_steps/` 镜像测试两文件：

- `round_steps_basic.test.ts` — user 幂等；reply_token 段切分与 setFinalReply 五情形（切段/单段/前缀/一致/空回复）；thinking/plan 流式与空卡丢弃；工具卡 start/end 流转（同 id 复用、隔卡重发、无 id 回退计数、无匹配收尾）。
- `round_steps_extra.test.ts` — 节点卡 start/stream/end/fail（标签保留/覆盖/回退、分卡进度、tokens=None）；审批卡连带 pending；记忆命中（挂卡/幂等/独立步骤）；建议与错误计数；种子恢复连续性与脏数据；step_id 截断同口径；空累积器访问器；事件顺序保留；组装折叠（复用/缺 start/墙钟回拨）；round_id 归一。
- 关联（非本目录镜像）：`test/kernel/runtime/runtime_round_steps_recorder.test.ts` 测 runtime 侧记录器。

## 疑点与不一致

1. `src/index.ts:245` 注释「RoundSteps 主类仍为 executor 侧消费」与代码不符：`kernel/executor/` 目录经 grep 无任何 round_steps/RoundSteps 引用；src 内 `RoundSteps` 无值面消费方（仅公共面导出与测试直用）。
2. `nodeStart` 与 `nodeProgressFrom` 对 `chapter_index`/`chapter_total` 的解析口径不一致：前者仅认 number（非 number 归 0 → 不分卡），后者对可 `Number()` 化的非零值（含数字字符串）也产出进度——同一 extra 字符串形态下「不分卡但内嵌进度」。
3. `restoreCounts` 对 `COUNTED_KINDS` 按「条数」恢复计数，仅 tool 按「step_id 后缀最大值」恢复；头注说明后者取最大值的理由（混存形态不撞号），但前者在种子步骤数小于已发序号（如种子被裁剪）时是否撞号未见显式说明。
4. `round_steps_tools.ts` 头注「`tool_pending` 在主类内联实现以避免与 tools.ts 循环依赖」：实际实现在 `round_steps_internals.ts` 的 state 闭包 `toolPending` + 主类 `RoundSteps.toolPending` 转发，tools.ts 内无该函数；「主类内联」的说法与实际落位有出入。
5. `round_steps.ts` 的 `toolStart`/`toolEnd` 手工内联构造 `ToolCtx` 字面量，未使用 internals 已有的 `buildToolCtx` 工厂（其余子机制方法均走工厂）；两者字段清单一致。
6. 目录 `index.ts` 头注「只暴露 RoundSteps 主类与协议常量」——实际还导出类型 `NodeExtra`/`NodeProgress`/`StepRecord`。
7. `engine/AGENTS.md` 描述机制件目录形态「contract.ts + impl.ts + *.test.ts」，本目录为 contract.ts + index.ts + round_steps*.ts 九文件，无 impl.ts、无同目录测试（测试在 `test/kernel/round_steps/`）。
