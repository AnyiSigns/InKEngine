# events（core/events）

事件协议机制：`EngineEvent` 信封 + 协议版本化（`PROTOCOL_VERSION`）+ 传输接口 `EngineTransport`——事件即协议，前端协议的引擎原生形态。

## 文件
- `events.ts` — 事件信封 `EngineEvent`（构造/`to_dict`/`from_dict`/`to_json` 三级降级）、协议版本常量与错误 `PROTOCOL_VERSION`/`ProtocolVersionError`、逐条容错解析 `parse_event_lenient`、传输接口 `EngineTransport` 与内存收集实现 `CollectorTransport`、Python 口径 JSON 渲染纯辅助（`isTruthy`/`pyInt`/`pyStr`/`pythonDumps`，不导出）。

## 依赖
- 上游（本目录实际 import）：`core/json.ts`（`isRecord`、`JsonRecord`）。
- 下游（实际 import 本目录）：`src/index.ts`（公共面具名导出）、`kernel/executor`（emit 生产）、`kernel/runtime`、`kernel/display`、`kernel/growth`、`kernel/recovery`、`kernel/entity_evolution`、`kernel/multipath`、`kernel/self_application`、`core/storage`（`storage_constants.ts` 引 `PROTOCOL_VERSION`）、`core/run_result`、`adapters/storage`（事件落执行日志与 `parse_event_lenient` 回放）；hosts（cli/lib）经公共面以 `EngineEvent`/`EngineTransport` 接入，`hosts/web` 与 renderer 不静态 import。
