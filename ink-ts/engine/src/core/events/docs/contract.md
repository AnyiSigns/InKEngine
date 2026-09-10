# core/events — 事件协议与传输 seam（契约文档）

> 就近导航：本目录 `README.md` · 层权威：`docs/subsystems/engine.md` + `engine/AGENTS.md`

## 定位

事件即协议：节点经 `ctx.emit` 发射的事件流 = 前端协议的引擎原生形态（step_id/round_id 天然有序，无框架事件中间层）。事件携带 step_id/round_id/graph_path（嵌套图路径），负载为与协议同构的 dict（thinking/plan/tool/node/reply_token/review_card...）。协议演进策略：版本化结构（`PROTOCOL_VERSION` 常量）+ payload 增量演进（加字段不破坏，step_id/round_id 语义长期稳定），破坏性变更升版本，不兼容版本在传输入口拒绝（`ProtocolVersionError`）。传输接口化：引擎只负责产出事件流，消费方式由宿主注入。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `events.ts` | 信封 `EngineEvent`（协议原生形态，只读）、版本门禁、`parse_event_lenient` 回放容错、`EngineTransport`/`CollectorTransport`、Python 口径纯辅助（不导出）。 |

## 对外契约面

- 目录导出：`PROTOCOL_VERSION`、`ProtocolVersionError`、`EngineEventInit`、`EngineEvent`、`parse_event_lenient`、`EngineTransport`、`CollectorTransport`。
- 公共面：`src/index.ts` 具名导出 `CollectorTransport`/`EngineEvent`/`PROTOCOL_VERSION`/`ProtocolVersionError`/`parse_event_lenient` + 类型 `EngineEventInit`/`EngineTransport`（精选而非 `export *`）。

## 数据形态

- 信封字段：`type`、`payload`（JsonRecord，缺省 `{}`）、`step_id`（展示事件契约，系统信号 null）、`parent_step_id`（轨迹树引用：模拟分支/子任务事件指向决策点/父任务步骤，落选分支可回溯对比/换选）、`round_id`（用户消息边界）、`node`（null = 执行器自身信号）、`graph_path`（空 = 顶层图）、`seq`（执行事件日志序号，append-only 恢复/续流锚点）、`trace_id`/`thread_id`（缺省 `'-'`）、`version`（缺省 `PROTOCOL_VERSION = 2`）。
- `from_dict`：缺 `type` 抛 `Error`；版本不符抛 `ProtocolVersionError`（found/expected）；`graph_path` 需可迭代（字符串按字符展开，非法形态抛 `Error`）。
- `to_json` 三级降级：严格 JSON（对齐 `json.dumps(ensure_ascii=False)`，保留键插入序与分隔空格）→ 不可序列化叶值按 `default=str` 字符串化降级 → 仍失败落最小契约 `{type, node, error}`，保证事件传输线不击穿主流程。

## Seam 与 IO 边界

- 传输 seam：`EngineTransport.send(event): Promise<void>`——SSE/WS/队列可换实现；`CollectorTransport` 内存累积全部事件（测试/调试/回放用，send 永不失败）。
- 纯函数，无 IO 声明：Python 侧 warning 留痕属可观测性副作用，TS core 零 IO 不落；容错语义（跳过返回 null/字符串化降级）原样保留。文件头注释注明 `ProtocolVersionError` 暂居本模块，收敛至 `errors.ts`（EngineError 继承面）的落地未见。

## 装配与消费

- 生产：`kernel/executor` 节点上下文 `emit` 产出事件流。
- 持流消费/记录：`kernel/runtime`、`kernel/display`（展示聚合）、`kernel/recovery`、`kernel/multipath`、`kernel/growth`、`kernel/entity_evolution`、`kernel/self_application/guarded_storage`、`core/run_result`。
- 持久化/回放：`adapters/storage`（EngineEvent 落执行日志，sqlite 以 `parse_event_lenient` 逐条恢复）；`core/storage/storage_constants.ts` 引 `PROTOCOL_VERSION`。
- 宿主：`hosts/cli`（run/events_hub/engine_attach）与 `hosts/lib`（transport/host/bridge 等）经公共面接 `EngineEvent`/`EngineTransport`。
- 错误语义：协议版本不符在 `from_dict` 传输入口拒绝（不静默解析错位结构）；`parse_event_lenient` 逐条容错——旧版本/结构损坏单条跳过返回 null，不中断整段重放。

## 不变式与门禁

- 增量演进：加字段兼容旧消费者（旧事件缺 `parent_step_id` 等字段反序列化兼容）；破坏性变更必须升版本。
- core 纯函数纪律：零框架/零 `node:*`/零宿主词/JSON 进 JSON 出；循环引用两条序列化路径都拒绝（镜像 Python）。
- 架构门禁（`vitest run --root engine` 随跑）：core 目录 import 白名单与宿主词扫描。

## 测试

`test/core/events/events.test.ts` 镜像一件：序列化往返（全部字段含 `parent_step_id`）、默认 parent_step_id 与旧事件增量兼容、协议版本不符拒绝、JSON 线格式中文原样可读、收集器传输原样保留、to_json 不可序列化负载字符串化降级、`parse_event_lenient` 逐条容错。

## 疑点与不一致

- 文件头注释自述 `ProtocolVersionError`「暂居本模块——收敛至 errors.ts（EngineError 继承面）待办」：现状仍在本模块、直接继承 `Error`，未接入 `EngineError` 族（grep 核对 `core/errors.ts` 无该类），收敛动作未见落地。
- `EngineEvent.from_dict` 字段级校验强度不一致：`type`（存在性）、`graph_path`（可迭代性）、`trace_id`/`thread_id`（typeof 判别）有判别；`step_id`/`parent_step_id`/`round_id`/`node`/`seq` 仅 `?? null` 后直接 `as` 断言；`payload` 仅按 Python 真值（`isTruthy`）判别后 `as JsonRecord`——真值非 dict 的 payload（如非零数字、非空串）会原样进入内存形态，类型标注 `JsonRecord` 与运行时校验强度不符。
- 防御性拷贝不一致：`EngineEvent` 构造器与 `to_dict` 对 `payload` 均按引用直传（`graph_path` 有拷贝），外部改动会穿透事件实例——与 `state_machine` `StateTransition.meta` 的构造/读取双拷贝纪律不一致。
- `to_json` 降级路径按 `default=str` 口径将 `undefined` 渲染为字面量字符串 `"None"`（`pyStr`），TS 消费方收到 Python 风格字面量；注释自述镜像 Python，TS 侧对 `"None"` 的处理约定未见显式说明。
- 降级最小契约与协议门禁的往返关系未见显式说明：`to_json` 二级降级落盘的最小契约 `{type, node, error}` 不含 `version` 字段，该形态再经 `from_dict` 会因缺省补齐 `PROTOCOL_VERSION` 而通过版本门禁（门禁只拦显式异版本）。
